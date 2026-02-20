/**
 * TZX format parser
 *
 * TZX is the de-facto standard for preserving ZX Spectrum tape recordings.
 * This parser extracts loadable data blocks (IDs 0x10, 0x11, 0x14) as TapBlock[],
 * skipping non-data blocks (tones, pauses, metadata, etc.).
 *
 * Reference: https://worldofspectrum.net/TZXformat.html
 */

import { TapBlock } from "./tap.js";

const TZX_MAGIC = "ZXTape!\x1a";

export function parseTZX(data: Uint8Array): TapBlock[] {
  // Validate header: 7 chars + 0x1A + major + minor = 10 bytes
  if (data.length < 10) {
    throw new Error("TZX file too short");
  }

  const magic = String.fromCharCode(...data.slice(0, 8));
  if (magic !== TZX_MAGIC) {
    throw new Error("Invalid TZX header");
  }

  const blocks: TapBlock[] = [];
  let offset = 10; // Skip header

  while (offset < data.length) {
    const blockId = data[offset++];

    switch (blockId) {
      case 0x10: { // Standard speed data block
        // 2 bytes pause, 2 bytes data length
        if (offset + 4 > data.length) return blocks;
        const dataLen = data[offset + 2] | (data[offset + 3] << 8);
        offset += 4;
        if (offset + dataLen > data.length) return blocks;
        extractTapBlock(data, offset, dataLen, blocks);
        offset += dataLen;
        break;
      }

      case 0x11: { // Turbo speed data block
        // 15 bytes header, then 3 bytes data length
        if (offset + 18 > data.length) return blocks;
        const dataLen = data[offset + 15] | (data[offset + 16] << 8) | (data[offset + 17] << 16);
        offset += 18;
        if (offset + dataLen > data.length) return blocks;
        extractTapBlock(data, offset, dataLen, blocks);
        offset += dataLen;
        break;
      }

      case 0x12: // Pure tone
        offset += 4;
        break;

      case 0x13: { // Pulse sequence
        if (offset >= data.length) return blocks;
        const numPulses = data[offset];
        offset += 1 + numPulses * 2;
        break;
      }

      case 0x14: { // Pure data block
        // 7 bytes header, then 3 bytes data length
        if (offset + 10 > data.length) return blocks;
        const dataLen = data[offset + 7] | (data[offset + 8] << 8) | (data[offset + 9] << 16);
        offset += 10;
        if (offset + dataLen > data.length) return blocks;
        extractTapBlock(data, offset, dataLen, blocks);
        offset += dataLen;
        break;
      }

      case 0x15: { // Direct recording
        if (offset + 5 > data.length) return blocks;
        const dataLen = data[offset + 5] | (data[offset + 6] << 8) | (data[offset + 7] << 16);
        offset += 8 + dataLen;
        break;
      }

      case 0x20: // Pause / Stop the tape
        offset += 2;
        break;

      case 0x21: { // Group start
        if (offset >= data.length) return blocks;
        const nameLen = data[offset];
        offset += 1 + nameLen;
        break;
      }

      case 0x22: // Group end
        break;

      case 0x23: // Jump to block
        offset += 2;
        break;

      case 0x24: // Loop start
        offset += 2;
        break;

      case 0x25: // Loop end
        break;

      case 0x2a: // Stop the tape if in 48K mode
        offset += 4;
        break;

      case 0x30: { // Text description
        if (offset >= data.length) return blocks;
        const textLen = data[offset];
        offset += 1 + textLen;
        break;
      }

      case 0x31: { // Message block
        if (offset + 1 >= data.length) return blocks;
        const msgLen = data[offset + 1];
        offset += 2 + msgLen;
        break;
      }

      case 0x32: { // Archive info
        if (offset + 2 > data.length) return blocks;
        const archLen = data[offset] | (data[offset + 1] << 8);
        offset += 2 + archLen;
        break;
      }

      case 0x33: { // Hardware type
        if (offset >= data.length) return blocks;
        const numMachines = data[offset];
        offset += 1 + numMachines * 3;
        break;
      }

      case 0x35: { // Custom info block
        if (offset + 20 > data.length) return blocks;
        const infoLen = data[offset + 16] | (data[offset + 17] << 8) |
                        (data[offset + 18] << 16) | (data[offset + 19] << 24);
        offset += 20 + infoLen;
        break;
      }

      default:
        // Unknown block — try to skip using length at offset (4-byte LE)
        // Many TZX blocks have a 4-byte length after the ID for extensibility
        console.warn(`TZX: unknown block ID 0x${blockId.toString(16).padStart(2, "0")} at offset ${offset - 1}`);
        return blocks;
    }
  }

  return blocks;
}

/**
 * Extract a TapBlock from raw block data (flag + payload + checksum).
 */
function extractTapBlock(data: Uint8Array, offset: number, length: number, blocks: TapBlock[]): void {
  if (length < 2) return; // Need at least flag + checksum

  const flag = data[offset];
  const checksum = data[offset + length - 1];
  const blockData = data.slice(offset + 1, offset + length - 1);

  blocks.push({ flag, data: blockData, checksum });
}
