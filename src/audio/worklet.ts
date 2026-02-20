/**
 * AudioWorkletProcessor for ZX Spectrum beeper output.
 *
 * Receives audio sample buffers from the emulator via a ring buffer
 * and outputs them to the audio device.
 */

const RING_BUFFER_SIZE = 16384;

class BeeperProcessor extends AudioWorkletProcessor {
  private ringBuffer: Float32Array;
  private readPos = 0;
  private writePos = 0;

  constructor() {
    super();
    this.ringBuffer = new Float32Array(RING_BUFFER_SIZE);

    this.port.onmessage = (event) => {
      if (event.data.type === "samples") {
        this.pushSamples(event.data.samples);
      }
    };
  }

  private pushSamples(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.ringBuffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % RING_BUFFER_SIZE;
    }
  }

  private pullSample(): number {
    if (this.readPos === this.writePos) {
      return 0; // Underrun: silence
    }
    const sample = this.ringBuffer[this.readPos];
    this.readPos = (this.readPos + 1) % RING_BUFFER_SIZE;
    return sample;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const output = outputs[0];
    if (output.length === 0) return true;

    const channel = output[0];
    for (let i = 0; i < channel.length; i++) {
      channel[i] = this.pullSample();
    }

    // Copy to all channels
    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel);
    }

    return true;
  }
}

registerProcessor("beeper-processor", BeeperProcessor);
