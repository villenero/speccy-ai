/**
 * ZX Spectrum 48K Memory Map
 *
 * $0000-$3FFF  16KB ROM (read-only, not contended)
 * $4000-$57FF  Screen pixel data (6,144 bytes, contended)
 * $5800-$5AFF  Screen attributes (768 bytes, contended)
 * $5B00-$7FFF  Remaining contended RAM
 * $8000-$FFFF  32KB uncontended RAM
 */
export class Memory {
  private readonly data: Uint8Array;
  private romLoaded = false;

  constructor() {
    this.data = new Uint8Array(65536);
  }

  loadRom(rom: Uint8Array): void {
    if (rom.length !== 16384) {
      throw new Error(`ROM must be exactly 16384 bytes, got ${rom.length}`);
    }
    this.data.set(rom, 0x0000);
    this.romLoaded = true;
  }

  isRomLoaded(): boolean {
    return this.romLoaded;
  }

  read(address: number): number {
    return this.data[address & 0xFFFF];
  }

  write(address: number, value: number): void {
    address = address & 0xFFFF;
    // ROM is read-only
    if (address < 0x4000) return;
    this.data[address] = value;
  }

  /**
   * Direct read without ROM protection (for snapshots, debugging).
   */
  peek(address: number): number {
    return this.data[address & 0xFFFF];
  }

  /**
   * Direct write bypassing ROM protection (for snapshots).
   */
  poke(address: number, value: number): void {
    this.data[address & 0xFFFF] = value;
  }

  /**
   * Get a view of a memory range (zero-copy).
   */
  getRange(start: number, length: number): Uint8Array {
    return this.data.subarray(start, start + length);
  }

  /**
   * Get full RAM snapshot (copy).
   */
  getSnapshot(): Uint8Array {
    return new Uint8Array(this.data);
  }

  /**
   * Restore full RAM from snapshot.
   */
  restoreSnapshot(snapshot: Uint8Array): void {
    this.data.set(snapshot);
  }

  /**
   * Check if address is in contended memory range ($4000-$7FFF).
   */
  static isContended(address: number): boolean {
    return address >= 0x4000 && address <= 0x7FFF;
  }

  /**
   * Get screen pixel data ($4000-$57FF).
   */
  getScreenPixels(): Uint8Array {
    return this.data.subarray(0x4000, 0x5800);
  }

  /**
   * Get screen attributes ($5800-$5AFF).
   */
  getScreenAttrs(): Uint8Array {
    return this.data.subarray(0x5800, 0x5B00);
  }
}
