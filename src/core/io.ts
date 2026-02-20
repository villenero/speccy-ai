/**
 * ZX Spectrum 48K I/O Port Handler
 *
 * Port $FE (ULA): keyboard, border, beeper
 * Port $1F: Kempston joystick
 */

import { ULA } from "./ula.js";
import { Beeper } from "./beeper.js";

export class IO {
  private ula: ULA;
  private beeper: Beeper;

  // Keyboard: 8 half-rows, each a byte (bits 0-4 = keys, 0=pressed, 1=not)
  private keyboardState: Uint8Array = new Uint8Array(8).fill(0xFF);

  // Kempston joystick state (bits: 0=right, 1=left, 2=down, 3=up, 4=fire)
  private kempstonState = 0;

  // EAR input (bit 6 of port $FE reads) — for tape loading
  private earInput = 0;

  // Callbacks for capture/observation
  public onPortWrite?: (port: number, value: number, tstate: number) => void;

  constructor(ula: ULA, beeper: Beeper) {
    this.ula = ula;
    this.beeper = beeper;
  }

  /**
   * Read from an I/O port.
   */
  read(port: number): number {
    // ULA port: bit 0 of port address is 0
    if ((port & 0x01) === 0) {
      return this.readULA(port);
    }

    // Kempston joystick: port $1F
    if ((port & 0xFF) === 0x1F) {
      return this.kempstonState;
    }

    // Unattached port: return 0xFF (simplified; real hardware returns floating bus)
    return 0xFF;
  }

  /**
   * Write to an I/O port.
   */
  write(port: number, value: number, tstate: number): void {
    // ULA port: bit 0 of port address is 0
    if ((port & 0x01) === 0) {
      this.writeULA(value, tstate);
    }

    this.onPortWrite?.(port, value, tstate);
  }

  private readULA(port: number): number {
    // High byte selects keyboard half-rows (active low)
    const highByte = (port >> 8) & 0xFF;
    let result = 0xFF;

    for (let row = 0; row < 8; row++) {
      if ((highByte & (1 << row)) === 0) {
        result &= this.keyboardState[row];
      }
    }

    // Bit 5: always 1
    result |= 0x20;

    // Bit 6: EAR input
    if (this.earInput) {
      result &= ~0x40;
    } else {
      result |= 0x40;
    }

    // Bit 7: always 1
    result |= 0x80;

    return result;
  }

  private writeULA(value: number, tstate: number): void {
    // Bits 0-2: border color
    this.ula.setBorderColor(value & 0x07, tstate);

    // Bit 3: MIC output (tape out)
    // Bit 4: EAR/Speaker output
    this.beeper.setState((value >> 4) & 0x01, tstate);
  }

  /**
   * Set keyboard state for a half-row.
   * row: 0-7 (corresponding to A8-A15)
   * bit: 0-4 (key position in the row)
   * pressed: true if key is down
   */
  setKey(row: number, bit: number, pressed: boolean): void {
    if (pressed) {
      this.keyboardState[row] &= ~(1 << bit);
    } else {
      this.keyboardState[row] |= (1 << bit);
    }
  }

  /**
   * Set full keyboard state (8 bytes).
   */
  setKeyboardState(state: Uint8Array): void {
    this.keyboardState.set(state);
  }

  getKeyboardState(): Uint8Array {
    return new Uint8Array(this.keyboardState);
  }

  setKempstonState(state: number): void {
    this.kempstonState = state & 0x1F;
  }

  getKempstonState(): number {
    return this.kempstonState;
  }

  setEarInput(value: number): void {
    this.earInput = value;
  }

  reset(): void {
    this.keyboardState.fill(0xFF);
    this.kempstonState = 0;
    this.earInput = 0;
  }
}
