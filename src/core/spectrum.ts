/**
 * ZX Spectrum 48K — Main emulator class
 *
 * Ties together: Z80 CPU, Memory, ULA, I/O, Beeper.
 * Implements the Hal interface required by the Z80 core.
 */

import { Z80, RegisterSet } from "./z80/index.js";
import type { Hal } from "./z80/index.js";
import { Memory } from "./memory.js";
import { ULA, TSTATES_PER_FRAME } from "./ula.js";
import { IO } from "./io.js";
import { Beeper } from "./beeper.js";

export class Spectrum implements Hal {
  public readonly cpu: Z80;
  public readonly memory: Memory;
  public readonly ula: ULA;
  public readonly io: IO;
  public readonly beeper: Beeper;

  // Hal: T-state counter for the current frame
  public tStateCount = 0;

  // Frame callbacks
  public onFrameComplete?: (frameNumber: number) => void;

  constructor(sampleRate = 48000) {
    this.memory = new Memory();
    this.ula = new ULA(this.memory);
    this.beeper = new Beeper(sampleRate);
    this.io = new IO(this.ula, this.beeper);
    this.cpu = new Z80(this);
  }

  /**
   * Load a ROM into memory.
   */
  async loadRom(url: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ROM: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    this.memory.loadRom(new Uint8Array(buffer));
  }

  /**
   * Load ROM from a Uint8Array.
   */
  loadRomData(data: Uint8Array): void {
    this.memory.loadRom(data);
  }

  /**
   * Run one complete frame (69,888 T-states).
   * Returns the frame number.
   */
  runFrame(): number {
    this.tStateCount = 0;

    // Fire maskable interrupt at the start of the frame
    this.cpu.maskableInterrupt();

    // Execute instructions until we've used up the frame's T-states
    while (this.tStateCount < TSTATES_PER_FRAME) {
      this.cpu.step();
    }

    // Render the frame
    this.ula.renderFrame();

    // Generate audio samples
    this.beeper.generateSamples();

    const frame = this.ula.getFrameCount();
    this.onFrameComplete?.(frame);

    return frame;
  }

  /**
   * Run N frames. Returns the final frame number.
   * Useful for headless/turbo mode.
   */
  runFrames(count: number): number {
    let frame = 0;
    for (let i = 0; i < count; i++) {
      frame = this.runFrame();
    }
    return frame;
  }

  /**
   * Run until PC reaches a specific address (breakpoint).
   * Returns the number of T-states executed.
   * Safety limit to prevent infinite loops.
   */
  runUntilPC(address: number, maxTstates = TSTATES_PER_FRAME * 1000): number {
    let total = 0;
    while (this.cpu.regs.pc !== address && total < maxTstates) {
      this.cpu.step();
      total = this.tStateCount;
      // Handle frame boundaries
      if (this.tStateCount >= TSTATES_PER_FRAME) {
        this.ula.renderFrame();
        this.beeper.generateSamples();
        this.tStateCount -= TSTATES_PER_FRAME;
        this.cpu.maskableInterrupt();
      }
    }
    return total;
  }

  // --- Hal interface implementation ---

  readMemory(address: number): number {
    return this.memory.read(address);
  }

  writeMemory(address: number, value: number): void {
    this.memory.write(address, value);
  }

  contendMemory(address: number): void {
    if (Memory.isContended(address)) {
      const delay = this.ula.getContentionDelay(this.tStateCount);
      this.tStateCount += delay;
    }
  }

  readPort(address: number): number {
    // Apply I/O contention
    this.applyIOContention(address);
    return this.io.read(address);
  }

  writePort(address: number, value: number): void {
    // Apply I/O contention
    this.applyIOContention(address);
    this.io.write(address, value, this.tStateCount);
  }

  contendPort(address: number): void {
    // Contention is handled in readPort/writePort
  }

  /**
   * Apply I/O contention based on the 4-case table:
   * - High byte contended + ULA port: C:1, C:3
   * - High byte contended + non-ULA: C:1, C:1, C:1, C:1
   * - High byte not contended + ULA: N:1, C:3
   * - High byte not contended + non-ULA: N:4
   */
  private applyIOContention(port: number): void {
    const highByte = (port >> 8) & 0xFF;
    const isULA = (port & 0x01) === 0;
    const isContended = highByte >= 0x40 && highByte <= 0x7F;

    if (isContended && isULA) {
      // C:1, C:3
      this.tStateCount += this.ula.getContentionDelay(this.tStateCount);
    } else if (isContended && !isULA) {
      // C:1, C:1, C:1, C:1
      for (let i = 0; i < 4; i++) {
        this.tStateCount += this.ula.getContentionDelay(this.tStateCount);
      }
    }
    // Non-contended ports: no extra delay
  }

  // --- State management ---

  getRegisters(): RegisterSet {
    return this.cpu.regs.clone();
  }

  reset(): void {
    this.cpu.reset();
    this.ula.reset();
    this.beeper.reset();
    this.io.reset();
    this.tStateCount = 0;
  }
}
