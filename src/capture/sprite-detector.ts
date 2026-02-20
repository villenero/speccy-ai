/**
 * Sprite Detector — Automatic sprite/tile extraction via frame diffing
 *
 * Techniques:
 * - Frame diff: detect moving objects by comparing consecutive frames
 * - Bounding box extraction: group changed pixels into sprite candidates
 * - Tile detection: find repeated 8x8 patterns in the display
 * - Text OCR: read on-screen text using the ROM charset
 */

import { DISPLAY_WIDTH, DISPLAY_HEIGHT, PALETTE } from "../core/ula.js";
import type { CapturedFrame } from "./frame-capture.js";

export interface DetectedSprite {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray; // RGBA
}

export interface DetectedTile {
  hash: string;
  pixels: Uint8ClampedArray; // 8x8 RGBA
  positions: [number, number][]; // Where it appears
}

export interface DetectedText {
  x: number;
  y: number;
  charCol: number;
  charRow: number;
  content: string;
}

export class SpriteDetector {
  private previousFrame: Uint8ClampedArray | null = null;
  private spriteIdCounter = 0;

  /**
   * Compare two frames and detect moving sprites.
   * Returns bounding boxes of changed regions.
   */
  detectSprites(frame: CapturedFrame, minSize = 4): DetectedSprite[] {
    if (!this.previousFrame || frame.width !== DISPLAY_WIDTH) {
      this.previousFrame = new Uint8ClampedArray(frame.pixels);
      return [];
    }

    // Find changed pixels
    const changed = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT);
    for (let y = 0; y < DISPLAY_HEIGHT; y++) {
      for (let x = 0; x < DISPLAY_WIDTH; x++) {
        const idx = (y * DISPLAY_WIDTH + x) * 4;
        if (
          frame.pixels[idx] !== this.previousFrame[idx] ||
          frame.pixels[idx + 1] !== this.previousFrame[idx + 1] ||
          frame.pixels[idx + 2] !== this.previousFrame[idx + 2]
        ) {
          changed[y * DISPLAY_WIDTH + x] = 1;
        }
      }
    }

    // Flood-fill to group connected changed pixels into bounding boxes
    const visited = new Uint8Array(DISPLAY_WIDTH * DISPLAY_HEIGHT);
    const sprites: DetectedSprite[] = [];

    for (let y = 0; y < DISPLAY_HEIGHT; y++) {
      for (let x = 0; x < DISPLAY_WIDTH; x++) {
        if (changed[y * DISPLAY_WIDTH + x] && !visited[y * DISPLAY_WIDTH + x]) {
          const bbox = this.floodFill(changed, visited, x, y);
          const w = bbox.maxX - bbox.minX + 1;
          const h = bbox.maxY - bbox.minY + 1;

          if (w >= minSize && h >= minSize) {
            // Extract sprite pixels from current frame
            const pixels = new Uint8ClampedArray(w * h * 4);
            for (let sy = 0; sy < h; sy++) {
              for (let sx = 0; sx < w; sx++) {
                const srcIdx = ((bbox.minY + sy) * DISPLAY_WIDTH + (bbox.minX + sx)) * 4;
                const dstIdx = (sy * w + sx) * 4;
                pixels[dstIdx] = frame.pixels[srcIdx];
                pixels[dstIdx + 1] = frame.pixels[srcIdx + 1];
                pixels[dstIdx + 2] = frame.pixels[srcIdx + 2];
                pixels[dstIdx + 3] = 255;
              }
            }

            sprites.push({
              id: this.spriteIdCounter++,
              x: bbox.minX,
              y: bbox.minY,
              width: w,
              height: h,
              pixels,
            });
          }
        }
      }
    }

    this.previousFrame = new Uint8ClampedArray(frame.pixels);
    return sprites;
  }

  /**
   * Detect repeated 8x8 tile patterns in the display.
   */
  detectTiles(frame: CapturedFrame): DetectedTile[] {
    if (frame.width !== DISPLAY_WIDTH) return [];

    const tileMap = new Map<string, DetectedTile>();
    const cols = DISPLAY_WIDTH / 8;
    const rows = DISPLAY_HEIGHT / 8;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tilePixels = new Uint8ClampedArray(8 * 8 * 4);

        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const srcIdx = ((row * 8 + y) * DISPLAY_WIDTH + (col * 8 + x)) * 4;
            const dstIdx = (y * 8 + x) * 4;
            tilePixels[dstIdx] = frame.pixels[srcIdx];
            tilePixels[dstIdx + 1] = frame.pixels[srcIdx + 1];
            tilePixels[dstIdx + 2] = frame.pixels[srcIdx + 2];
            tilePixels[dstIdx + 3] = 255;
          }
        }

        // Hash the tile (simple: use first few bytes as key)
        const hash = this.hashTile(tilePixels);

        if (tileMap.has(hash)) {
          tileMap.get(hash)!.positions.push([col * 8, row * 8]);
        } else {
          tileMap.set(hash, {
            hash,
            pixels: tilePixels,
            positions: [[col * 8, row * 8]],
          });
        }
      }
    }

    // Only return tiles that appear more than once (repeated = likely game tiles)
    return Array.from(tileMap.values()).filter(t => t.positions.length > 1);
  }

  /**
   * Detect text on screen using the Spectrum ROM charset.
   * The ROM charset is at $3D00-$3FFF (96 characters, 8 bytes each).
   * Characters 32-127 (space to DEL).
   */
  detectText(screenPixels: Uint8Array, screenAttrs: Uint8Array, romCharset: Uint8Array): DetectedText[] {
    const results: DetectedText[] = [];
    const cols = 32;
    const rows = 24;

    for (let row = 0; row < rows; row++) {
      let lineText = "";
      let lineStartCol = -1;

      for (let col = 0; col < cols; col++) {
        // Extract the 8-byte pattern at this character cell from screen memory
        const charPattern = new Uint8Array(8);
        for (let line = 0; line < 8; line++) {
          // Screen address for pixel line
          const y = row * 8 + line;
          const addr = ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | col;
          charPattern[line] = screenPixels[addr];
        }

        // Check attribute: if INK and PAPER are the same, skip (invisible)
        const attr = screenAttrs[row * 32 + col];
        const ink = attr & 0x07;
        const paper = (attr >> 3) & 0x07;
        if (ink === paper) {
          if (lineText.trim()) {
            results.push({
              x: lineStartCol * 8,
              y: row * 8,
              charCol: lineStartCol,
              charRow: row,
              content: lineText.trim(),
            });
          }
          lineText = "";
          lineStartCol = -1;
          continue;
        }

        // Match against ROM charset (characters 32-127)
        let matched = false;
        for (let ch = 32; ch < 128; ch++) {
          const romOffset = (ch - 32) * 8;
          let isMatch = true;
          for (let line = 0; line < 8; line++) {
            if (charPattern[line] !== romCharset[romOffset + line]) {
              isMatch = false;
              break;
            }
          }
          if (isMatch) {
            if (lineStartCol === -1) lineStartCol = col;
            lineText += String.fromCharCode(ch);
            matched = true;
            break;
          }
        }

        if (!matched) {
          if (lineText.trim()) {
            results.push({
              x: lineStartCol * 8,
              y: row * 8,
              charCol: lineStartCol,
              charRow: row,
              content: lineText.trim(),
            });
          }
          lineText = "";
          lineStartCol = -1;
        }
      }

      if (lineText.trim()) {
        results.push({
          x: lineStartCol * 8,
          y: row * 8,
          charCol: lineStartCol,
          charRow: row,
          content: lineText.trim(),
        });
      }
    }

    return results;
  }

  private floodFill(
    changed: Uint8Array,
    visited: Uint8Array,
    startX: number,
    startY: number,
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    const stack: [number, number][] = [[startX, startY]];
    let minX = startX, maxX = startX, minY = startY, maxY = startY;

    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      const idx = y * DISPLAY_WIDTH + x;

      if (x < 0 || x >= DISPLAY_WIDTH || y < 0 || y >= DISPLAY_HEIGHT) continue;
      if (visited[idx] || !changed[idx]) continue;

      visited[idx] = 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    return { minX, minY, maxX, maxY };
  }

  private hashTile(pixels: Uint8ClampedArray): string {
    // Simple hash: sample R channel at key positions
    let hash = 0;
    for (let i = 0; i < pixels.length; i += 16) {
      hash = ((hash << 5) - hash + pixels[i]) | 0;
    }
    return hash.toString(36);
  }

  reset(): void {
    this.previousFrame = null;
    this.spriteIdCounter = 0;
  }
}
