/**
 * TAP format parser
 *
 * TAP files contain a sequence of data blocks.
 * Each block is preceded by a 2-byte little-endian length.
 * The block data includes the flag byte and checksum.
 */

export interface TapBlock {
  flag: number;     // 0x00 = header, 0xFF = data
  data: Uint8Array; // Raw block data (without flag and checksum)
  checksum: number;
}

export function parseTAP(data: Uint8Array): TapBlock[] {
  const blocks: TapBlock[] = [];
  let offset = 0;

  while (offset + 2 <= data.length) {
    const blockLength = data[offset] | (data[offset + 1] << 8);
    offset += 2;

    if (blockLength === 0 || offset + blockLength > data.length) break;

    const flag = data[offset];
    const checksum = data[offset + blockLength - 1];
    const blockData = data.slice(offset + 1, offset + blockLength - 1);

    blocks.push({ flag, data: blockData, checksum });
    offset += blockLength;
  }

  return blocks;
}

/**
 * Standard ROM tape timing (T-states per pulse).
 */
export const TAPE_TIMING = {
  PILOT_PULSE: 2168,
  PILOT_HEADER_PULSES: 8063,
  PILOT_DATA_PULSES: 3223,
  SYNC1: 667,
  SYNC2: 735,
  BIT_ZERO: 855,
  BIT_ONE: 1710,
  PAUSE_MS: 1000,
} as const;
