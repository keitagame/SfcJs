  // ============================================================================
// SPCファイルパーサー
// .spc フォーマット (v0.30, ヘッダ256byte + RAM 64KB + DSPレジスタ128byte + ...)
// 参考: SPC700 File Format specification
// ============================================================================

function parseSPC(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  // ヘッダチェック "SNES-SPC700 Sound File Data"
  const headerText = String.fromCharCode(...buf.slice(0, 33));
  if (!headerText.startsWith('SNES-SPC700')) {
    throw new Error('SPCファイルのヘッダが不正です（SNES-SPC700シグネチャが見つかりません）');
  }

  const hasID666 = buf[0x23] === 26 || buf[0x23] === 27; // 0x1A(26)=タグあり, 0x1B(27)=タグなし版もある実装差異に対応
  // 実際の仕様: offset 0x23 が 0x1A固定でヘッダ終端マーカー、0x24がID666タグの有無(1=あり,0=なし)
  const id666Flag = buf[0x24];

  // レジスタ情報 (offset 0x25-0x2D)
  const pc = dv.getUint16(0x25, true);
  const a = buf[0x27];
  const x = buf[0x28];
  const y = buf[0x29];
  const psw = buf[0x2a];
  const sp = buf[0x2b];

  // ID666タグ (offset 0x2E - 0xD0) 曲情報
  let songTitle = '', gameTitle = '', dumperName = '', comments = '', dateDumped = '';
  let artist = '';
  try {
   
  } catch (e) {
    // タグが壊れていても再生自体は継続する
  }

  // RAMデータ: offset 0x100 から 65536 byte
  const ramStart = 0x100;
  const ram = buf.slice(ramStart, ramStart + 0x10000);

  // DSPレジスタ: offset 0x10100 から 128 byte
  const dspStart = 0x10100;
  const dspRegs = buf.slice(dspStart, dspStart + 0x80);

  return {
    pc, a, x, y, psw, sp,
    ram,
    dspRegs,
    tags: { songTitle, gameTitle, artist, dumperName, comments },
  };
}

function readTagString(buf, offset, length) {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) end++;
  const bytes = buf.slice(offset, end);
  // Shift-JISの可能性もあるが、まずUTF-8/ASCIIとしてデコードを試みる
  try {
    return new TextDecoder('shift-jis', { fatal: false }).decode(bytes).trim();
  } catch (e) {
    return String.fromCharCode(...bytes).trim();
  }
}

if (typeof module !== 'undefined') module.exports = { parseSPC };

  // ============================================================================
// メインスレッド制御スクリプト
// ファイル選択/ドロップ -> SPCパース -> AudioWorkletへ転送 -> 再生制御
// ============================================================================

(() => {
  
 
  const fileInput = document.getElementById('spcInput');
  
function pitchToNote(pitch) {
    if (!pitch) return "-";

    // SPC700のピッチ値から周波数を概算
    const freq = 32000 * pitch / 4096;

    if (!isFinite(freq) || freq <= 0) {
        return "-";
    }

    const noteNames = [
        "C", "C#", "D", "D#", "E", "F",
        "F#", "G", "G#", "A", "A#", "B"
    ];

    const midi = Math.round(
        69 + 12 * Math.log2(freq / 440)
    );

    const octave = Math.floor(midi / 12) - 1;
    const name = noteNames[((midi % 12) + 12) % 12];

    return `${name}${octave}`;
}
// ============================================================================
// 各ボイス用リアルタイム鍵盤制御 (追加・変更部分)
// ============================================================================
const MIN_MIDI_NOTE = 24;
const MAX_MIDI_NOTE = 108;
const isBlackKey = [false, true, false, true, false, false, true, false, true, false, true, false];
// ピッチからMIDIノート番号を算出 (0x1000 = C4 / MIDI 60)
function pitchToMidi(pitch) {
  if (!pitch || pitch <= 0) return null;
  return Math.round(60 + 12 * Math.log2(pitch / 4096));
}

// 音階名テキスト変換の修正
function pitchToNote(pitch) {
  const midi = pitchToMidi(pitch);
  if (midi === null) return "-";

  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(midi / 12) - 1;
  const name = noteNames[((midi % 12) + 12) % 12];
  return `${name}${octave}`;
}

// 初期化：8ボイス分のテーブル行と鍵盤DOMをあらかじめ作成
function initVoiceKeyboards() {
  const voiceTable = document.getElementById("voiceTable");
  if (!voiceTable) return;
  voiceTable.innerHTML = "";

  for (let v = 0; v < 8; v++) {
    const tr = document.createElement("tr");
    tr.id = `voice-row-${v}`;

    // 各ボイス専用の鍵盤HTML
    let kbHtml = `<div class="mini-keyboard v-${v}">`;
    for (let note = MIN_MIDI_NOTE; note <= MAX_MIDI_NOTE; note++) {
      const isBlack = isBlackKey[note % 12];
      kbHtml += `<div class="mini-key ${isBlack ? 'black' : 'white'}" data-note="${note}"></div>`;
    }
    kbHtml += `</div>`;

    tr.innerHTML = `
      <td>${v}</td>
      <td class="v-status">-</td>
      <td class="v-vol-l">-</td>
      <td class="v-vol-r">-</td>
      <td class="v-note">-</td>
      <td class="v-pitch">-</td>
      <td>${kbHtml}</td>
    `;
    voiceTable.appendChild(tr);
  }
}

function updateVoiceInfo(voices) {
  if (!voices || !Array.isArray(voices)) return;

  // spc.js 側が 1〜8 (1始まり) で送っているか判定
  const isOneBased = voices.some(v => (v && (v.voice === 8 || v.ch === 8 || v.id === 8)));

  voices.forEach((v, index) => {
    if (!v) return;

    // ボイスIDの取得 (voice, ch, channel, id の順で検索)
    let rawIdx = v.voice ?? v.ch ?? v.channel ?? v.id ?? index;
    let vIdx = Number(rawIdx);

    // 1始まりの場合は 1 引いて 0〜7 に揃える
    if (isOneBased && vIdx >= 1) {
      vIdx -= 1;
    }

    const row = document.getElementById(`voice-row-${vIdx}`);
    if (!row) return;

    // 値の反映
    const active = !!v.active;
    const volL = v.volumeL ?? v.volL ?? v.vol_l ?? "-";
    const volR = v.volumeR ?? v.volR ?? v.vol_r ?? "-";
    const pitch = typeof v.pitch === "number" ? v.pitch : 0;

    row.querySelector(".v-status").textContent = active ? "ON" : "OFF";
    row.querySelector(".v-vol-l").textContent = volL;
    row.querySelector(".v-vol-r").textContent = volR;
    row.querySelector(".v-note").textContent = active ? pitchToNote(pitch) : "-";
    row.querySelector(".v-pitch").textContent = "0x" + pitch.toString(16).padStart(4, "0").toUpperCase();

    // 鍵盤UIの更新
    const kb = row.querySelector(".mini-keyboard");
    if (kb) {
      kb.querySelectorAll(".mini-key.active").forEach(k => k.classList.remove("active"));

      if (active && pitch > 0) {
        const midi = pitchToMidi(pitch);
        if (midi !== null) {
          const key = kb.querySelector(`.mini-key[data-note="${midi}"]`);
          if (key) {
            key.classList.add("active");
          }
        }
      }
    }
  });
}
// 初期化実行 (画面読み込み時に鍵盤列をあらかじめ生成)


  let audioContext = null;
  let workletNode = null;
  let gainNode = null;
  let isPlaying = false;
  let isLoaded = false;
  let currentParsed = null;

  function setStatus(msg, kind) {

  }

  // --------------------------------------------------------------------
  // AudioContext / AudioWorklet 初期化
  // SDSPは32000Hz固定でサンプルを生成する仕様のため、AudioContextの
  // サンプルレートも32000Hzで作成し、リサンプリングなしで直結する。
  // --------------------------------------------------------------------
  async function ensureAudioContext() {
    if (audioContext) return;

const audioOptions = {
  // サンプルレートを 48000Hz (または 44100Hz) に固定
  sampleRate: 48000, 
  
  // 音質最優先（再生の滑らかさ重視）に設定
  latencyHint: 'playback' 
};

// レガシーブラウザ（フォールバック）対応を含めた初期化
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
audioContext = new AudioContextClass(audioOptions);

   
  

    gainNode = audioContext.createGain();
    gainNode.gain.value = 1.0;

    gainNode.connect(audioContext.destination);

    
    
  }

  // --------------------------------------------------------------------
  // ファイル処理
  // --------------------------------------------------------------------
  async function handleFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.spc')) {
      //setStatus('拡張子が .spc のファイルを選択してください', 'error');
      return;
    }

    //setStatus('ファイルを読み込み中...');
    //playBtn.disabled = true;
    isLoaded = false;

    try {
      const buf = await file.arrayBuffer();
      const parsed = parseSPC(buf);
      currentParsed = parsed;

      // UI更新: 曲情報表示
      //const tags = parsed.tags;
      //trackTitle.textContent = tags.songTitle || file.name;
      //trackGame.textContent = tags.gameTitle || '';
     // trackArtist.textContent = tags.artist ? ('作曲: ' + tags.artist) : '';
     // trackDumper.textContent = tags.dumperName ? ('Dump: ' + tags.dumperName) : '';
     // trackInfo.classList.add('visible');

     // setStatus('オーディオエンジンを初期化中...');
      await ensureAudioContext();

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

     
const player = new SPCPlayer();

// ボイス情報のコールバック設定（任意）
player.onVoiceInfo = (voices) => {
  //updateVoiceInfo(voices);
};

// SPCデータのロードと再生
player.load(currentParsed);
player.play();
      //setStatus('読み込み中...');
    } catch (e) {
      console.error(e);
      //setStatus('読み込みエラー: ' + e.message, 'error');
    }
  }

  // --------------------------------------------------------------------
  // 再生/停止トグル
  // --------------------------------------------------------------------
  async function togglePlay() {
    if (!isLoaded || !workletNode) return;

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    if (isPlaying) {
      workletNode.port.postMessage({ type: 'stop' });
      isPlaying = false;
      playBtn.textContent = '▶ 再生';
      playBtn.classList.remove('playing');
      //setStatus('停止しました');
    } else {
      workletNode.port.postMessage({ type: 'play' });
      isPlaying = true;
      playBtn.textContent = '⏸ 停止';
      playBtn.classList.add('playing');
      //setStatus('再生中...', 'ok');
    }
  }

  // --------------------------------------------------------------------
  // イベントバインド
  // --------------------------------------------------------------------
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handleFile(file);
  });



})();