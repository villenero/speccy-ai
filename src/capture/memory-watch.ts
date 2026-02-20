/**
 * Memory Watch — Detect game variables by tracking RAM changes
 *
 * Techniques:
 * - Differential scan: compare RAM between frames
 * - Value search: find addresses containing a known value
 * - Write heatmap: track which addresses the CPU writes to
 */

import { Spectrum } from "../core/spectrum.js";

export interface MemoryChange {
  address: number;
  oldValue: number;
  newValue: number;
}

export interface GameVariable {
  name: string;
  address: number;
  size: 1 | 2;
  encoding: "binary" | "bcd";
  range?: [number, number]; // observed min/max
}

export class MemoryWatch {
  private spectrum: Spectrum;
  private previousRAM: Uint8Array | null = null;
  private candidates: Set<number> = new Set();
  private writeHeatmap: Uint32Array;

  // Tracked variables
  public variables: GameVariable[] = [];

  constructor(spectrum: Spectrum) {
    this.spectrum = spectrum;
    this.writeHeatmap = new Uint32Array(65536);
  }

  /**
   * Take a snapshot of RAM for differential comparison.
   */
  snapshotRAM(): void {
    this.previousRAM = this.spectrum.memory.getSnapshot();
  }

  /**
   * Compare current RAM with the previous snapshot.
   * Returns addresses that changed.
   */
  diff(): MemoryChange[] {
    if (!this.previousRAM) {
      throw new Error("No previous snapshot. Call snapshotRAM() first.");
    }

    const changes: MemoryChange[] = [];
    for (let addr = 0x4000; addr <= 0xFFFF; addr++) {
      const oldVal = this.previousRAM[addr];
      const newVal = this.spectrum.memory.peek(addr);
      if (oldVal !== newVal) {
        changes.push({ address: addr, oldValue: oldVal, newValue: newVal });
      }
    }
    return changes;
  }

  /**
   * Search for addresses containing a specific value.
   * If candidates exist (from a previous search), narrow them down.
   */
  searchValue(value: number, range?: { start: number; end: number }): number[] {
    const start = range?.start ?? 0x5B00; // Skip screen memory by default
    const end = range?.end ?? 0xFFFF;
    const results: number[] = [];

    if (this.candidates.size > 0) {
      // Narrow down existing candidates
      for (const addr of this.candidates) {
        if (this.spectrum.memory.peek(addr) === value) {
          results.push(addr);
        }
      }
      this.candidates = new Set(results);
    } else {
      // First search: scan full range
      for (let addr = start; addr <= end; addr++) {
        if (this.spectrum.memory.peek(addr) === value) {
          results.push(addr);
          this.candidates.add(addr);
        }
      }
    }

    return results;
  }

  /**
   * Search for a 16-bit value (little-endian).
   */
  searchValue16(value: number, range?: { start: number; end: number }): number[] {
    const start = range?.start ?? 0x5B00;
    const end = range?.end ?? 0xFFFE;
    const results: number[] = [];
    const lo = value & 0xFF;
    const hi = (value >> 8) & 0xFF;

    for (let addr = start; addr <= end; addr++) {
      if (this.spectrum.memory.peek(addr) === lo && this.spectrum.memory.peek(addr + 1) === hi) {
        results.push(addr);
      }
    }
    return results;
  }

  /**
   * Search for a BCD-encoded value. Common in Spectrum games for scores.
   * E.g., score 1234 stored as bytes [0x12, 0x34] or [0x00, 0x12, 0x34].
   */
  searchBCD(value: number, digits: number, range?: { start: number; end: number }): number[] {
    const start = range?.start ?? 0x5B00;
    const end = range?.end ?? 0xFFFF;
    const results: number[] = [];
    const bytes: number[] = [];

    // Convert to BCD bytes
    let v = value;
    const numBytes = Math.ceil(digits / 2);
    for (let i = numBytes - 1; i >= 0; i--) {
      bytes[i] = (v % 10) | (((Math.floor(v / 10)) % 10) << 4);
      v = Math.floor(v / 100);
    }

    for (let addr = start; addr <= end - numBytes + 1; addr++) {
      let match = true;
      for (let i = 0; i < numBytes; i++) {
        if (this.spectrum.memory.peek(addr + i) !== bytes[i]) {
          match = false;
          break;
        }
      }
      if (match) results.push(addr);
    }
    return results;
  }

  /**
   * Reset candidate list for a new search.
   */
  resetSearch(): void {
    this.candidates.clear();
  }

  /**
   * Track a memory write (call from I/O or memory hooks).
   */
  recordWrite(address: number): void {
    this.writeHeatmap[address]++;
  }

  /**
   * Get the top N most-written addresses (hotspots).
   * Useful for identifying game variables in the main loop.
   */
  getHotspots(topN = 50, minAddress = 0x5B00): { address: number; count: number }[] {
    const entries: { address: number; count: number }[] = [];
    for (let addr = minAddress; addr <= 0xFFFF; addr++) {
      if (this.writeHeatmap[addr] > 0) {
        entries.push({ address: addr, count: this.writeHeatmap[addr] });
      }
    }
    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, topN);
  }

  /**
   * Reset the write heatmap.
   */
  resetHeatmap(): void {
    this.writeHeatmap.fill(0);
  }

  /**
   * Register a named game variable for tracking.
   */
  addVariable(variable: GameVariable): void {
    this.variables.push(variable);
  }

  /**
   * Read all tracked variables' current values.
   */
  readVariables(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const v of this.variables) {
      if (v.encoding === "bcd") {
        let val = 0;
        for (let i = 0; i < v.size; i++) {
          const byte = this.spectrum.memory.peek(v.address + i);
          val = val * 100 + ((byte >> 4) * 10) + (byte & 0x0F);
        }
        result[v.name] = val;
      } else {
        if (v.size === 1) {
          result[v.name] = this.spectrum.memory.peek(v.address);
        } else {
          result[v.name] = this.spectrum.memory.peek(v.address) |
            (this.spectrum.memory.peek(v.address + 1) << 8);
        }
      }
    }
    return result;
  }

  /**
   * Export variable map as JSON.
   */
  exportVariableMap(): object {
    return {
      variables: this.variables.map(v => ({
        ...v,
        currentValue: this.readVariables()[v.name],
      })),
    };
  }
}
