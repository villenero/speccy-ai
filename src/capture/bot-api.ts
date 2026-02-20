/**
 * Bot API — Programmatic interface for AI/bot control of the emulator
 *
 * Allows an external agent to:
 * - Load games, control input, advance frames
 * - Observe screen, memory, and registers
 * - Set breakpoints and watch memory addresses
 */

import { Spectrum } from "../core/spectrum.js";
import { FrameCapture, CapturedFrame } from "./frame-capture.js";
import { StateCapture, GameStateSnapshot } from "./state-snapshot.js";
import { MemoryWatch, GameVariable } from "./memory-watch.js";
import { InputRecorder, InputRecording } from "./input-recorder.js";
import { SpriteDetector, DetectedSprite, DetectedTile, DetectedText } from "./sprite-detector.js";
import { loadSNA } from "../formats/sna.js";
import { loadZ80 } from "../formats/z80format.js";

export class BotAPI {
  public readonly spectrum: Spectrum;
  public readonly frameCapture: FrameCapture;
  public readonly stateCapture: StateCapture;
  public readonly memoryWatch: MemoryWatch;
  public readonly inputRecorder: InputRecorder;
  public readonly spriteDetector: SpriteDetector;

  // Breakpoints: address → callback
  private breakpoints = new Map<number, () => void>();

  // Memory write watchers: address → callback
  private memoryWatchers = new Map<number, (value: number) => void>();

  // Frame callback
  public onFrame?: (state: GameStateSnapshot) => void;

  constructor(spectrum: Spectrum) {
    this.spectrum = spectrum;
    this.frameCapture = new FrameCapture(spectrum);
    this.stateCapture = new StateCapture(spectrum);
    this.memoryWatch = new MemoryWatch(spectrum);
    this.inputRecorder = new InputRecorder(spectrum);
    this.spriteDetector = new SpriteDetector();
  }

  // --- Game loading ---

  async loadRom(url: string): Promise<void> {
    await this.spectrum.loadRom(url);
  }

  loadSnapshot(data: Uint8Array, format: "sna" | "z80" = "sna"): void {
    if (format === "sna") {
      loadSNA(this.spectrum, data);
    } else {
      loadZ80(this.spectrum, data);
    }
  }

  // --- Execution ---

  /**
   * Advance one frame and return the state.
   */
  stepFrame(): GameStateSnapshot {
    this.spectrum.runFrame();
    const state = this.stateCapture.capture();
    this.onFrame?.(state);
    return state;
  }

  /**
   * Advance N frames, optionally capturing state at each.
   */
  runFrames(count: number, captureEach = false): GameStateSnapshot[] {
    const states: GameStateSnapshot[] = [];
    for (let i = 0; i < count; i++) {
      this.spectrum.runFrame();
      if (captureEach) {
        const state = this.stateCapture.capture();
        states.push(state);
        this.onFrame?.(state);
      }
    }
    if (!captureEach && count > 0) {
      const state = this.stateCapture.capture();
      this.onFrame?.(state);
    }
    return states;
  }

  /**
   * Run until PC reaches an address.
   */
  runUntilPC(address: number, maxFrames = 1000): number {
    return this.spectrum.runUntilPC(address, maxFrames * 69888);
  }

  // --- Input ---

  /**
   * Press Spectrum keys by name.
   * Names: "A"-"Z", "0"-"9", "ENTER", "SPACE", "CAPS", "SYM"
   */
  pressKeys(keys: string[]): void {
    for (const key of keys) {
      const mapping = this.resolveKey(key);
      if (mapping) {
        this.spectrum.io.setKey(mapping.row, mapping.bit, true);
      }
    }
  }

  releaseKeys(keys: string[]): void {
    for (const key of keys) {
      const mapping = this.resolveKey(key);
      if (mapping) {
        this.spectrum.io.setKey(mapping.row, mapping.bit, false);
      }
    }
  }

  releaseAll(): void {
    this.spectrum.io.reset();
  }

  setKempston(state: number): void {
    this.spectrum.io.setKempstonState(state);
  }

  // --- Observation ---

  getFrame(displayOnly = true): CapturedFrame {
    return this.frameCapture.captureCurrentFrame(displayOnly);
  }

  getMemory(start: number, length: number): Uint8Array {
    return this.stateCapture.readMemoryRange(start, length);
  }

  getRegisters() {
    return this.stateCapture.capture().registers;
  }

  readByte(address: number): number {
    return this.spectrum.memory.peek(address);
  }

  readWord(address: number): number {
    return this.spectrum.memory.peek(address) | (this.spectrum.memory.peek(address + 1) << 8);
  }

  // --- Variables ---

  addVariable(variable: GameVariable): void {
    this.memoryWatch.addVariable(variable);
  }

  readVariables(): Record<string, number> {
    return this.memoryWatch.readVariables();
  }

  searchValue(value: number): number[] {
    return this.memoryWatch.searchValue(value);
  }

  // --- Sprites & Vision ---

  detectSprites(): DetectedSprite[] {
    const frame = this.frameCapture.captureCurrentFrame(true);
    return this.spriteDetector.detectSprites(frame);
  }

  detectTiles(): DetectedTile[] {
    const frame = this.frameCapture.captureCurrentFrame(true);
    return this.spriteDetector.detectTiles(frame);
  }

  detectText(): DetectedText[] {
    const romCharset = this.spectrum.memory.getRange(0x3D00, 768);
    return this.spriteDetector.detectText(
      new Uint8Array(this.spectrum.memory.getScreenPixels()),
      new Uint8Array(this.spectrum.memory.getScreenAttrs()),
      new Uint8Array(romCharset),
    );
  }

  // --- Recording ---

  startRecording(gameName: string): void {
    this.inputRecorder.startRecording(gameName);
  }

  stopRecording(): InputRecording {
    return this.inputRecorder.stopRecording();
  }

  replay(recording: InputRecording, onFrame?: (frame: number) => void | boolean): number {
    return this.inputRecorder.replay(recording, onFrame);
  }

  // --- Key resolution ---

  private resolveKey(name: string): { row: number; bit: number } | null {
    const map: Record<string, { row: number; bit: number }> = {
      "CAPS": { row: 0, bit: 0 }, "Z": { row: 0, bit: 1 }, "X": { row: 0, bit: 2 },
      "C": { row: 0, bit: 3 }, "V": { row: 0, bit: 4 },
      "A": { row: 1, bit: 0 }, "S": { row: 1, bit: 1 }, "D": { row: 1, bit: 2 },
      "F": { row: 1, bit: 3 }, "G": { row: 1, bit: 4 },
      "Q": { row: 2, bit: 0 }, "W": { row: 2, bit: 1 }, "E": { row: 2, bit: 2 },
      "R": { row: 2, bit: 3 }, "T": { row: 2, bit: 4 },
      "1": { row: 3, bit: 0 }, "2": { row: 3, bit: 1 }, "3": { row: 3, bit: 2 },
      "4": { row: 3, bit: 3 }, "5": { row: 3, bit: 4 },
      "0": { row: 4, bit: 0 }, "9": { row: 4, bit: 1 }, "8": { row: 4, bit: 2 },
      "7": { row: 4, bit: 3 }, "6": { row: 4, bit: 4 },
      "P": { row: 5, bit: 0 }, "O": { row: 5, bit: 1 }, "I": { row: 5, bit: 2 },
      "U": { row: 5, bit: 3 }, "Y": { row: 5, bit: 4 },
      "ENTER": { row: 6, bit: 0 }, "L": { row: 6, bit: 1 }, "K": { row: 6, bit: 2 },
      "J": { row: 6, bit: 3 }, "H": { row: 6, bit: 4 },
      "SPACE": { row: 7, bit: 0 }, "SYM": { row: 7, bit: 1 }, "M": { row: 7, bit: 2 },
      "N": { row: 7, bit: 3 }, "B": { row: 7, bit: 4 },
    };
    return map[name.toUpperCase()] ?? null;
  }
}
