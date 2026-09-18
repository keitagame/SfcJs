// ============================================================================
// SPC700 CPU + S-DSP, wired into the Snes/Apu emulator core.
//
// This file used to be a standalone ".spc" file player (its own RAM, its own
// DSP, its own audio node). That doesn't fit here: Apu(snes) creates
// `new Spc(this)` and `new Dsp(this)` and drives them cycle-by-cycle, sharing
// the Apu's own 64KB RAM (this.snes.apu.ram) and IO ports. Spc/Dsp below are
// rewritten to that contract:
//   - Spc(apu):  this.reset(), this.cycle()   -- runs the SPC700 core
//   - Dsp(apu):  this.reset(), this.cycle(), this.read(adr), this.write(adr,v)
//                this.samplesL / this.samplesR (circular buffers),
//                this.sampleOffset
// ============================================================================

function Spc(apu) {
  this.apu = apu;

  this.A = 0;
  this.X = 0;
  this.Y = 0;
  this.SP = 0;
  this.PC = 0;

  this.flagN = 0;
  this.flagV = 0;
  this.flagP = 0;
  this.flagB = 0;
  this.flagH = 0;
  this.flagI = 0;
  this.flagZ = 0;
  this.flagC = 0;

  this.cyclesLeft = 0;

  this.reset = function() {
    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0xef;
    this.setPSW(0x02);

    // real hardware: reset vector is fixed at $FFFE/$FFFF, which on the SPC700
    // is hardwired to point into the IPL boot ROM at $FFC0.
    this.PC = 0xffc0;

    this.cyclesLeft = 0;
  }

  // --- memory access goes through the shared Apu RAM/IO, not private ram ---

  this.read = function(addr) {
    return this.apu.read(addr);
  }

  this.write = function(addr, val) {
    this.apu.write(addr, val & 0xff);
  }

  this.getPSW = function() {
    return (this.flagN << 7) | (this.flagV << 6) | (this.flagP << 5) |
           (this.flagB << 4) | (this.flagH << 3) | (this.flagI << 2) |
           (this.flagZ << 1) | (this.flagC);
  }

  this.setPSW = function(v) {
    this.flagN = (v >> 7) & 1;
    this.flagV = (v >> 6) & 1;
    this.flagP = (v >> 5) & 1;
    this.flagB = (v >> 4) & 1;
    this.flagH = (v >> 3) & 1;
    this.flagI = (v >> 2) & 1;
    this.flagZ = (v >> 1) & 1;
    this.flagC = v & 1;
  }

  this.dpBase = function() { return this.flagP ? 0x100 : 0x000; }

  this.setNZ8 = function(v) {
    v &= 0xff;
    this.flagZ = v === 0 ? 1 : 0;
    this.flagN = (v & 0x80) ? 1 : 0;
    return v;
  }

  this.push8 = function(v) { this.write(0x100 + this.SP, v & 0xff); this.SP = (this.SP - 1) & 0xff; }
  this.pop8 = function() { this.SP = (this.SP + 1) & 0xff; return this.read(0x100 + this.SP); }
  this.push16 = function(v) { this.push8((v >> 8) & 0xff); this.push8(v & 0xff); }
  this.pop16 = function() { const lo = this.pop8(); const hi = this.pop8(); return (hi << 8) | lo; }

  this.fetch8 = function() { const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xffff; return v; }
  this.fetch16 = function() { const lo = this.fetch8(); const hi = this.fetch8(); return (hi << 8) | lo; }

  this.dp = function(off) { return (this.dpBase() + off) & 0xffff; }

  this.adc = function(a, b, carryIn) {
    const result = a + b + carryIn;
    this.flagH = ((a & 0xf) + (b & 0xf) + carryIn) > 0xf ? 1 : 0;
    this.flagC = result > 0xff ? 1 : 0;
    const r8 = result & 0xff;
    this.flagV = (~(a ^ b) & (a ^ r8) & 0x80) ? 1 : 0;
    this.setNZ8(r8);
    return r8;
  }

  this.sbc = function(a, b, carryIn) {
    return this.adc(a, (~b) & 0xff, carryIn);
  }

  this._branch = function(cond, disp) {
    if (cond) {
      const s = disp & 0x80 ? disp - 256 : disp;
      this.PC = (this.PC + s) & 0xffff;
      return 2;
    }
    return 0;
  }

  // one instruction step; returns spc-cycles used
  this.step = function() {
    const op = this.fetch8();
    const fn = this.opTable[op];
    let cyc;
    if (!fn) {
      // unimplemented opcode: don't crash the emulator, just burn 2 cycles
      cyc = 2;
    } else {
      cyc = fn.call(this);
    }
    this.cycles = (this.cycles || 0) + cyc;
    return cyc;
  }

  // drive the SPC700 in step with the master clock: called once per Apu
  // cycle, and runs one instruction whenever the previous one's cycles
  // have been paid off (mirrors how Snes.cpuCycle() drives Cpu).
  this.cycle = function() {
    if (this.cyclesLeft <= 0) {
      this.cyclesLeft += this.step();
    }
    this.cyclesLeft--;
  }

  this._buildOpTable();
}

// ----------------------------------------------------------------------------
// Opcode table (unchanged SPC700 core logic, only rd()/wr() rewired above to
// go through the shared Apu memory instead of a private RAM array).
// ----------------------------------------------------------------------------
Spc.prototype._buildOpTable = function() {
  const T = new Array(256).fill(null);
  const rd = (addr) => this.read(addr);
  const wr = (addr, v) => this.write(addr, v);

  T[0x00] = function () { return 2; };
  T[0xE8] = function () { const v = this.fetch8(); this.A = this.setNZ8(v); return 2; };
  T[0xCD] = function () { const v = this.fetch8(); this.X = this.setNZ8(v); return 2; };
  T[0x8D] = function () { const v = this.fetch8(); this.Y = this.setNZ8(v); return 2; };

  T[0x7D] = function () { this.A = this.setNZ8(this.X); return 2; };
  T[0xDD] = function () { this.A = this.setNZ8(this.Y); return 2; };
  T[0x5D] = function () { this.X = this.setNZ8(this.A); return 2; };
  T[0xFD] = function () { this.Y = this.setNZ8(this.A); return 2; };
  T[0x9D] = function () { this.X = this.setNZ8(this.SP); return 2; };
  T[0xBD] = function () { this.SP = this.X; return 2; };

  T[0xC4] = function () { const a = this.dp(this.fetch8()); wr(a, this.A); return 4; };
  T[0xE4] = function () { const a = this.dp(this.fetch8()); this.A = this.setNZ8(rd(a)); return 3; };
  T[0xD8] = function () { const a = this.dp(this.fetch8()); wr(a, this.X); return 4; };
  T[0xF8] = function () { const a = this.dp(this.fetch8()); this.X = this.setNZ8(rd(a)); return 3; };
  T[0xCB] = function () { const a = this.dp(this.fetch8()); wr(a, this.Y); return 4; };
  T[0xEB] = function () { const a = this.dp(this.fetch8()); this.Y = this.setNZ8(rd(a)); return 3; };

  T[0xD4] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); wr(a, this.A); return 5; };
  T[0xF4] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); this.A = this.setNZ8(rd(a)); return 4; };
  T[0xD9] = function () { const a = this.dp((this.fetch8() + this.Y) & 0xff); wr(a, this.X); return 5; };
  T[0xF9] = function () { const a = this.dp((this.fetch8() + this.Y) & 0xff); this.X = this.setNZ8(rd(a)); return 4; };
  T[0xDB] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); wr(a, this.Y); return 5; };
  T[0xFB] = function () { const a = this.dp((this.fetch8() + this.X) & 0xff); this.Y = this.setNZ8(rd(a)); return 4; };

  T[0xC5] = function () { const a = this.fetch16(); wr(a, this.A); return 5; };
  T[0xE5] = function () { const a = this.fetch16(); this.A = this.setNZ8(rd(a)); return 4; };
  T[0xC9] = function () { const a = this.fetch16(); wr(a, this.X); return 5; };
  T[0xE9] = function () { const a = this.fetch16(); this.X = this.setNZ8(rd(a)); return 4; };
  T[0xCC] = function () { const a = this.fetch16(); wr(a, this.Y); return 5; };
  T[0xEC] = function () { const a = this.fetch16(); this.Y = this.setNZ8(rd(a)); return 4; };

  T[0xD5] = function () { const a = (this.fetch16() + this.X) & 0xffff; wr(a, this.A); return 6; };
  T[0xD6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; wr(a, this.A); return 6; };
  T[0xF5] = function () { const a = (this.fetch16() + this.X) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; };
  T[0xF6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; };

  T[0xC6] = function () { wr(this.dp(this.X), this.A); return 4; };
  T[0xE6] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); return 3; };
  T[0xAF] = function () { wr(this.dp(this.X), this.A); this.X = (this.X + 1) & 0xff; return 4; };
  T[0xBF] = function () { this.A = this.setNZ8(rd(this.dp(this.X))); this.X = (this.X + 1) & 0xff; return 4; };

  T[0xC7] = function () {
    const ptr = this.dp((this.fetch8() + this.X) & 0xff);
    const a = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8);
    wr(a, this.A); return 7;
  };
  T[0xE7] = function () {
    const ptr = this.dp((this.fetch8() + this.X) & 0xff);
    const a = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8);
    this.A = this.setNZ8(rd(a)); return 6;
  };
  T[0xD7] = function () {
    const ptr = this.dp(this.fetch8());
    const base = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8);
    const a = (base + this.Y) & 0xffff;
    wr(a, this.A); return 7;
  };
  T[0xF7] = function () {
    const ptr = this.dp(this.fetch8());
    const base = rd(ptr) | (rd((ptr + 1) & 0xffff) << 8);
    const a = (base + this.Y) & 0xffff;
    this.A = this.setNZ8(rd(a)); return 6;
  };

  T[0xFA] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, rd(src)); return 5; };
  T[0x8F] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, v); return 5; };

  T[0xBA] = function () {
    const a = this.dp(this.fetch8());
    const lo = rd(a); const hi = rd((a + 1) & 0xffff);
    this.A = lo; this.Y = hi;
    const w = (hi << 8) | lo;
    this.flagZ = w === 0 ? 1 : 0;
    this.flagN = (hi & 0x80) ? 1 : 0;
    return 5;
  };
  T[0xDA] = function () {
    const a = this.dp(this.fetch8());
    wr(a, this.A); wr((a + 1) & 0xffff, this.Y);
    return 5;
  };
  T[0x3A] = function () {
    const a = this.dp(this.fetch8());
    let w = (rd(a) | (rd((a + 1) & 0xffff) << 8));
    w = (w + 1) & 0xffff;
    wr(a, w & 0xff); wr((a + 1) & 0xffff, (w >> 8) & 0xff);
    this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0;
    return 6;
  };
  T[0x1A] = function () {
    const a = this.dp(this.fetch8());
    let w = (rd(a) | (rd((a + 1) & 0xffff) << 8));
    w = (w - 1) & 0xffff;
    wr(a, w & 0xff); wr((a + 1) & 0xffff, (w >> 8) & 0xff);
    this.flagZ = w === 0 ? 1 : 0; this.flagN = (w & 0x8000) ? 1 : 0;
    return 6;
  };
  T[0x7A] = function () {
    const a = this.dp(this.fetch8());
    const ya = (this.Y << 8) | this.A;
    const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
    const result = ya + m;
    this.flagC = result > 0xffff ? 1 : 0;
    const r16 = result & 0xffff;
    this.flagV = (~(ya ^ m) & (ya ^ r16) & 0x8000) ? 1 : 0;
    this.flagH = (((ya & 0xfff) + (m & 0xfff)) > 0xfff) ? 1 : 0;
    this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
    this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
    return 5;
  };
  T[0x9A] = function () {
    const a = this.dp(this.fetch8());
    const ya = (this.Y << 8) | this.A;
    const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
    const mInv = (~m) & 0xffff;
    const result = ya + mInv + 1;
    this.flagC = result > 0xffff ? 1 : 0;
    const r16 = result & 0xffff;
    this.flagV = (~(ya ^ mInv) & (ya ^ r16) & 0x8000) ? 1 : 0;
    this.flagH = (((ya & 0xfff) + (mInv & 0xfff) + 1) > 0xfff) ? 1 : 0;
    this.Y = (r16 >> 8) & 0xff; this.A = r16 & 0xff;
    this.flagZ = r16 === 0 ? 1 : 0; this.flagN = (r16 & 0x8000) ? 1 : 0;
    return 5;
  };
  T[0x5A] = function () {
    const a = this.dp(this.fetch8());
    const ya = (this.Y << 8) | this.A;
    const m = (rd(a) | (rd((a + 1) & 0xffff) << 8));
    const result = (ya - m) & 0xffff;
    this.flagC = ya >= m ? 1 : 0;
    this.flagZ = result === 0 ? 1 : 0;
    this.flagN = (result & 0x8000) ? 1 : 0;
    return 4;
  };

  T[0x08] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A | v); return 2; };
  T[0x28] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A & v); return 2; };
  T[0x48] = function () { const v = this.fetch8(); this.A = this.setNZ8(this.A ^ v); return 2; };
  T[0x68] = function () { const v = this.fetch8(); const r = (this.A - v) & 0x1ff; this.flagC = this.A >= v ? 1 : 0; this.setNZ8(r); return 2; };
  T[0x88] = function () { const v = this.fetch8(); this.A = this.adc(this.A, v, this.flagC); return 2; };
  T[0xA8] = function () { const v = this.fetch8(); this.A = this.sbc(this.A, v, this.flagC); return 2; };

  T[0x04] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A | v); return 3; };
  T[0x24] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A & v); return 3; };
  T[0x44] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.setNZ8(this.A ^ v); return 3; };
  T[0x64] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
  T[0x84] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.adc(this.A, v, this.flagC); return 3; };
  T[0xA4] = function () { const v = rd(this.dp(this.fetch8())); this.A = this.sbc(this.A, v, this.flagC); return 3; };

  T[0x14] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A | v); return 4; };
  T[0x34] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A & v); return 4; };
  T[0x54] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.setNZ8(this.A ^ v); return 4; };
  T[0x74] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
  T[0x94] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.adc(this.A, v, this.flagC); return 4; };
  T[0xB4] = function () { const v = rd(this.dp((this.fetch8() + this.X) & 0xff)); this.A = this.sbc(this.A, v, this.flagC); return 4; };

  T[0x05] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A | v); return 4; };
  T[0x25] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A & v); return 4; };
  T[0x45] = function () { const v = rd(this.fetch16()); this.A = this.setNZ8(this.A ^ v); return 4; };
  T[0x65] = function () { const v = rd(this.fetch16()); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 4; };
  T[0x85] = function () { const v = rd(this.fetch16()); this.A = this.adc(this.A, v, this.flagC); return 4; };
  T[0xA5] = function () { const v = rd(this.fetch16()); this.A = this.sbc(this.A, v, this.flagC); return 4; };

  T[0x15] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A | v); return 5; };
  T[0x16] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A | v); return 5; };
  T[0x35] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A & v); return 5; };
  T[0x36] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A & v); return 5; };
  T[0x55] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.setNZ8(this.A ^ v); return 5; };
  T[0x56] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.setNZ8(this.A ^ v); return 5; };
  T[0x75] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 5; };
  T[0x76] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 5; };
  T[0x95] = function () { const v = rd((this.fetch16() + this.X) & 0xffff); this.A = this.adc(this.A, v, this.flagC); return 5; };
  T[0x96] = function () { const v = rd((this.fetch16() + this.Y) & 0xffff); this.A = this.adc(this.A, v, this.flagC); return 5; };

  T[0x26] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A | v); return 3; };
  T[0x46] = function () { const v = rd(this.dp(this.X)); this.A = this.setNZ8(this.A ^ v); return 3; };
  T[0x66] = function () { const v = rd(this.dp(this.X)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; };
  T[0x86] = function () { const v = rd(this.dp(this.X)); this.A = this.adc(this.A, v, this.flagC); return 3; };
  T[0xA6] = function () { const v = rd(this.dp(this.X)); this.A = this.sbc(this.A, v, this.flagC); return 3; };

  T[0x07] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.setNZ8(this.A | v); return 6; };
  T[0x27] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.setNZ8(this.A & v); return 6; };
  T[0x47] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.setNZ8(this.A ^ v); return 6; };
  T[0x67] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
  T[0x87] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.adc(this.A, v, this.flagC); return 6; };
  T[0xA7] = function () { const ptr = this.dp((this.fetch8() + this.X) & 0xff); const a = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd(a); this.A = this.sbc(this.A, v, this.flagC); return 6; };

  T[0x17] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A | v); return 6; };
  T[0x37] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A & v); return 6; };
  T[0x57] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.setNZ8(this.A ^ v); return 6; };
  T[0x77] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 6; };
  T[0x97] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.adc(this.A, v, this.flagC); return 6; };
  T[0xB7] = function () { const ptr = this.dp(this.fetch8()); const base = rd(ptr) | (rd((ptr+1)&0xffff)<<8); const v = rd((base+this.Y)&0xffff); this.A = this.sbc(this.A, v, this.flagC); return 6; };

  T[0x09] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) | rd(src))); return 6; };
  T[0x29] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) & rd(src))); return 6; };
  T[0x49] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.setNZ8(rd(dst) ^ rd(src))); return 6; };
  T[0x69] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); const a=rd(dst), b=rd(src); this.flagC = a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 6; };
  T[0x89] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.adc(rd(dst), rd(src), this.flagC)); return 6; };
  T[0xA9] = function () { const src = this.dp(this.fetch8()); const dst = this.dp(this.fetch8()); wr(dst, this.sbc(rd(dst), rd(src), this.flagC)); return 6; };

  T[0x18] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) | v)); return 5; };
  T[0x38] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) & v)); return 5; };
  T[0x58] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) ^ v)); return 5; };
  T[0x78] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); const m = rd(a); this.flagC = m>=v?1:0; this.setNZ8((m-v)&0x1ff); return 5; };
  T[0x98] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.adc(rd(a), v, this.flagC)); return 5; };
  T[0xB8] = function () { const v = this.fetch8(); const a = this.dp(this.fetch8()); wr(a, this.sbc(rd(a), v, this.flagC)); return 5; };

  T[0x19] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) | rd(srcA))); return 5; };
  T[0x39] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) & rd(srcA))); return 5; };
  T[0x59] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.setNZ8(rd(dstA) ^ rd(srcA))); return 5; };
  T[0x79] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); const a=rd(dstA), b=rd(srcA); this.flagC=a>=b?1:0; this.setNZ8((a-b)&0x1ff); return 5; };
  T[0x99] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.adc(rd(dstA), rd(srcA), this.flagC)); return 5; };
  T[0xB9] = function () { const dstA=this.dp(this.X); const srcA=this.dp(this.Y); wr(dstA, this.sbc(rd(dstA), rd(srcA), this.flagC)); return 5; };

  T[0xC8] = function () { const v = this.fetch8(); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 2; };
  T[0xAD] = function () { const v = this.fetch8(); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 2; };
  T[0x3E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 3; };
  T[0x7E] = function () { const v = rd(this.dp(this.fetch8())); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 3; };
  T[0x1E] = function () { const v = rd(this.fetch16()); this.flagC = this.X>=v?1:0; this.setNZ8((this.X-v)&0x1ff); return 4; };
  T[0x5E] = function () { const v = rd(this.fetch16()); this.flagC = this.Y>=v?1:0; this.setNZ8((this.Y-v)&0x1ff); return 4; };

  T[0xBC] = function () { this.A = this.setNZ8(this.A + 1); return 2; };
  T[0x9C] = function () { this.A = this.setNZ8(this.A - 1); return 2; };
  T[0x3D] = function () { this.X = this.setNZ8(this.X + 1); return 2; };
  T[0x1D] = function () { this.X = this.setNZ8(this.X - 1); return 2; };
  T[0xFC] = function () { this.Y = this.setNZ8(this.Y + 1); return 2; };
  T[0xDC] = function () { this.Y = this.setNZ8(this.Y - 1); return 2; };

  T[0xAB] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) + 1)); return 4; };
  T[0x8B] = function () { const a = this.dp(this.fetch8()); wr(a, this.setNZ8(rd(a) - 1)); return 4; };
  T[0xBB] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
  T[0x9B] = function () { const a = this.dp((this.fetch8()+this.X)&0xff); wr(a, this.setNZ8(rd(a) - 1)); return 5; };
  T[0xAC] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) + 1)); return 5; };
  T[0x8C] = function () { const a = this.fetch16(); wr(a, this.setNZ8(rd(a) - 1)); return 5; };

  const asl = (v) => { const c = (v & 0x80) ? 1 : 0; const r = (v << 1) & 0xff; this.flagC = c; return this.setNZ8(r); };
  const lsr = (v) => { const c = v & 1; const r = (v >> 1) & 0xff; this.flagC = c; return this.setNZ8(r); };
  const rol = (v) => { const c = (v & 0x80) ? 1 : 0; const r = ((v << 1) | this.flagC) & 0xff; this.flagC = c; return this.setNZ8(r); };
  const ror = (v) => { const c = v & 1; const r = ((v >> 1) | (this.flagC << 7)) & 0xff; this.flagC = c; return this.setNZ8(r); };

  T[0x1C] = function () { this.A = asl(this.A); return 2; };
  T[0x0B] = function () { const a=this.dp(this.fetch8()); wr(a, asl(rd(a))); return 4; };
  T[0x1B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, asl(rd(a))); return 5; };
  T[0x0C] = function () { const a=this.fetch16(); wr(a, asl(rd(a))); return 5; };

  T[0x5C] = function () { this.A = lsr(this.A); return 2; };
  T[0x4B] = function () { const a=this.dp(this.fetch8()); wr(a, lsr(rd(a))); return 4; };
  T[0x5B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, lsr(rd(a))); return 5; };
  T[0x4C] = function () { const a=this.fetch16(); wr(a, lsr(rd(a))); return 5; };

  T[0x3C] = function () { this.A = rol(this.A); return 2; };
  T[0x2B] = function () { const a=this.dp(this.fetch8()); wr(a, rol(rd(a))); return 4; };
  T[0x3B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, rol(rd(a))); return 5; };
  T[0x2C] = function () { const a=this.fetch16(); wr(a, rol(rd(a))); return 5; };

  T[0x7C] = function () { this.A = ror(this.A); return 2; };
  T[0x6B] = function () { const a=this.dp(this.fetch8()); wr(a, ror(rd(a))); return 4; };
  T[0x7B] = function () { const a=this.dp((this.fetch8()+this.X)&0xff); wr(a, ror(rd(a))); return 5; };
  T[0x6C] = function () { const a=this.fetch16(); wr(a, ror(rd(a))); return 5; };

  T[0x9F] = function () { this.A = this.setNZ8(((this.A << 4) | (this.A >> 4)) & 0xff); return 5; };

  T[0xCF] = function () {
    const r = (this.Y & 0xff) * (this.A & 0xff);
    this.A = r & 0xff; this.Y = (r >> 8) & 0xff;
    this.setNZ8(this.Y);
    return 9;
  };
  T[0x9E] = function () {
    const ya = (this.Y << 8) | this.A;
    const x = this.X;
    let quotient = 0xffff;
    let remainder = ya & 0xff;
    if (x !== 0) {
      quotient = Math.floor(ya / x) & 0xffff;
      remainder = ya % x;
    }
    this.flagV = quotient > 0xff ? 1 : 0;
    this.flagH = ((this.Y & 0xf) <= (x & 0xf)) ? 1 : 0;
    this.A = quotient & 0xff;
    this.Y = remainder & 0xff;
    this.setNZ8(this.A);
    return 12;
  };

  T[0xDF] = function () {
    let a = this.A;
    if (this.flagC || a > 0x99) { a = (a + 0x60) & 0xff; this.flagC = 1; }
    if (this.flagH || (a & 0x0f) > 9) { a = (a + 0x06) & 0xff; }
    this.A = this.setNZ8(a);
    return 3;
  };
  T[0xBE] = function () {
    let a = this.A;
    if (!this.flagC || a > 0x99) { a = (a - 0x60) & 0xff; this.flagC = 0; }
    if (!this.flagH || (a & 0x0f) > 9) { a = (a - 0x06) & 0xff; }
    this.A = this.setNZ8(a);
    return 3;
  };

  T[0x60] = function () { this.flagC = 0; return 2; };
  T[0x80] = function () { this.flagC = 1; return 2; };
  T[0xED] = function () { this.flagC = this.flagC ^ 1; return 3; };
  T[0x20] = function () { this.flagP = 0; return 2; };
  T[0x40] = function () { this.flagP = 1; return 2; };
  T[0xE0] = function () { this.flagV = 0; this.flagH = 0; return 2; };
  T[0xA0] = function () { this.flagI = 1; return 3; };
  T[0xC0] = function () { this.flagI = 0; return 3; };

  T[0x2D] = function () { this.push8(this.A); return 4; };
  T[0x4D] = function () { this.push8(this.X); return 4; };
  T[0x6D] = function () { this.push8(this.Y); return 4; };
  T[0x0D] = function () { this.push8(this.getPSW()); return 4; };
  T[0xAE] = function () { this.A = this.pop8(); return 4; };
  T[0xCE] = function () { this.X = this.pop8(); return 4; };
  T[0xEE] = function () { this.Y = this.pop8(); return 4; };
  T[0x8E] = function () { this.setPSW(this.pop8()); return 4; };

  T[0x2F] = function () { const d = this.fetch8(); const s=d&0x80?d-256:d; this.PC=(this.PC+s)&0xffff; return 4; };
  T[0xF0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===1, d); };
  T[0xD0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagZ===0, d); };
  T[0xB0] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===1, d); };
  T[0x90] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagC===0, d); };
  T[0x70] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===1, d); };
  T[0x50] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagV===0, d); };
  T[0x30] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===1, d); };
  T[0x10] = function () { const d = this.fetch8(); return 2 + this._branch(this.flagN===0, d); };

  for (let bit = 0; bit < 8; bit++) {
    const opSet = 0x03 | (bit << 5);
    const opClr = 0x13 | (bit << 5);
    T[opSet] = function () {
      const a = this.dp(this.fetch8()); const d = this.fetch8();
      const v = rd(a);
      return 5 + this._branch(((v >> bit) & 1) === 1, d);
    };
    T[opClr] = function () {
      const a = this.dp(this.fetch8()); const d = this.fetch8();
      const v = rd(a);
      return 5 + this._branch(((v >> bit) & 1) === 0, d);
    };
  }

  T[0x2E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); const v=rd(a); return 5 + this._branch(this.A!==v, d); };
  T[0x6E] = function () { const a=this.dp(this.fetch8()); const d=this.fetch8(); let v=rd(a); v=(v-1)&0xff; wr(a,v); return 5 + this._branch(v!==0, d); };
  T[0xFE] = function () { const d=this.fetch8(); this.Y=(this.Y-1)&0xff; return 2 + this._branch(this.Y!==0, d); };

  T[0x5F] = function () { this.PC = this.fetch16(); return 3; };
  T[0x1F] = function () { const base = this.fetch16(); const ptr=(base+this.X)&0xffff; this.PC = rd(ptr) | (rd((ptr+1)&0xffff)<<8); return 6; };

  for (let n = 0; n < 16; n++) {
    const op = 0x01 | (n << 4);
    T[op] = function () {
      const vecAddr = 0xFFDE - n * 2;
      const target = rd(vecAddr) | (rd((vecAddr + 1) & 0xffff) << 8);
      this.push16(this.PC);
      this.PC = target;
      return 8;
    };
  }

  T[0x3F] = function () { const a = this.fetch16(); this.push16(this.PC); this.PC = a; return 8; };
  T[0x4F] = function () { const a = 0xFF00 | this.fetch8(); this.push16(this.PC); this.PC = a; return 6; };

  T[0x6F] = function () { this.PC = this.pop16(); return 5; };
  T[0x7F] = function () { this.setPSW(this.pop8()); this.PC = this.pop16(); return 6; };

  T[0x0F] = function () {
    this.push16(this.PC);
    this.push8(this.getPSW());
    this.flagB = 1; this.flagI = 0;
    this.PC = rd(0xFFDE) | (rd(0xFFDF) << 8);
    return 8;
  };

  T[0xEF] = function () { this.cyclesLeft = 0; return 3; }; // SLEEP (not fully emulated: just idle)
  T[0xFF] = function () { this.cyclesLeft = 0; return 3; }; // STOP  (not fully emulated: just idle)

  T[0xEA] = function () { const w=this.fetch16(); const addr=w&0x1fff; const bit=(w>>13)&7; let v=rd(addr); v ^= (1<<bit); wr(addr, v&0xff); return 5; };

  for (let bit = 0; bit < 8; bit++) {
    const opSet = 0x02 | (bit << 5);
    const opClr = 0x12 | (bit << 5);
    T[opSet] = function () { const a=this.dp(this.fetch8()); let v=rd(a); v |= (1<<bit); wr(a, v&0xff); return 4; };
    T[opClr] = function () { const a=this.dp(this.fetch8()); let v=rd(a); v &= ~(1<<bit); wr(a, v&0xff); return 4; };
  }

  T[0x0E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v | this.A); return 6; };
  T[0x4E] = function () { const a=this.fetch16(); const v=rd(a); this.setNZ8((this.A - v) & 0x1ff); wr(a, v & (~this.A & 0xff)); return 6; };

  // --- opcodes not present in the original file ---

  T[0x06] = function () { const v = rd(this.dp(this.X)); this.flagC = this.A >= v ? 1 : 0; this.setNZ8((this.A - v) & 0x1ff); return 3; }; // CMP A,(X)

  // OR1/AND1/EOR1/MOV1 C,mem.bit: low 13 bits = absolute addr, high 3 bits = bit index.
  // The "/" (inverted) variants read the bit inverted before combining.
  T[0x0A] = function () { const w = this.fetch16(); const bit=(w>>13)&7; const v=(rd(w&0x1fff)>>bit)&1; this.flagC |= v; this.flagC &= 1; return 5; };
  T[0x2A] = function () { const w = this.fetch16(); const bit=(w>>13)&7; const v=((rd(w&0x1fff)>>bit)&1)^1; this.flagC |= v; this.flagC &= 1; return 5; };
  T[0x4A] = function () { const w = this.fetch16(); const bit=(w>>13)&7; const v=(rd(w&0x1fff)>>bit)&1; this.flagC &= v; return 4; };
  T[0x6A] = function () { const w = this.fetch16(); const bit=(w>>13)&7; const v=((rd(w&0x1fff)>>bit)&1)^1; this.flagC &= v; return 4; };
  T[0x8A] = function () { const w = this.fetch16(); const bit=(w>>13)&7; const v=(rd(w&0x1fff)>>bit)&1; this.flagC ^= v; this.flagC &= 1; return 5; };
  T[0xAA] = function () { const w = this.fetch16(); const bit=(w>>13)&7; const v=(rd(w&0x1fff)>>bit)&1; this.flagC = v; return 4; };
  T[0xCA] = function () {
    const w = this.fetch16(); const addr = w & 0x1fff; const bit=(w>>13)&7;
    let v = rd(addr);
    if (this.flagC) v |= (1<<bit); else v &= ~(1<<bit) & 0xff;
    wr(addr, v & 0xff);
    return 6;
  };

  T[0xB5] = function () { const a = (this.fetch16() + this.X) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; }; // MOV A,!abs+X (alt encoding)
  T[0xB6] = function () { const a = (this.fetch16() + this.Y) & 0xffff; this.A = this.setNZ8(rd(a)); return 5; }; // MOV A,!abs+Y (alt encoding)

  T[0xDE] = function () { // CBNE dp+X, rel
    const a = this.dp((this.fetch8() + this.X) & 0xff);
    const d = this.fetch8();
    const v = rd(a);
    return 6 + this._branch(this.A !== v, d);
  };

  this.opTable = T;
}

// setSamples 実装例の概念コード
function setSamples(outL, outR, length) {
  const ratio = 32000 / audioCtx.sampleRate; // 例: 32000 / 44100 = 約 0.7256
  for (let i = 0; i < length; i++) {
    // 44.1kHzの1ステップに対して 32kHzバッファを ratio 分だけ進めて読み出す
    const readIndex = Math.floor(this.readOffset);
    outL[i] = dsp.samplesL[readIndex & 0xffff];
    outR[i] = dsp.samplesR[readIndex & 0xffff];
    this.readOffset += ratio;
  }
}
// ============================================================================
// S-DSP
// ============================================================================
const SDSP_SAMPLE_BUFFER_SIZE = 0x10000; // must be a power of two (see setSamples masking)

const COUNTER_RATES = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192,
  160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1
];

function buildGaussTable() {
  const table = new Float64Array(512);
  for (let i = 0; i < 512; i++) {
    const x = (i - 256) / 256;
    table[i] = Math.exp(-3.0 * x * x);
  }
  return table;
}

function Dsp(apu) {
  this.apu = apu;

  this.regs = new Uint8Array(128);
  this.regAddr = 0;

  this.gaussTable = buildGaussTable();
  this.noiseLFSR = 0x4000;

  // circular output buffers, read by Apu.setSamples()
  this.samplesL = new Float32Array(SDSP_SAMPLE_BUFFER_SIZE);
  this.samplesR = new Float32Array(SDSP_SAMPLE_BUFFER_SIZE);
  this.sampleOffset = 0;

  this.voices = [];
  for (let i = 0; i < 8; i++) {
    this.voices.push({
      brrAddr: 0,
      brrOffset: 0,
      pitchCounter: 0,
      history: [0, 0],
      keyOn: false,
      keyOff: false,
      envMode: 'off',
      envLevel: 0,
      loopFlag: false,
      endFlag: false,
      outSample: 0,
      konDelay: 0,
      _konLatched: false,
      decodedBlock: new Int16Array(16)
    });
  }

  this.reset = function() {
    this.regs.fill(0);
    this.regAddr = 0;
    this._globalCounter = 0;
    this._pendingKon = 0;
    this.noiseLFSR = 0x4000;
    this.sampleOffset = 0;
    clearArray(this.samplesL);
    clearArray(this.samplesR);
    for (const v of this.voices) {
      v.pitchCounter = 0;
      v.envLevel = 0;
      v.keyOn = false;
      v.keyOff = false;
      v.envMode = 'off';
      v.history = [0, 0];
      v.brrOffset = 16;
      v.endFlag = false;
      v._konLatched = false;
    }
  }

  // Apu ram helper - the S-DSP addresses the shared 64KB Apu RAM directly
  this._ram = function(adr) { return this.apu.ram[adr & 0xffff]; }

  this.read = function(addr) { return this.regs[addr & 0x7f]; }
  this.write = function(addr, val) {
    addr &= 0x7f;
    val &= 0xff;
    if (addr === 0x7c) {
      this.regs[0x7c] = 0; // ENDX: any write clears all bits
      return;
    }
    if (addr === 0x4c) {
      // latch newly-set KON bits so a same-sample-period rewrite isn't missed
      this._pendingKon = (this._pendingKon || 0) | val;
    }
    this.regs[addr] = val;
  }

  this.volL = function(v) { return this._s8(this.regs[v * 0x10 + 0x00]); }
  this.volR = function(v) { return this._s8(this.regs[v * 0x10 + 0x01]); }
  this.pitch = function(v) { return this.regs[v * 0x10 + 0x02] | (this.regs[v * 0x10 + 0x03] << 8); }
  this.srcn = function(v) { return this.regs[v * 0x10 + 0x04]; }
  this.adsr1 = function(v) { return this.regs[v * 0x10 + 0x05]; }
  this.adsr2 = function(v) { return this.regs[v * 0x10 + 0x06]; }
  this.gain = function(v) { return this.regs[v * 0x10 + 0x07]; }

  this._s8 = function(v) { return v >= 128 ? v - 256 : v; }

  Object.defineProperties(this, {
    kon:   { get: function() { return this.regs[0x4c]; } },
    koff:  { get: function() { return this.regs[0x5c]; } },
    flg:   { get: function() { return this.regs[0x6c]; } },
    pmon:  { get: function() { return this.regs[0x2d]; } },
    non:   { get: function() { return this.regs[0x3d]; } },
    eon:   { get: function() { return this.regs[0x4d]; } },
    dir:   { get: function() { return this.regs[0x5d]; } },
    mvolL: { get: function() { return this._s8(this.regs[0x0c]); } },
    mvolR: { get: function() { return this._s8(this.regs[0x1c]); } },
    evolL: { get: function() { return this._s8(this.regs[0x2c]); } },
    evolR: { get: function() { return this._s8(this.regs[0x3c]); } },
    efb:   { get: function() { return this._s8(this.regs[0x0d]); } }
  });

  this.getSampleDirEntry = function(srcn) {
    const base = (this.dir << 8) + srcn * 4;
    const start = this._ram(base) | (this._ram(base + 1) << 8);
    const loop = this._ram(base + 2) | (this._ram(base + 3) << 8);
    return { start, loop };
  }

  this.decodeBrrBlock = function(voice, addr, voiceIdx) {
    const header = this._ram(addr);
    const range = (header >> 4) & 0x0f;
    const filter = (header >> 2) & 0x03;
    const loopBit = (header >> 1) & 1;
    const endBit = header & 1;

    const out = voice.decodedBlock;
    let h1 = voice.history[0];
    let h2 = voice.history[1];

    for (let i = 0; i < 16; i++) {
      const byteIdx = 1 + (i >> 1);
      const byte = this._ram((addr + byteIdx) & 0xffff);
      let nibble = (i & 1) === 0 ? (byte >> 4) : (byte & 0x0f);
      if (nibble >= 8) nibble -= 16;

      let sample;
      if (range <= 12) {
        sample = (nibble << range) >> 1;
      } else {
        sample = nibble < 0 ? -2048 : 0;
      }

      let pred = 0;
      switch (filter) {
        case 0: pred = 0; break;
        case 1: pred = h1 + ((-h1) >> 4); break;
        case 2: pred = h1 * 2 + ((-(h1 * 3)) >> 5) - h2 + (h2 >> 4); break;
        case 3: pred = h1 * 2 + ((-(h1 * 13)) >> 6) - h2 + ((h2 * 3) >> 4); break;
      }
      let s = sample + pred;
      if (s > 32767) s = 32767;
      if (s < -32768) s = -32768;

      out[i] = s;
      h2 = h1;
      h1 = s;
    }

    voice.history[0] = h1;
    voice.history[1] = h2;
    voice.loopFlag = loopBit === 1;
    voice.endFlag = endBit === 1;
    if (endBit === 1 && voiceIdx !== undefined) {
      this.regs[0x7c] |= (1 << voiceIdx);
    }
    return endBit === 1;
  }

  this.stepNoise = function() {
    let lfsr = this.noiseLFSR;
    const bit = ((lfsr << 14) ^ (lfsr << 13)) & 0x4000;
    lfsr = ((lfsr >> 1) | bit) & 0x7fff;
    this.noiseLFSR = lfsr;
    let v = lfsr & 0x7fff;
    if (v & 0x4000) v -= 0x8000;
    return v;
  }

  this._rateFires = function(rateIndex) {
    const period = COUNTER_RATES[rateIndex] || 0;
    if (period === 0) return false;
    this._globalCounter = (this._globalCounter || 0);
    return (this._globalCounter % period) === 0;
  }

  this.stepEnvelope = function(voice, vIdx) {
    const a1 = this.adsr1(vIdx);
    const a2 = this.adsr2(vIdx);
    const useADSR = (a1 & 0x80) !== 0;

    if (voice.keyOff) {
      voice.envMode = 'release';
    }

    if (voice.envMode === 'release') {
      voice.envLevel -= 8;
      if (voice.envLevel <= 0) {
        voice.envLevel = 0;
        voice.envMode = 'off';
      }
      return voice.envLevel;
    }

    if (useADSR) {
      const attackRate = (a1 & 0x0f) * 2 + 1;
      const decayRate = ((a1 >> 4) & 0x07) * 2 + 16;
      const sustainRate = a2 & 0x1f;
      const sustainLvl = (((a2 >> 5) & 0x07) + 1) * 256;

      if (voice.envMode === 'attack') {
        const rate = attackRate;
        if (this._rateFires(rate)) {
          voice.envLevel += (rate === 31) ? 1024 : 32;
          if (voice.envLevel >= 2047) {
            voice.envLevel = 2047;
            voice.envMode = 'decay';
          }
        }
      } else if (voice.envMode === 'decay') {
        if (this._rateFires(decayRate)) {
          voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          if (voice.envLevel < 0) voice.envLevel = 0;
          if (voice.envLevel <= sustainLvl) voice.envMode = 'sustain';
        }
      } else if (voice.envMode === 'sustain') {
        if (sustainRate > 0 && this._rateFires(sustainRate)) {
          voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          if (voice.envLevel < 0) voice.envLevel = 0;
        }
      }
    } else {
      const gainVal = this.gain(vIdx);
      if ((gainVal & 0x80) === 0) {
        voice.envLevel = (gainVal & 0x7f) * 16;
      } else {
        const mode = (gainVal >> 5) & 0x03;
        const rate = gainVal & 0x1f;
        if (this._rateFires(rate)) {
          if (mode === 0) {
            voice.envLevel -= 32;
          } else if (mode === 1) {
            voice.envLevel += 32;
          } else if (mode === 2) {
            voice.envLevel -= (((voice.envLevel - 1) >> 8) + 1);
          } else {
            voice.envLevel += (voice.envLevel < 1536) ? 32 : 8;
          }
          if (voice.envLevel < 0) voice.envLevel = 0;
          if (voice.envLevel > 2047) voice.envLevel = 2047;
        }
      }
    }

    if (voice.envLevel < 0) voice.envLevel = 0;
    if (voice.envLevel > 2047) voice.envLevel = 2047;
    return voice.envLevel;
  }

  this._triggerKeyOn = function(voice, i) {
    this.regs[0x7c] &= ~(1 << i);
    const dirEntry = this.getSampleDirEntry(this.srcn(i));
    voice.brrAddr = dirEntry.start;
    voice.brrOffset = 16;
    voice.pitchCounter = 0;
    voice.history = [0, 0];
    voice.envLevel = 0;
    voice.envMode = 'kon-delay';
    voice.konDelay = 5;
    voice.keyOff = false;
    voice.endFlag = false;
    voice.loopFlag = false;
    voice.outSample = 0;
  }

  // generate a single stereo sample and push it into the circular buffer
  this.generateSample = function() {
    this._globalCounter = (this._globalCounter || 0) + 1;

    let mixL = 0, mixR = 0;
    const konReg = this.kon | (this._pendingKon || 0);
    const koffReg = this.koff;
    this._pendingKon = 0;

    for (let i = 0; i < 8; i++) {
      const voice = this.voices[i];
      const bit = 1 << i;

      if (konReg & bit) {
        if (!voice._konLatched) {
          this._triggerKeyOn(voice, i);
          voice._konLatched = true;
        }
      } else {
        voice._konLatched = false;
      }
      voice.keyOff = (koffReg & bit) > 0;

      if (voice.envMode === 'off') {
        continue;
      }

      if (voice.envMode === 'kon-delay') {
        if (voice.brrOffset >= 16) {
          this.decodeBrrBlock(voice, voice.brrAddr, i);
          voice.brrOffset = 0;
        }
        voice.outSample = 0;
        voice.konDelay--;
        if (voice.konDelay <= 0) {
          voice.envMode = 'attack';
        }
        continue;
      }

      let p = this.pitch(i);
      if (i > 0 && (this.pmon & bit)) {
        const prevOut = this.voices[i - 1].outSample;
        p = Math.floor((p * ((prevOut >> 5) + 1024)) / 1024);
      }
      if (p > 0x3fff) p = 0x3fff;

      if (voice.brrOffset >= 16) {
        if (voice.endFlag) {
          if (voice.loopFlag) {
            const dirEntry = this.getSampleDirEntry(this.srcn(i));
            voice.brrAddr = dirEntry.loop;
          } else {
            voice.envMode = 'off';
            voice.envLevel = 0;
            continue;
          }
        }
        this.decodeBrrBlock(voice, voice.brrAddr, i);
        voice.brrOffset = 0;
      }

      const idx = voice.brrOffset;
      const s0 = voice.decodedBlock[idx];
      const s1 = idx < 15 ? voice.decodedBlock[idx + 1] : s0;
      const frac = (voice.pitchCounter & 0xfff) / 0x1000;
      let sample = s0 + (s1 - s0) * frac;

      if (this.non & bit) {
        sample = this.stepNoise();
      }

      const env = this.stepEnvelope(voice, i);
      sample = (sample * env) / 2047;

      voice.outSample = sample;

      const vl = this.volL(i) / 128;
      const vr = this.volR(i) / 128;
      mixL += sample * vl;
      mixR += sample * vr;

      voice.pitchCounter += p;
      const advance = voice.pitchCounter >> 12;
      voice.pitchCounter &= 0xfff;
      voice.brrOffset += advance;
      while (voice.brrOffset >= 16) {
        if (voice.endFlag) {
          if (voice.loopFlag) {
            const dirEntry = this.getSampleDirEntry(this.srcn(i));
            voice.brrAddr = dirEntry.loop;
          } else {
            voice.envMode = 'off';
            voice.envLevel = 0;
            voice.brrOffset = 16;
            break;
          }
        } else {
          voice.brrAddr = (voice.brrAddr + 9) & 0xffff;
        }
        if (voice.envMode === 'off') break;
        this.decodeBrrBlock(voice, voice.brrAddr, i);
        voice.brrOffset -= 16;
      }
    }

    let outL = (mixL * this.mvolL) / (128 * 8192);
    let outR = (mixR * this.mvolR) / (128 * 8192);

    outL = Math.tanh(outL);
    outR = Math.tanh(outR);

    this.samplesL[this.sampleOffset & 0xffff] = outL;
    this.samplesR[this.sampleOffset & 0xffff] = outR;
    this.sampleOffset = (this.sampleOffset + 1) & 0xffff;
  }

  // called by Apu every 32 master apu cycles == 1 dsp sample tick
  this.cycle = function() {
    this.generateSample();
  }
}