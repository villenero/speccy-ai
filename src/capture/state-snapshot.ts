/**
 * State Snapshot — Full emulator state capture for AI analysis
 *
 * Captures CPU registers, relevant RAM ranges, input state,
 * and screen data in a structured format.
 */

import { Spectrum } from "../core/spectrum.js";

export interface GameStateSnapshot {
  frame: number;
  timestamp: number;

  // CPU registers
  registers: {
    AF: number; BC: number; DE: number; HL: number;
    IX: number; IY: number; SP: number; PC: number;
    AF_: number; BC_: number; DE_: number; HL_: number;
    I: number; R: number;
    IM: number; IFF1: number; IFF2: number;
  };

  // Screen memory
  screenPixels: Uint8Array;  // $4000-$57FF (6144 bytes)
  screenAttrs: Uint8Array;   // $5800-$5AFF (768 bytes)

  // Optional: custom RAM range
  gameRAM?: Uint8Array;
  gameRAMStart?: number;

  // Input
  keysPressed: number[];     // 8 half-row bytes
  kempston: number;

  // ULA state
  borderColor: number;
  beeperLevel: number;
}

export class StateCapture {
  private spectrum: Spectrum;
  private gameRAMStart = 0x8000;
  private gameRAMLength = 0x4000; // 16KB by default

  constructor(spectrum: Spectrum) {
    this.spectrum = spectrum;
  }

  /**
   * Set the RAM range to capture for game variables.
   */
  setGameRAMRange(start: number, length: number): void {
    this.gameRAMStart = start;
    this.gameRAMLength = length;
  }

  /**
   * Capture complete state snapshot.
   */
  capture(includeGameRAM = true): GameStateSnapshot {
    const regs = this.spectrum.cpu.regs;
    const frame = this.spectrum.ula.getFrameCount();

    const snapshot: GameStateSnapshot = {
      frame,
      timestamp: frame / 50.08,
      registers: {
        AF: regs.af, BC: regs.bc, DE: regs.de, HL: regs.hl,
        IX: regs.ix, IY: regs.iy, SP: regs.sp, PC: regs.pc,
        AF_: regs.afPrime, BC_: regs.bcPrime, DE_: regs.dePrime, HL_: regs.hlPrime,
        I: regs.i, R: regs.r,
        IM: regs.im, IFF1: regs.iff1, IFF2: regs.iff2,
      },
      screenPixels: new Uint8Array(this.spectrum.memory.getScreenPixels()),
      screenAttrs: new Uint8Array(this.spectrum.memory.getScreenAttrs()),
      keysPressed: Array.from(this.spectrum.io.getKeyboardState()),
      kempston: this.spectrum.io.getKempstonState(),
      borderColor: this.spectrum.ula.getBorderColor(),
      beeperLevel: this.spectrum.beeper.getLevel(),
    };

    if (includeGameRAM) {
      snapshot.gameRAM = new Uint8Array(
        this.spectrum.memory.getRange(this.gameRAMStart, this.gameRAMLength)
      );
      snapshot.gameRAMStart = this.gameRAMStart;
    }

    return snapshot;
  }

  /**
   * Read a specific memory address.
   */
  readMemory(address: number): number {
    return this.spectrum.memory.peek(address);
  }

  /**
   * Read a range of memory.
   */
  readMemoryRange(start: number, length: number): Uint8Array {
    return new Uint8Array(this.spectrum.memory.getRange(start, length));
  }

  /**
   * Export snapshot as JSON-serializable object.
   */
  toJSON(snapshot: GameStateSnapshot): object {
    return {
      ...snapshot,
      screenPixels: Array.from(snapshot.screenPixels),
      screenAttrs: Array.from(snapshot.screenAttrs),
      gameRAM: snapshot.gameRAM ? Array.from(snapshot.gameRAM) : undefined,
    };
  }
}
