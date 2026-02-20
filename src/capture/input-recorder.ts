/**
 * Input Recorder — Record and replay player inputs
 *
 * The Spectrum is fully deterministic: same snapshot + same inputs = same result.
 * This allows recording a play session as compact input data and replaying it exactly.
 */

import { Spectrum } from "../core/spectrum.js";

export interface InputFrame {
  frame: number;
  keys: number[];    // 8 half-row bytes
  kempston: number;
}

export interface InputRecording {
  game: string;
  startSnapshot?: Uint8Array; // SNA snapshot at recording start
  inputs: InputFrame[];
}

export class InputRecorder {
  private spectrum: Spectrum;
  private recording = false;
  private inputs: InputFrame[] = [];
  private gameName = "";
  private lastKeys: string = "";
  private lastKempston = -1;

  constructor(spectrum: Spectrum) {
    this.spectrum = spectrum;
  }

  /**
   * Start recording inputs.
   */
  startRecording(gameName: string): void {
    this.gameName = gameName;
    this.inputs = [];
    this.lastKeys = "";
    this.lastKempston = -1;
    this.recording = true;
  }

  /**
   * Stop recording and return the recording.
   */
  stopRecording(): InputRecording {
    this.recording = false;
    return {
      game: this.gameName,
      inputs: this.inputs,
    };
  }

  /**
   * Record the current frame's input state.
   * Call this once per frame, before runFrame().
   * Only records if the input changed (delta compression).
   */
  recordFrame(): void {
    if (!this.recording) return;

    const keys = this.spectrum.io.getKeyboardState();
    const kempston = this.spectrum.io.getKempstonState();
    const keysStr = keys.join(",");

    // Only record if something changed
    if (keysStr !== this.lastKeys || kempston !== this.lastKempston) {
      this.inputs.push({
        frame: this.spectrum.ula.getFrameCount(),
        keys: Array.from(keys),
        kempston,
      });
      this.lastKeys = keysStr;
      this.lastKempston = kempston;
    }
  }

  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Replay a recording on the emulator.
   * Runs the specified number of frames, applying recorded inputs at the correct frame.
   * Returns frame count reached.
   */
  replay(
    recording: InputRecording,
    onFrame?: (frame: number) => void | boolean,
  ): number {
    if (recording.inputs.length === 0) return 0;

    const lastFrame = recording.inputs[recording.inputs.length - 1].frame;
    let inputIdx = 0;

    for (let f = 0; f <= lastFrame + 100; f++) { // Run 100 extra frames after last input
      // Apply input changes for this frame
      while (inputIdx < recording.inputs.length && recording.inputs[inputIdx].frame <= f) {
        const input = recording.inputs[inputIdx];
        this.spectrum.io.setKeyboardState(new Uint8Array(input.keys));
        this.spectrum.io.setKempstonState(input.kempston);
        inputIdx++;
      }

      this.spectrum.runFrame();

      if (onFrame) {
        const result = onFrame(f);
        if (result === false) break;
      }
    }

    return this.spectrum.ula.getFrameCount();
  }

  /**
   * Export recording as JSON string.
   */
  static toJSON(recording: InputRecording): string {
    return JSON.stringify({
      game: recording.game,
      inputs: recording.inputs,
    });
  }

  /**
   * Import recording from JSON string.
   */
  static fromJSON(json: string): InputRecording {
    return JSON.parse(json);
  }
}
