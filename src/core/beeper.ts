/**
 * ZX Spectrum 48K Beeper
 *
 * 1-bit audio via port $FE bit 4.
 * Records state changes with T-state precision, then generates
 * audio samples at the end of each frame.
 */

import { TSTATES_PER_FRAME } from "./ula.js";

const CPU_CLOCK = 3_500_000;

interface BeeperEvent {
  tstate: number;
  level: number; // 0 or 1
}

export class Beeper {
  private level = 0;
  private events: BeeperEvent[] = [];
  private sampleRate: number;
  private samplesPerFrame: number;

  // Audio buffer for one frame
  public audioBuffer: Float32Array;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.samplesPerFrame = Math.ceil(sampleRate / (CPU_CLOCK / TSTATES_PER_FRAME));
    this.audioBuffer = new Float32Array(this.samplesPerFrame);
  }

  /**
   * Set beeper state (called on OUT to port $FE, bit 4).
   */
  setState(level: number, tstate: number): void {
    if (level !== this.level) {
      this.events.push({ tstate, level });
      this.level = level;
    }
  }

  getLevel(): number {
    return this.level;
  }

  /**
   * Generate audio samples for the completed frame.
   * Converts T-state-precision beeper events to PCM samples.
   */
  generateSamples(): Float32Array {
    const buffer = this.audioBuffer;
    const tstatesPerSample = TSTATES_PER_FRAME / this.samplesPerFrame;

    let eventIdx = 0;
    let currentLevel = this.events.length > 0 ? (this.events[0].tstate > 0 ? this.level : this.events[0].level) : this.level;

    // Pre-frame level: whatever was set before this frame's events
    if (this.events.length > 0 && this.events[0].tstate > 0) {
      // Level before first event is the level from end of last frame
      // We track that via the `level` property which persists across frames
      currentLevel = this.level;
      // But we need the level at the START of the frame, before events
      // Actually, the first event changes from the previous level
      // So the pre-event level is the opposite of the first event
      // No — the level field tracks the CURRENT level after the last event
      // So at frame start, the level is whatever `level` was set to before any new events
    }

    // Simpler approach: walk through events
    let prevLevel = this.events.length > 0
      ? (this.events[0].level === 0 ? 1 : 0) // Level before first toggle
      : this.level;

    // Correction: track level properly
    // At frame start, level = value from the end of the previous frame
    // We don't have that directly, so we use the level before the first event
    // If no events, it's just `this.level`
    if (this.events.length === 0) {
      // No beeper activity this frame — output silence
      buffer.fill(0);
      return buffer;
    }

    // Reset to pre-event level
    eventIdx = 0;
    let activeLevel = 1 - this.events[0].level; // Level before first change

    for (let i = 0; i < this.samplesPerFrame; i++) {
      const sampleTstate = i * tstatesPerSample;
      const sampleEnd = sampleTstate + tstatesPerSample;

      // Advance events up to this sample's time range
      while (eventIdx < this.events.length && this.events[eventIdx].tstate < sampleEnd) {
        activeLevel = this.events[eventIdx].level;
        eventIdx++;
      }

      buffer[i] = activeLevel ? 0.5 : -0.5;
    }

    // Clear events for next frame
    this.events.length = 0;

    return buffer;
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  getSamplesPerFrame(): number {
    return this.samplesPerFrame;
  }

  reset(): void {
    this.level = 0;
    this.events.length = 0;
    this.audioBuffer.fill(0);
  }
}
