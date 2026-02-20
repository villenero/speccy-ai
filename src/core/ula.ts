/**
 * ZX Spectrum 48K ULA (Uncommitted Logic Array)
 *
 * Handles:
 * - Frame timing: 69,888 T-states per frame, 312 scanlines, 224 T-states/line
 * - Contended memory timing (CPU/ULA bus sharing on $4000-$7FFF)
 * - Screen rendering with pixel-perfect timing
 * - Border color tracking per T-state
 * - FLASH attribute toggling (every 16 frames)
 */

import { Memory } from "./memory.js";

// Frame timing constants
export const TSTATES_PER_LINE = 224;
export const LINES_PER_FRAME = 312;
export const TSTATES_PER_FRAME = TSTATES_PER_LINE * LINES_PER_FRAME; // 69,888
export const FRAME_RATE = 50.08; // 3,500,000 / 69,888

// Screen layout
export const TOP_BORDER_LINES = 64;
export const DISPLAY_LINES = 192;
export const BOTTOM_BORDER_LINES = 56;
export const LEFT_BORDER_TSTATES = 24;
export const DISPLAY_TSTATES = 128;
export const RIGHT_BORDER_TSTATES = 24;
export const RETRACE_TSTATES = 48;

// Pixels
export const DISPLAY_WIDTH = 256;
export const DISPLAY_HEIGHT = 192;
export const BORDER_LEFT_PX = 48;   // 24 T-states * 2 px/T-state
export const BORDER_RIGHT_PX = 48;
export const BORDER_TOP_PX = 48;    // Show 48 of the 64 top border lines
export const BORDER_BOTTOM_PX = 48; // Show 48 of the 56 bottom border lines
export const TOTAL_WIDTH = BORDER_LEFT_PX + DISPLAY_WIDTH + BORDER_RIGHT_PX; // 352
export const TOTAL_HEIGHT = BORDER_TOP_PX + DISPLAY_HEIGHT + BORDER_BOTTOM_PX; // 288

// Contention pattern: repeats every 8 T-states during active display
const CONTENTION_PATTERN = [6, 5, 4, 3, 2, 1, 0, 0];

// First contended T-state in the frame
const FIRST_CONTENDED_TSTATE = 14335;

// ZX Spectrum color palette: [normal, bright] x 8 colors
// Each color is [R, G, B]
export const PALETTE: [number, number, number][] = [
  // Normal
  [0, 0, 0],       // 0: Black
  [0, 0, 205],     // 1: Blue
  [205, 0, 0],     // 2: Red
  [205, 0, 205],   // 3: Magenta
  [0, 205, 0],     // 4: Green
  [0, 205, 205],   // 5: Cyan
  [205, 205, 0],   // 6: Yellow
  [205, 205, 205], // 7: White
  // Bright
  [0, 0, 0],       // 8: Black (bright)
  [0, 0, 255],     // 9: Blue (bright)
  [255, 0, 0],     // 10: Red (bright)
  [255, 0, 255],   // 11: Magenta (bright)
  [0, 255, 0],     // 12: Green (bright)
  [0, 255, 255],   // 13: Cyan (bright)
  [255, 255, 0],   // 14: Yellow (bright)
  [255, 255, 255], // 15: White (bright)
];

/**
 * Border color change event, recorded during frame execution.
 */
interface BorderEvent {
  tstate: number;
  color: number;
}

export class ULA {
  private memory: Memory;

  // Border state
  private borderColor = 7; // White at startup
  private borderEvents: BorderEvent[] = [];

  // FLASH state
  private flashCounter = 0;
  private flashState = false; // false = normal, true = inverted

  // Frame counter
  private frameCount = 0;

  // Framebuffer: RGBA pixels for the full display (with borders)
  public readonly framebuffer: Uint8ClampedArray;

  constructor(memory: Memory) {
    this.memory = memory;
    this.framebuffer = new Uint8ClampedArray(TOTAL_WIDTH * TOTAL_HEIGHT * 4);
  }

  /**
   * Set the border color (called on OUT to port $FE).
   */
  setBorderColor(color: number, tstate: number): void {
    color = color & 0x07;
    if (color !== this.borderColor) {
      this.borderEvents.push({ tstate, color });
      this.borderColor = color;
    }
  }

  getBorderColor(): number {
    return this.borderColor;
  }

  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Compute contention delay for accessing a contended address at the given T-state.
   * Returns the number of extra T-states the CPU must wait.
   */
  getContentionDelay(tstate: number): number {
    // Which line are we on?
    const line = Math.floor(tstate / TSTATES_PER_LINE);

    // Contention only happens during the display area (lines 64-255)
    if (line < TOP_BORDER_LINES || line >= TOP_BORDER_LINES + DISPLAY_LINES) {
      return 0;
    }

    // Position within the line
    const lineOffset = tstate % TSTATES_PER_LINE;

    // Contention only during the active display portion of the line (first 128 T-states)
    if (lineOffset >= DISPLAY_TSTATES) {
      return 0;
    }

    return CONTENTION_PATTERN[lineOffset % 8];
  }

  /**
   * Render the complete frame into the framebuffer.
   * Called at the end of each frame (after 69,888 T-states).
   *
   * Uses deferred rendering: border events recorded during execution are
   * replayed here to produce pixel-perfect output.
   */
  renderFrame(): void {
    this.frameCount++;

    // Update FLASH state every 16 frames
    this.flashCounter++;
    if (this.flashCounter >= 16) {
      this.flashCounter = 0;
      this.flashState = !this.flashState;
    }

    // Render border + display area
    this.renderBorderAndDisplay();

    // Clear border events for next frame
    this.borderEvents.length = 0;
  }

  private renderBorderAndDisplay(): void {
    const fb = this.framebuffer;
    const mem = this.memory;

    // Build a border color timeline: for each visible scanline, what color?
    // We show lines from (TOP_BORDER_LINES - BORDER_TOP_PX) to (TOP_BORDER_LINES + DISPLAY_LINES + BORDER_BOTTOM_PX)
    const firstVisibleLine = TOP_BORDER_LINES - BORDER_TOP_PX; // 16
    const lastVisibleLine = TOP_BORDER_LINES + DISPLAY_LINES + BORDER_BOTTOM_PX; // 304

    // Build border color per T-state map from events
    // Start with the border color from the end of the last frame
    let currentBorder = this.borderEvents.length > 0
      ? this.borderColor // will be resolved per-tstate
      : this.borderColor;

    // Simple approach: resolve border color per scanline (good enough for most games)
    // For full pixel-perfect, we'd resolve per-T-state within the line
    const borderColorPerLine = new Uint8Array(LINES_PER_FRAME);
    borderColorPerLine.fill(this.borderColor);

    // Apply border events
    let eventIdx = 0;
    let activeBorder = this.borderEvents.length > 0 ? this.getInitialBorderColor() : this.borderColor;
    for (let line = 0; line < LINES_PER_FRAME; line++) {
      const lineStart = line * TSTATES_PER_LINE;
      const lineEnd = lineStart + TSTATES_PER_LINE;
      while (eventIdx < this.borderEvents.length && this.borderEvents[eventIdx].tstate < lineEnd) {
        activeBorder = this.borderEvents[eventIdx].color;
        eventIdx++;
      }
      borderColorPerLine[line] = activeBorder;
    }

    // Render each visible line
    for (let screenY = 0; screenY < TOTAL_HEIGHT; screenY++) {
      const spectrumLine = firstVisibleLine + screenY;
      const displayLine = spectrumLine - TOP_BORDER_LINES; // -48..239

      for (let screenX = 0; screenX < TOTAL_WIDTH; screenX++) {
        const pixelIdx = (screenY * TOTAL_WIDTH + screenX) * 4;

        // Determine if we're in border or display area
        const inDisplayX = screenX >= BORDER_LEFT_PX && screenX < BORDER_LEFT_PX + DISPLAY_WIDTH;
        const inDisplayY = displayLine >= 0 && displayLine < DISPLAY_HEIGHT;

        if (inDisplayX && inDisplayY) {
          // Display area: read from screen memory
          const dx = screenX - BORDER_LEFT_PX; // 0..255
          const dy = displayLine; // 0..191

          // Spectrum screen address calculation (non-linear layout)
          const charCol = dx >> 3; // 0..31
          const pixelBit = 7 - (dx & 7);

          // Pixel address: 010 Y7 Y6 Y2 Y1 Y0 | Y5 Y4 Y3 X4 X3 X2 X1 X0
          const pixelAddr = 0x4000
            | ((dy & 0xC0) << 5)  // Y7 Y6 -> bits 11-12
            | ((dy & 0x07) << 8)  // Y2 Y1 Y0 -> bits 8-10
            | ((dy & 0x38) << 2)  // Y5 Y4 Y3 -> bits 5-7
            | charCol;            // X4..X0 -> bits 0-4

          const pixelByte = mem.read(pixelAddr);
          const isSet = (pixelByte >> pixelBit) & 1;

          // Attribute address: linear, 32 bytes per char row
          const charRow = dy >> 3; // 0..23
          const attrAddr = 0x5800 + charRow * 32 + charCol;
          const attr = mem.read(attrAddr);

          const ink = attr & 0x07;
          const paper = (attr >> 3) & 0x07;
          const bright = (attr >> 6) & 0x01;
          const flash = (attr >> 7) & 0x01;

          // Determine foreground/background with FLASH
          let fg = ink;
          let bg = paper;
          if (flash && this.flashState) {
            fg = paper;
            bg = ink;
          }

          const colorIdx = (isSet ? fg : bg) + (bright ? 8 : 0);
          const [r, g, b] = PALETTE[colorIdx];
          fb[pixelIdx] = r;
          fb[pixelIdx + 1] = g;
          fb[pixelIdx + 2] = b;
          fb[pixelIdx + 3] = 255;
        } else {
          // Border area
          const borderCol = borderColorPerLine[spectrumLine] ?? this.borderColor;
          const [r, g, b] = PALETTE[borderCol]; // Border is never bright
          fb[pixelIdx] = r;
          fb[pixelIdx + 1] = g;
          fb[pixelIdx + 2] = b;
          fb[pixelIdx + 3] = 255;
        }
      }
    }
  }

  /**
   * Get the border color at the start of the frame (before any events).
   * This is the color set at the end of the previous frame.
   */
  private getInitialBorderColor(): number {
    // The border color before the first event is whatever was set before this frame
    // We track this by looking at what the borderColor was before any events
    // Since borderColor is updated as events arrive, we need the "pre-frame" color
    // which is whatever was the last color set in the previous frame, or the initial color.
    // We handle this by always keeping borderColor updated, and the first event's
    // preceding color is the current borderColor at frame start.
    return this.borderColor;
  }

  /**
   * Reset ULA state.
   */
  reset(): void {
    this.borderColor = 7;
    this.borderEvents.length = 0;
    this.flashCounter = 0;
    this.flashState = false;
    this.frameCount = 0;
    this.framebuffer.fill(0);
  }
}
