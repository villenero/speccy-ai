/**
 * Tape Manager — ROM trap-based instant tape loading
 *
 * Intercepts execution at LD-BYTES ($0556) to load tape blocks
 * directly into memory instead of simulating real audio playback.
 *
 * When a TAP/TZX file is loaded:
 * 1. The Spectrum is reset and BASIC boots (~100 frames)
 * 2. The LOAD "" command is injected into the BASIC editor line
 * 3. ENTER is simulated so the ROM executes LOAD
 * 4. When PC reaches $0556, this manager intercepts and copies data
 */

import { Spectrum } from "./spectrum.js";
import { TapBlock, parseTAP } from "../formats/tap.js";
import { parseTZX } from "../formats/tzx.js";

const LD_BYTES_ADDR = 0x0556;

// Spectrum 48K system variables
const ELINE = 0x5c59; // Address of the edit line (2-byte pointer)

// BASIC tokens
const TOKEN_LOAD = 0xef;
const CHAR_QUOTE = 0x22;
const CHAR_ENTER = 0x0d;

export class TapeManager {
  private spectrum: Spectrum;
  private blocks: TapBlock[] = [];
  private currentBlock = 0;
  private active = false;

  constructor(spectrum: Spectrum) {
    this.spectrum = spectrum;
    // Register the trap hook
    spectrum.onBeforeStep = () => this.checkTrap();
  }

  /** Load a tape (TAP or TZX), parse blocks */
  load(data: Uint8Array, format: "tap" | "tzx"): void {
    this.blocks = format === "tap" ? parseTAP(data) : parseTZX(data);
    this.currentBlock = 0;
    this.active = true;
    console.log(`[tape] Loaded ${this.blocks.length} blocks (${format.toUpperCase()})`);
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      console.log(`[tape]   Block ${i}: flag=0x${b.flag.toString(16).padStart(2, "0")}, ${b.data.length} bytes`);
    }
  }

  /** Whether the tape is loaded and active */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Check if PC is at LD-BYTES and execute the trap.
   * Returns true if the trap was executed (caller should skip cpu.step).
   */
  checkTrap(): boolean {
    if (!this.active || this.currentBlock >= this.blocks.length) return false;
    if (this.spectrum.cpu.regs.pc !== LD_BYTES_ADDR) return false;

    const regs = this.spectrum.cpu.regs;

    // Read registers: A = expected flag, CF = LOAD(1)/VERIFY(0)
    const expectedFlag = regs.a;
    const carry = regs.f & 0x01;
    let ix = regs.ix;
    const de = regs.de;

    if (!carry) {
      // VERIFY: simulate success, advance block
      console.log(`[tape] VERIFY block ${this.currentBlock} — simulating success`);
      this.findNextBlock(expectedFlag);
      this.setSuccess();
      return true;
    }

    // Find matching block
    const block = this.findNextBlock(expectedFlag);
    if (!block) {
      console.warn(`[tape] No block found with flag 0x${expectedFlag.toString(16).padStart(2, "0")}`);
      this.setError();
      return true;
    }

    // Copy data to memory
    const len = Math.min(de, block.data.length);
    console.log(`[tape] Loading block: flag=0x${block.flag.toString(16).padStart(2, "0")}, ${len} bytes → $${ix.toString(16).padStart(4, "0")}`);

    for (let i = 0; i < len; i++) {
      this.spectrum.memory.write(ix, block.data[i]);
      ix = (ix + 1) & 0xffff;
    }

    // Update IX and DE to reflect bytes loaded
    regs.ix = ix;
    regs.de = (de - len) & 0xffff;

    this.setSuccess();
    return true;
  }

  /** Eject tape / reset state */
  eject(): void {
    this.blocks = [];
    this.currentBlock = 0;
    this.active = false;
  }

  /**
   * Inject LOAD "" command into BASIC and simulate ENTER.
   * Must be called after BASIC is initialized (~100 frames after reset).
   */
  injectLoadCommand(): void {
    const mem = this.spectrum.memory;

    // Read E-LINE pointer — this is where the edit line starts
    const eline = mem.read(ELINE) | (mem.read(ELINE + 1) << 8);

    // Write tokenized LOAD "" at the edit line
    // Format: LOAD token, quote, quote, ENTER
    mem.write(eline, TOKEN_LOAD);
    mem.write(eline + 1, CHAR_QUOTE);
    mem.write(eline + 2, CHAR_QUOTE);
    mem.write(eline + 3, CHAR_ENTER);

    // Simulate ENTER key press (row 6, bit 0)
    this.spectrum.io.setKey(6, 0, true);
  }

  /** Release the ENTER key after a few frames */
  releaseEnter(): void {
    this.spectrum.io.setKey(6, 0, false);
  }

  // --- Private helpers ---

  /**
   * Find the next block whose flag matches expectedFlag.
   * Advances currentBlock past the found block.
   */
  private findNextBlock(expectedFlag: number): TapBlock | null {
    while (this.currentBlock < this.blocks.length) {
      const block = this.blocks[this.currentBlock];
      this.currentBlock++;
      if (block.flag === expectedFlag) {
        return block;
      }
    }
    return null;
  }

  /** Set carry flag = 1 (success), pop return address, set PC */
  private setSuccess(): void {
    const regs = this.spectrum.cpu.regs;
    // Set carry flag
    regs.f = (regs.f | 0x01) & ~0x02; // CF=1, N=0
    // Pop return address from stack
    const retLo = this.spectrum.memory.read(regs.sp);
    const retHi = this.spectrum.memory.read((regs.sp + 1) & 0xffff);
    regs.sp = (regs.sp + 2) & 0xffff;
    regs.pc = (retHi << 8) | retLo;
    // Advance t-states to avoid infinite loop in the frame
    this.spectrum.tStateCount += 100;
  }

  /** Set carry flag = 0 (error), pop return address, set PC */
  private setError(): void {
    const regs = this.spectrum.cpu.regs;
    // Clear carry flag
    regs.f = regs.f & ~0x01;
    // Pop return address from stack
    const retLo = this.spectrum.memory.read(regs.sp);
    const retHi = this.spectrum.memory.read((regs.sp + 1) & 0xffff);
    regs.sp = (regs.sp + 2) & 0xffff;
    regs.pc = (retHi << 8) | retLo;
    this.spectrum.tStateCount += 100;
  }
}
