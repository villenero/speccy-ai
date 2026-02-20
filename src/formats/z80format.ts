/**
 * .Z80 Snapshot format parser
 *
 * Supports v1, v2, and v3 formats.
 * v1: 30-byte header + optionally compressed RAM
 * v2: 30+2+N header + paged RAM blocks
 * v3: 30+2+N header + paged RAM blocks (larger additional header)
 */

import { Spectrum } from "../core/spectrum.js";

export function loadZ80(spectrum: Spectrum, data: Uint8Array): void {
  const regs = spectrum.cpu.regs;

  // Common header (30 bytes)
  regs.a = data[0];
  regs.f = data[1];
  regs.bc = data[2] | (data[3] << 8);
  regs.hl = data[4] | (data[5] << 8);
  regs.pc = data[6] | (data[7] << 8);
  regs.sp = data[8] | (data[9] << 8);
  regs.i = data[10];
  regs.r = (data[11] & 0x7F) | ((data[12] & 0x01) << 7);

  const byte12 = data[12];
  if (byte12 === 255) {
    // Treat as 1
  }
  const borderColor = (byte12 >> 1) & 0x07;
  const compressed = (byte12 >> 5) & 0x01;
  spectrum.ula.setBorderColor(borderColor, 0);

  regs.de = data[13] | (data[14] << 8);
  regs.bcPrime = data[15] | (data[16] << 8);
  regs.dePrime = data[17] | (data[18] << 8);
  regs.hlPrime = data[19] | (data[20] << 8);
  regs.a = data[21]; // A'
  regs.f = data[22]; // F'
  // Actually, AF' is stored at bytes 21-22
  regs.afPrime = data[22] | (data[21] << 8);
  // Restore A and F from bytes 0-1
  regs.a = data[0];
  regs.f = data[1];

  regs.iy = data[23] | (data[24] << 8);
  regs.ix = data[25] | (data[26] << 8);
  regs.iff1 = data[27] ? 1 : 0;
  regs.iff2 = data[28] ? 1 : 0;
  regs.im = data[29] & 0x03;

  // Detect version
  if (regs.pc !== 0) {
    // Version 1
    loadV1RAM(spectrum, data, 30, compressed !== 0);
  } else {
    // Version 2 or 3
    const additionalHeaderLength = data[30] | (data[31] << 8);
    regs.pc = data[32] | (data[33] << 8);

    const ramOffset = 32 + additionalHeaderLength;
    loadPagedRAM(spectrum, data, ramOffset);
  }
}

function loadV1RAM(spectrum: Spectrum, data: Uint8Array, offset: number, compressed: boolean): void {
  if (compressed) {
    decompressBlock(data, offset, data.length - offset - 4, spectrum, 0x4000);
  } else {
    for (let i = 0; i < 49152 && offset + i < data.length; i++) {
      spectrum.memory.poke(0x4000 + i, data[offset + i]);
    }
  }
}

function loadPagedRAM(spectrum: Spectrum, data: Uint8Array, offset: number): void {
  while (offset < data.length - 3) {
    const blockLength = data[offset] | (data[offset + 1] << 8);
    const page = data[offset + 2];
    offset += 3;

    // For 48K: page 4 → $8000, page 5 → $C000, page 8 → $4000
    let baseAddr: number;
    switch (page) {
      case 4: baseAddr = 0x8000; break;
      case 5: baseAddr = 0xC000; break;
      case 8: baseAddr = 0x4000; break;
      default: offset += blockLength === 0xFFFF ? 16384 : blockLength; continue;
    }

    if (blockLength === 0xFFFF) {
      // Uncompressed 16K block
      for (let i = 0; i < 16384 && offset + i < data.length; i++) {
        spectrum.memory.poke(baseAddr + i, data[offset + i]);
      }
      offset += 16384;
    } else {
      decompressBlock(data, offset, blockLength, spectrum, baseAddr);
      offset += blockLength;
    }
  }
}

function decompressBlock(
  data: Uint8Array,
  srcOffset: number,
  srcLength: number,
  spectrum: Spectrum,
  destAddr: number
): void {
  let src = srcOffset;
  const srcEnd = srcOffset + srcLength;
  let dest = destAddr;
  const destEnd = destAddr + 16384;

  while (src < srcEnd && dest < destEnd) {
    if (src + 3 < srcEnd && data[src] === 0xED && data[src + 1] === 0xED) {
      // RLE: ED ED count value
      const count = data[src + 2];
      const value = data[src + 3];
      for (let i = 0; i < count && dest < destEnd; i++) {
        spectrum.memory.poke(dest++, value);
      }
      src += 4;
    } else {
      spectrum.memory.poke(dest++, data[src++]);
    }
  }
}
