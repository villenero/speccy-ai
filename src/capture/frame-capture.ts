/**
 * Frame Capture — Extract frames from the emulator
 *
 * Supports:
 * - Single frame capture as PNG blob or raw RGBA
 * - Bulk capture (N frames at turbo speed)
 * - Display-only (256x192) or full (352x288 with borders)
 */

import { Spectrum } from "../core/spectrum.js";
import { TOTAL_WIDTH, TOTAL_HEIGHT, DISPLAY_WIDTH, DISPLAY_HEIGHT, BORDER_LEFT_PX, BORDER_TOP_PX } from "../core/ula.js";

export interface CapturedFrame {
  frameNumber: number;
  timestamp: number;       // Seconds since start (frameNumber / 50.08)
  pixels: Uint8ClampedArray; // RGBA data
  width: number;
  height: number;
  borderColor: number;
}

export class FrameCapture {
  private spectrum: Spectrum;

  constructor(spectrum: Spectrum) {
    this.spectrum = spectrum;
  }

  /**
   * Capture the current frame (after renderFrame has been called).
   */
  captureCurrentFrame(displayOnly = false): CapturedFrame {
    const frameNumber = this.spectrum.ula.getFrameCount();

    if (displayOnly) {
      return {
        frameNumber,
        timestamp: frameNumber / 50.08,
        pixels: this.extractDisplayArea(),
        width: DISPLAY_WIDTH,
        height: DISPLAY_HEIGHT,
        borderColor: this.spectrum.ula.getBorderColor(),
      };
    }

    return {
      frameNumber,
      timestamp: frameNumber / 50.08,
      pixels: new Uint8ClampedArray(this.spectrum.ula.framebuffer),
      width: TOTAL_WIDTH,
      height: TOTAL_HEIGHT,
      borderColor: this.spectrum.ula.getBorderColor(),
    };
  }

  /**
   * Run N frames at turbo speed (no audio, no render delay) and capture each.
   * Optional: only capture every Nth frame (stride).
   */
  captureFrames(count: number, stride = 1, displayOnly = false): CapturedFrame[] {
    const frames: CapturedFrame[] = [];

    for (let i = 0; i < count; i++) {
      this.spectrum.runFrame();
      if (i % stride === 0) {
        frames.push(this.captureCurrentFrame(displayOnly));
      }
    }

    return frames;
  }

  /**
   * Run frames and call a callback for each, avoiding storing all in memory.
   * Returns the number of frames processed.
   */
  captureStream(
    count: number,
    callback: (frame: CapturedFrame) => void | boolean, // return false to stop
    stride = 1,
    displayOnly = false,
  ): number {
    let processed = 0;
    for (let i = 0; i < count; i++) {
      this.spectrum.runFrame();
      if (i % stride === 0) {
        const result = callback(this.captureCurrentFrame(displayOnly));
        processed++;
        if (result === false) break;
      }
    }
    return processed;
  }

  /**
   * Extract only the 256x192 display area from the full framebuffer.
   */
  private extractDisplayArea(): Uint8ClampedArray {
    const fb = this.spectrum.ula.framebuffer;
    const display = new Uint8ClampedArray(DISPLAY_WIDTH * DISPLAY_HEIGHT * 4);

    for (let y = 0; y < DISPLAY_HEIGHT; y++) {
      const srcOffset = ((BORDER_TOP_PX + y) * TOTAL_WIDTH + BORDER_LEFT_PX) * 4;
      const dstOffset = y * DISPLAY_WIDTH * 4;
      display.set(fb.subarray(srcOffset, srcOffset + DISPLAY_WIDTH * 4), dstOffset);
    }

    return display;
  }

  /**
   * Convert captured frame to a canvas for PNG export.
   */
  static frameToCanvas(frame: CapturedFrame): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d")!;
    const data = new Uint8ClampedArray(frame.width * frame.height * 4);
    data.set(frame.pixels);
    const imageData = new ImageData(data, frame.width, frame.height);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * Convert captured frame to PNG blob.
   */
  static async frameToPNG(frame: CapturedFrame): Promise<Blob> {
    const canvas = FrameCapture.frameToCanvas(frame);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("Failed to create PNG")),
        "image/png"
      );
    });
  }
}
