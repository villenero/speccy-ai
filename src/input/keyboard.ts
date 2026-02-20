/**
 * Keyboard mapping: PC keys → ZX Spectrum keyboard matrix
 *
 * The Spectrum has an 8x5 matrix read via port $FE.
 * Each half-row is selected by one of the address lines A8-A15.
 *
 * Row 0 ($FEFE / A8):  CAPS_SHIFT, Z, X, C, V
 * Row 1 ($FDFE / A9):  A, S, D, F, G
 * Row 2 ($FBFE / A10): Q, W, E, R, T
 * Row 3 ($F7FE / A11): 1, 2, 3, 4, 5
 * Row 4 ($EFFE / A12): 0, 9, 8, 7, 6
 * Row 5 ($DFFE / A13): P, O, I, U, Y
 * Row 6 ($BFFE / A14): ENTER, L, K, J, H
 * Row 7 ($7FFE / A15): SPACE, SYM_SHIFT, M, N, B
 */

export interface SpectrumKey {
  row: number;
  bit: number;
}

// Map of PC KeyboardEvent.code → Spectrum key(s)
// Some PC keys map to Spectrum key combinations (e.g., Backspace = CAPS + 0)
const KEY_MAP: Record<string, SpectrumKey[]> = {
  // Row 0: CAPS, Z, X, C, V
  "ShiftLeft":    [{ row: 0, bit: 0 }], // CAPS SHIFT
  "ShiftRight":   [{ row: 0, bit: 0 }], // CAPS SHIFT
  "KeyZ":         [{ row: 0, bit: 1 }],
  "KeyX":         [{ row: 0, bit: 2 }],
  "KeyC":         [{ row: 0, bit: 3 }],
  "KeyV":         [{ row: 0, bit: 4 }],

  // Row 1: A, S, D, F, G
  "KeyA":         [{ row: 1, bit: 0 }],
  "KeyS":         [{ row: 1, bit: 1 }],
  "KeyD":         [{ row: 1, bit: 2 }],
  "KeyF":         [{ row: 1, bit: 3 }],
  "KeyG":         [{ row: 1, bit: 4 }],

  // Row 2: Q, W, E, R, T
  "KeyQ":         [{ row: 2, bit: 0 }],
  "KeyW":         [{ row: 2, bit: 1 }],
  "KeyE":         [{ row: 2, bit: 2 }],
  "KeyR":         [{ row: 2, bit: 3 }],
  "KeyT":         [{ row: 2, bit: 4 }],

  // Row 3: 1, 2, 3, 4, 5
  "Digit1":       [{ row: 3, bit: 0 }],
  "Digit2":       [{ row: 3, bit: 1 }],
  "Digit3":       [{ row: 3, bit: 2 }],
  "Digit4":       [{ row: 3, bit: 3 }],
  "Digit5":       [{ row: 3, bit: 4 }],

  // Row 4: 0, 9, 8, 7, 6
  "Digit0":       [{ row: 4, bit: 0 }],
  "Digit9":       [{ row: 4, bit: 1 }],
  "Digit8":       [{ row: 4, bit: 2 }],
  "Digit7":       [{ row: 4, bit: 3 }],
  "Digit6":       [{ row: 4, bit: 4 }],

  // Row 5: P, O, I, U, Y
  "KeyP":         [{ row: 5, bit: 0 }],
  "KeyO":         [{ row: 5, bit: 1 }],
  "KeyI":         [{ row: 5, bit: 2 }],
  "KeyU":         [{ row: 5, bit: 3 }],
  "KeyY":         [{ row: 5, bit: 4 }],

  // Row 6: ENTER, L, K, J, H
  "Enter":        [{ row: 6, bit: 0 }],
  "KeyL":         [{ row: 6, bit: 1 }],
  "KeyK":         [{ row: 6, bit: 2 }],
  "KeyJ":         [{ row: 6, bit: 3 }],
  "KeyH":         [{ row: 6, bit: 4 }],

  // Row 7: SPACE, SYM_SHIFT, M, N, B
  "Space":        [{ row: 7, bit: 0 }],
  "ControlLeft":  [{ row: 7, bit: 1 }], // SYM SHIFT
  "ControlRight": [{ row: 7, bit: 1 }], // SYM SHIFT
  "KeyM":         [{ row: 7, bit: 2 }],
  "KeyN":         [{ row: 7, bit: 3 }],
  "KeyB":         [{ row: 7, bit: 4 }],

  // Convenience mappings (PC keys → Spectrum combinations)
  "Backspace":    [{ row: 0, bit: 0 }, { row: 4, bit: 0 }], // CAPS + 0 = DELETE
  "ArrowLeft":    [{ row: 0, bit: 0 }, { row: 3, bit: 4 }], // CAPS + 5
  "ArrowDown":    [{ row: 0, bit: 0 }, { row: 4, bit: 4 }], // CAPS + 6
  "ArrowUp":      [{ row: 0, bit: 0 }, { row: 4, bit: 3 }], // CAPS + 7
  "ArrowRight":   [{ row: 0, bit: 0 }, { row: 4, bit: 2 }], // CAPS + 8
  "CapsLock":     [{ row: 0, bit: 0 }, { row: 3, bit: 1 }], // CAPS + 2 = CAPS LOCK
};

export type KeyCallback = (row: number, bit: number, pressed: boolean) => void;

export class Keyboard {
  private callback: KeyCallback;
  private pressedKeys = new Set<string>();

  constructor(callback: KeyCallback) {
    this.callback = callback;
  }

  /**
   * Attach keyboard event listeners to an element (usually document).
   */
  attach(target: EventTarget = document): void {
    target.addEventListener("keydown", this.handleKeyDown as EventListener);
    target.addEventListener("keyup", this.handleKeyUp as EventListener);
  }

  detach(target: EventTarget = document): void {
    target.removeEventListener("keydown", this.handleKeyDown as EventListener);
    target.removeEventListener("keyup", this.handleKeyUp as EventListener);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const keys = KEY_MAP[e.code];
    if (keys) {
      e.preventDefault();
      if (!this.pressedKeys.has(e.code)) {
        this.pressedKeys.add(e.code);
        for (const key of keys) {
          this.callback(key.row, key.bit, true);
        }
      }
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    const keys = KEY_MAP[e.code];
    if (keys) {
      e.preventDefault();
      this.pressedKeys.delete(e.code);
      for (const key of keys) {
        this.callback(key.row, key.bit, false);
      }
    }
  };

  /**
   * Programmatic key press (for bot API).
   */
  pressKey(code: string): void {
    const keys = KEY_MAP[code];
    if (keys) {
      for (const key of keys) {
        this.callback(key.row, key.bit, true);
      }
    }
  }

  releaseKey(code: string): void {
    const keys = KEY_MAP[code];
    if (keys) {
      for (const key of keys) {
        this.callback(key.row, key.bit, false);
      }
    }
  }

  releaseAll(): void {
    this.pressedKeys.clear();
    for (let row = 0; row < 8; row++) {
      for (let bit = 0; bit < 5; bit++) {
        this.callback(row, bit, false);
      }
    }
  }

  /**
   * Get the key map (useful for UI virtual keyboard).
   */
  static getKeyMap(): Record<string, SpectrumKey[]> {
    return { ...KEY_MAP };
  }
}
