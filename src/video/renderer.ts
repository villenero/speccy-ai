/**
 * Canvas 2D Renderer
 *
 * Renders the ULA framebuffer to an HTML canvas.
 * Supports native resolution (352x288 with borders) and scaled display.
 */

import { TOTAL_WIDTH, TOTAL_HEIGHT } from "../core/ula.js";

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private imageData: ImageData;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = TOTAL_WIDTH;
    this.canvas.height = TOTAL_HEIGHT;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to get 2D context");
    this.ctx = ctx;

    // Disable image smoothing for crisp pixels
    this.ctx.imageSmoothingEnabled = false;

    this.imageData = this.ctx.createImageData(TOTAL_WIDTH, TOTAL_HEIGHT);
  }

  /**
   * Draw the framebuffer to the canvas.
   */
  render(framebuffer: Uint8ClampedArray): void {
    this.imageData.data.set(framebuffer);
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  /**
   * Get the canvas element (for CSS scaling).
   */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Get the current frame as ImageData (for capture).
   */
  getImageData(): ImageData {
    return this.ctx.getImageData(0, 0, TOTAL_WIDTH, TOTAL_HEIGHT);
  }

  /**
   * Get the current frame as a PNG blob.
   */
  async toPNG(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Failed to create PNG"))),
        "image/png"
      );
    });
  }
}
