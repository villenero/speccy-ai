/**
 * SNA Snapshot format parser
 *
 * 48K SNA format: 49,179 bytes total
 * - Header: 27 bytes (CPU registers)
 * - RAM: 49,152 bytes ($4000-$FFFF)
 *
 * Note: PC is pushed onto the stack, so SP points 2 bytes lower
 * than the actual SP value, and PC is read from the stack.
 */

import { Spectrum } from "../core/spectrum.js";

export function loadSNA(spectrum: Spectrum, data: Uint8Array): void {
  if (data.length < 49179) {
    throw new Error(`Invalid SNA file: expected 49179 bytes, got ${data.length}`);
  }

  const regs = spectrum.cpu.regs;

  // Header: 27 bytes of register data
  regs.i = data[0];
  regs.hlPrime = data[1] | (data[2] << 8);
  regs.dePrime = data[3] | (data[4] << 8);
  regs.bcPrime = data[5] | (data[6] << 8);
  regs.afPrime = data[7] | (data[8] << 8);
  regs.hl = data[9] | (data[10] << 8);
  regs.de = data[11] | (data[12] << 8);
  regs.bc = data[13] | (data[14] << 8);
  regs.iy = data[15] | (data[16] << 8);
  regs.ix = data[17] | (data[18] << 8);

  // Interrupt flip-flops
  const iff2 = (data[19] >> 2) & 1;
  regs.iff1 = iff2;
  regs.iff2 = iff2;

  regs.r = data[20];
  regs.af = data[21] | (data[22] << 8);
  regs.sp = data[23] | (data[24] << 8);
  regs.im = data[25];

  // Border color
  spectrum.ula.setBorderColor(data[26] & 0x07, 0);

  // RAM: 49,152 bytes at offset 27, loaded to $4000-$FFFF
  for (let i = 0; i < 49152; i++) {
    spectrum.memory.poke(0x4000 + i, data[27 + i]);
  }

  // PC is on the stack: pop it
  const pcLow = spectrum.memory.peek(regs.sp);
  const pcHigh = spectrum.memory.peek((regs.sp + 1) & 0xFFFF);
  regs.pc = pcLow | (pcHigh << 8);
  regs.sp = (regs.sp + 2) & 0xFFFF;
}

/**
 * Save current state as SNA format.
 */
export function saveSNA(spectrum: Spectrum): Uint8Array {
  const data = new Uint8Array(49179);
  const regs = spectrum.cpu.regs;

  // Push PC onto stack
  const sp = (regs.sp - 2) & 0xFFFF;
  spectrum.memory.poke(sp, regs.pc & 0xFF);
  spectrum.memory.poke((sp + 1) & 0xFFFF, (regs.pc >> 8) & 0xFF);

  // Header
  data[0] = regs.i;
  data[1] = regs.hlPrime & 0xFF; data[2] = (regs.hlPrime >> 8) & 0xFF;
  data[3] = regs.dePrime & 0xFF; data[4] = (regs.dePrime >> 8) & 0xFF;
  data[5] = regs.bcPrime & 0xFF; data[6] = (regs.bcPrime >> 8) & 0xFF;
  data[7] = regs.afPrime & 0xFF; data[8] = (regs.afPrime >> 8) & 0xFF;
  data[9] = regs.hl & 0xFF; data[10] = (regs.hl >> 8) & 0xFF;
  data[11] = regs.de & 0xFF; data[12] = (regs.de >> 8) & 0xFF;
  data[13] = regs.bc & 0xFF; data[14] = (regs.bc >> 8) & 0xFF;
  data[15] = regs.iy & 0xFF; data[16] = (regs.iy >> 8) & 0xFF;
  data[17] = regs.ix & 0xFF; data[18] = (regs.ix >> 8) & 0xFF;
  data[19] = regs.iff2 ? 0x04 : 0;
  data[20] = regs.r;
  data[21] = regs.af & 0xFF; data[22] = (regs.af >> 8) & 0xFF;
  data[23] = sp & 0xFF; data[24] = (sp >> 8) & 0xFF;
  data[25] = regs.im;
  data[26] = spectrum.ula.getBorderColor();

  // RAM dump
  for (let i = 0; i < 49152; i++) {
    data[27 + i] = spectrum.memory.peek(0x4000 + i);
  }

  // Restore SP (we modified the stack temporarily)
  spectrum.memory.poke(sp, spectrum.memory.peek(sp));

  return data;
}
