/**
 * Element Picker — Click-to-inspect graphics tool
 *
 * Allows pausing the emulator and clicking on any visual element
 * to identify it (sprite, tile, character), search it in memory,
 * and add it to the capture gallery.
 */

import { Spectrum } from "../core/spectrum.js";
import {
  BORDER_LEFT_PX,
  BORDER_TOP_PX,
  TOTAL_WIDTH,
  TOTAL_HEIGHT,
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  PALETTE,
} from "../core/ula.js";

export interface MemoryMatch {
  address: number;
  region: "rom" | "screen" | "ram";
  inverted: boolean;
}

export interface PickedElement {
  charCol: number;
  charRow: number;
  widthCells: number;
  heightCells: number;
  pixelWidth: number;
  pixelHeight: number;
  bitmapBytes: Uint8Array;
  attrBytes: Uint8Array;
  rgbaPixels: Uint8ClampedArray;
  detectedAs: "char" | "sprite" | "region";
  matchedChar?: string;
  memoryMatches: MemoryMatch[];
  frameNumber: number;
}

export class ElementPicker {
  private spectrum: Spectrum;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private overlayCtx: CanvasRenderingContext2D;
  private active = false;
  private onPickCallback: ((el: PickedElement) => void) | null = null;

  // Drag state
  private dragging = false;
  private dragStartCol = -1;
  private dragStartRow = -1;
  private dragCurrentCol = -1;
  private dragCurrentRow = -1;

  // Bound handlers (for removeEventListener)
  private handleMouseMove: (e: MouseEvent) => void;
  private handleMouseDown: (e: MouseEvent) => void;
  private handleMouseUp: (e: MouseEvent) => void;
  private handleMouseLeave: () => void;

  constructor(
    spectrum: Spectrum,
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
  ) {
    this.spectrum = spectrum;
    this.canvas = canvas;
    this.overlay = overlay;
    this.overlayCtx = overlay.getContext("2d")!;

    this.handleMouseMove = this.onMouseMove.bind(this);
    this.handleMouseDown = this.onMouseDown.bind(this);
    this.handleMouseUp = this.onMouseUp.bind(this);
    this.handleMouseLeave = this.onMouseLeave.bind(this);
  }

  activate(onPick: (el: PickedElement) => void): void {
    if (this.active) return;
    this.active = true;
    this.onPickCallback = onPick;
    this.overlay.style.pointerEvents = "auto";
    this.overlay.style.cursor = "crosshair";
    this.overlay.addEventListener("mousemove", this.handleMouseMove);
    this.overlay.addEventListener("mousedown", this.handleMouseDown);
    this.overlay.addEventListener("mouseup", this.handleMouseUp);
    this.overlay.addEventListener("mouseleave", this.handleMouseLeave);
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.onPickCallback = null;
    this.dragging = false;
    this.overlay.style.pointerEvents = "none";
    this.overlay.style.cursor = "";
    this.overlay.removeEventListener("mousemove", this.handleMouseMove);
    this.overlay.removeEventListener("mousedown", this.handleMouseDown);
    this.overlay.removeEventListener("mouseup", this.handleMouseUp);
    this.overlay.removeEventListener("mouseleave", this.handleMouseLeave);
    this.clearOverlay();
  }

  isActive(): boolean {
    return this.active;
  }

  // --- Coordinate mapping ---

  private canvasToCell(
    clientX: number,
    clientY: number,
  ): { col: number; row: number } | null {
    const rect = this.overlay.getBoundingClientRect();
    const canvasX = (clientX - rect.left) * (this.overlay.width / rect.width);
    const canvasY = (clientY - rect.top) * (this.overlay.height / rect.height);

    const displayX = canvasX - BORDER_LEFT_PX;
    const displayY = canvasY - BORDER_TOP_PX;

    if (displayX < 0 || displayX >= DISPLAY_WIDTH || displayY < 0 || displayY >= DISPLAY_HEIGHT) {
      return null;
    }

    return {
      col: Math.floor(displayX / 8),
      row: Math.floor(displayY / 8),
    };
  }

  // --- Cell reading ---

  private readCellBitmap(col: number, row: number): Uint8Array {
    const screenPixels = this.spectrum.memory.getScreenPixels();
    const bitmap = new Uint8Array(8);
    for (let line = 0; line < 8; line++) {
      const y = row * 8 + line;
      const addr =
        ((y & 0xc0) << 5) |
        ((y & 0x07) << 8) |
        ((y & 0x38) << 2) |
        col;
      bitmap[line] = screenPixels[addr];
    }
    return bitmap;
  }

  private readCellAttr(col: number, row: number): number {
    return this.spectrum.memory.getScreenAttrs()[row * 32 + col];
  }

  private isCellBackground(col: number, row: number): boolean {
    const attr = this.readCellAttr(col, row);
    const ink = attr & 0x07;
    const paper = (attr >> 3) & 0x07;
    if (ink === paper) return true;

    const bitmap = this.readCellBitmap(col, row);
    let allZero = true;
    let allFF = true;
    for (let i = 0; i < 8; i++) {
      if (bitmap[i] !== 0x00) allZero = false;
      if (bitmap[i] !== 0xff) allFF = false;
    }
    return allZero || allFF;
  }

  // --- Flood-fill expansion ---

  /**
   * Check if two attributes are compatible for sprite grouping.
   * Matches on ink+paper+bright (ignores flash bit).
   */
  private attrCompatible(a: number, b: number): boolean {
    // Compare ink, paper, and bright (bits 0-6), ignore flash (bit 7)
    return (a & 0x7f) === (b & 0x7f);
  }

  private expandToSprite(
    startCol: number,
    startRow: number,
  ): { minCol: number; minRow: number; maxCol: number; maxRow: number } {
    const visited = new Uint8Array(32 * 24);
    const stack: [number, number][] = [[startCol, startRow]];
    const startAttr = this.readCellAttr(startCol, startRow);
    let minCol = startCol,
      maxCol = startCol,
      minRow = startRow,
      maxRow = startRow;
    let count = 0;
    const MAX_CELLS = 32;

    while (stack.length > 0) {
      const [c, r] = stack.pop()!;
      if (c < 0 || c >= 32 || r < 0 || r >= 24) continue;
      const idx = r * 32 + c;
      if (visited[idx]) continue;
      if (this.isCellBackground(c, r)) continue;
      // Only expand to cells with the same attribute (ink/paper/bright)
      if (!this.attrCompatible(this.readCellAttr(c, r), startAttr)) continue;

      visited[idx] = 1;
      count++;
      if (count > MAX_CELLS) break;

      minCol = Math.min(minCol, c);
      maxCol = Math.max(maxCol, c);
      minRow = Math.min(minRow, r);
      maxRow = Math.max(maxRow, r);

      stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
    }

    return { minCol, minRow, maxCol, maxRow };
  }

  // --- ROM character matching ---

  private matchROMChar(bitmap: Uint8Array): string | null {
    const rom = this.spectrum.memory.getRange(0x3d00, 96 * 8);

    for (let ch = 0; ch < 96; ch++) {
      const offset = ch * 8;
      let match = true;
      let matchInv = true;
      for (let i = 0; i < 8; i++) {
        if (bitmap[i] !== rom[offset + i]) match = false;
        if ((bitmap[i] ^ 0xff) !== rom[offset + i]) matchInv = false;
        if (!match && !matchInv) break;
      }
      if (match || matchInv) {
        return String.fromCharCode(ch + 32);
      }
    }
    return null;
  }

  // --- Memory pattern search ---

  private searchPattern(pattern: Uint8Array): MemoryMatch[] {
    const results: MemoryMatch[] = [];
    if (pattern.length === 0) return results;

    const inverted = new Uint8Array(pattern.length);
    for (let i = 0; i < pattern.length; i++) {
      inverted[i] = ~pattern[i] & 0xff;
    }

    const memSize = 65536;
    const pLen = pattern.length;
    const limit = memSize - pLen + 1;

    for (let addr = 0; addr < limit; addr++) {
      let matchNormal = true;
      let matchInverted = true;

      for (let j = 0; j < pLen; j++) {
        const b = this.spectrum.memory.peek(addr + j);
        if (b !== pattern[j]) matchNormal = false;
        if (b !== inverted[j]) matchInverted = false;
        if (!matchNormal && !matchInverted) break;
      }

      if (matchNormal || matchInverted) {
        let region: MemoryMatch["region"];
        if (addr < 0x4000) region = "rom";
        else if (addr < 0x5b00) region = "screen";
        else region = "ram";

        results.push({ address: addr, region, inverted: !matchNormal });
      }
    }

    return results;
  }

  // --- RGBA rendering ---

  private renderElementRGBA(
    minCol: number,
    minRow: number,
    widthCells: number,
    heightCells: number,
  ): Uint8ClampedArray {
    const w = widthCells * 8;
    const h = heightCells * 8;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const screenPixels = this.spectrum.memory.getScreenPixels();
    const screenAttrs = this.spectrum.memory.getScreenAttrs();

    for (let cr = 0; cr < heightCells; cr++) {
      for (let cc = 0; cc < widthCells; cc++) {
        const col = minCol + cc;
        const row = minRow + cr;
        const attr = screenAttrs[row * 32 + col];
        const ink = attr & 0x07;
        const paper = (attr >> 3) & 0x07;
        const bright = (attr >> 6) & 0x01;

        for (let line = 0; line < 8; line++) {
          const y = row * 8 + line;
          const addr =
            ((y & 0xc0) << 5) |
            ((y & 0x07) << 8) |
            ((y & 0x38) << 2) |
            col;
          const pixelByte = screenPixels[addr];

          for (let bit = 0; bit < 8; bit++) {
            const isSet = (pixelByte >> (7 - bit)) & 1;
            const colorIdx = (isSet ? ink : paper) + (bright ? 8 : 0);
            const [r, g, b] = PALETTE[colorIdx];

            const px = cc * 8 + bit;
            const py = cr * 8 + line;
            const idx = (py * w + px) * 4;
            rgba[idx] = r;
            rgba[idx + 1] = g;
            rgba[idx + 2] = b;
            rgba[idx + 3] = 255;
          }
        }
      }
    }

    return rgba;
  }

  // --- Build PickedElement ---

  private buildPickedElement(
    minCol: number,
    minRow: number,
    maxCol: number,
    maxRow: number,
  ): PickedElement {
    const widthCells = maxCol - minCol + 1;
    const heightCells = maxRow - minRow + 1;

    // Collect bitmap bytes: column-major (top-to-bottom, left-to-right)
    const bitmapBytes = new Uint8Array(widthCells * heightCells * 8);
    const attrBytes = new Uint8Array(widthCells * heightCells);

    let bIdx = 0;
    let aIdx = 0;
    for (let cc = 0; cc < widthCells; cc++) {
      for (let cr = 0; cr < heightCells; cr++) {
        const bitmap = this.readCellBitmap(minCol + cc, minRow + cr);
        bitmapBytes.set(bitmap, bIdx);
        bIdx += 8;
        attrBytes[aIdx++] = this.readCellAttr(minCol + cc, minRow + cr);
      }
    }

    const rgbaPixels = this.renderElementRGBA(minCol, minRow, widthCells, heightCells);

    // Determine type
    let detectedAs: PickedElement["detectedAs"];
    let matchedChar: string | undefined;

    if (widthCells === 1 && heightCells === 1) {
      const singleBitmap = this.readCellBitmap(minCol, minRow);
      matchedChar = this.matchROMChar(singleBitmap) ?? undefined;
      detectedAs = matchedChar ? "char" : "sprite";
    } else {
      detectedAs = "sprite";
    }

    // Search pattern in memory (linearize column-major for ZX standard layout)
    const memoryMatches = this.searchPattern(bitmapBytes);

    return {
      charCol: minCol,
      charRow: minRow,
      widthCells,
      heightCells,
      pixelWidth: widthCells * 8,
      pixelHeight: heightCells * 8,
      bitmapBytes,
      attrBytes,
      rgbaPixels,
      detectedAs,
      matchedChar,
      memoryMatches,
      frameNumber: this.spectrum.ula.getFrameCount(),
    };
  }

  // --- Overlay drawing ---

  private clearOverlay(): void {
    this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  private drawCellHighlight(col: number, row: number): void {
    this.clearOverlay();
    const x = BORDER_LEFT_PX + col * 8;
    const y = BORDER_TOP_PX + row * 8;
    this.overlayCtx.fillStyle = "rgba(80, 160, 255, 0.35)";
    this.overlayCtx.fillRect(x, y, 8, 8);
    this.overlayCtx.strokeStyle = "rgba(80, 160, 255, 0.8)";
    this.overlayCtx.lineWidth = 1;
    this.overlayCtx.strokeRect(x + 0.5, y + 0.5, 7, 7);
  }

  private drawBoundingBox(
    minCol: number,
    minRow: number,
    maxCol: number,
    maxRow: number,
    color = "rgba(255, 220, 50, 0.8)",
  ): void {
    const x = BORDER_LEFT_PX + minCol * 8;
    const y = BORDER_TOP_PX + minRow * 8;
    const w = (maxCol - minCol + 1) * 8;
    const h = (maxRow - minRow + 1) * 8;
    this.overlayCtx.strokeStyle = color;
    this.overlayCtx.lineWidth = 2;
    this.overlayCtx.strokeRect(x, y, w, h);
    this.overlayCtx.fillStyle = "rgba(255, 220, 50, 0.12)";
    this.overlayCtx.fillRect(x, y, w, h);
  }

  private drawDragRect(
    col1: number,
    row1: number,
    col2: number,
    row2: number,
  ): void {
    this.clearOverlay();
    const minC = Math.min(col1, col2);
    const maxC = Math.max(col1, col2);
    const minR = Math.min(row1, row2);
    const maxR = Math.max(row1, row2);
    const x = BORDER_LEFT_PX + minC * 8;
    const y = BORDER_TOP_PX + minR * 8;
    const w = (maxC - minC + 1) * 8;
    const h = (maxR - minR + 1) * 8;
    this.overlayCtx.strokeStyle = "rgba(80, 160, 255, 0.8)";
    this.overlayCtx.lineWidth = 2;
    this.overlayCtx.strokeRect(x, y, w, h);
    this.overlayCtx.fillStyle = "rgba(80, 160, 255, 0.15)";
    this.overlayCtx.fillRect(x, y, w, h);
  }

  // --- Mouse handlers ---

  private onMouseMove(e: MouseEvent): void {
    const cell = this.canvasToCell(e.clientX, e.clientY);
    if (!cell) {
      this.clearOverlay();
      return;
    }

    if (this.dragging) {
      this.dragCurrentCol = cell.col;
      this.dragCurrentRow = cell.row;
      this.drawDragRect(this.dragStartCol, this.dragStartRow, cell.col, cell.row);
    } else {
      this.drawCellHighlight(cell.col, cell.row);
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const cell = this.canvasToCell(e.clientX, e.clientY);
    if (!cell) return;

    this.dragging = true;
    this.dragStartCol = cell.col;
    this.dragStartRow = cell.row;
    this.dragCurrentCol = cell.col;
    this.dragCurrentRow = cell.row;
    e.preventDefault();
  }

  private onMouseUp(e: MouseEvent): void {
    if (!this.dragging) return;
    this.dragging = false;

    const cell = this.canvasToCell(e.clientX, e.clientY);
    const endCol = cell ? cell.col : this.dragCurrentCol;
    const endRow = cell ? cell.row : this.dragCurrentRow;

    const sameCell =
      this.dragStartCol === endCol && this.dragStartRow === endRow;

    let minCol: number, minRow: number, maxCol: number, maxRow: number;

    if (sameCell) {
      // Single click: expand via flood-fill
      if (this.isCellBackground(this.dragStartCol, this.dragStartRow)) {
        // Clicked on background — just pick the single cell
        minCol = maxCol = this.dragStartCol;
        minRow = maxRow = this.dragStartRow;
      } else {
        const expanded = this.expandToSprite(this.dragStartCol, this.dragStartRow);
        minCol = expanded.minCol;
        minRow = expanded.minRow;
        maxCol = expanded.maxCol;
        maxRow = expanded.maxRow;
      }
    } else {
      // Drag selection: snap to cell grid
      minCol = Math.min(this.dragStartCol, endCol);
      maxCol = Math.max(this.dragStartCol, endCol);
      minRow = Math.min(this.dragStartRow, endRow);
      maxRow = Math.max(this.dragStartRow, endRow);
    }

    // Show bounding box
    this.clearOverlay();
    this.drawBoundingBox(minCol, minRow, maxCol, maxRow);

    // Build and emit the picked element
    const element = this.buildPickedElement(minCol, minRow, maxCol, maxRow);

    if (!sameCell) {
      element.detectedAs = "region";
    }

    this.onPickCallback?.(element);
  }

  private onMouseLeave(): void {
    if (!this.dragging) {
      this.clearOverlay();
    }
  }
}
