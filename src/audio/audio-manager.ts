/**
 * Audio Manager
 *
 * Sets up the AudioWorklet and feeds beeper samples from the emulator.
 */

export class AudioManager {
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    this.context = new AudioContext({ sampleRate: 48000 });

    // Create the worklet from a blob URL (avoids separate file serving issues)
    const workletCode = `
      const RING_BUFFER_SIZE = 16384;
      class BeeperProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.ringBuffer = new Float32Array(RING_BUFFER_SIZE);
          this.readPos = 0;
          this.writePos = 0;
          this.port.onmessage = (event) => {
            if (event.data.type === "samples") {
              const samples = event.data.samples;
              for (let i = 0; i < samples.length; i++) {
                this.ringBuffer[this.writePos] = samples[i];
                this.writePos = (this.writePos + 1) % RING_BUFFER_SIZE;
              }
            }
          };
        }
        process(inputs, outputs, parameters) {
          const output = outputs[0];
          if (output.length === 0) return true;
          const channel = output[0];
          for (let i = 0; i < channel.length; i++) {
            if (this.readPos === this.writePos) {
              channel[i] = 0;
            } else {
              channel[i] = this.ringBuffer[this.readPos];
              this.readPos = (this.readPos + 1) % RING_BUFFER_SIZE;
            }
          }
          for (let ch = 1; ch < output.length; ch++) {
            output[ch].set(channel);
          }
          return true;
        }
      }
      registerProcessor("beeper-processor", BeeperProcessor);
    `;

    const blob = new Blob([workletCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);

    await this.context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.workletNode = new AudioWorkletNode(this.context, "beeper-processor");
    this.workletNode.connect(this.context.destination);
    this.initialized = true;
  }

  /**
   * Send a frame's worth of audio samples to the worklet.
   */
  pushSamples(samples: Float32Array): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: "samples",
      samples: samples,
    });
  }

  /**
   * Resume audio context (must be called from user gesture).
   */
  async resume(): Promise<void> {
    if (this.context?.state === "suspended") {
      await this.context.resume();
    }
  }

  getSampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  destroy(): void {
    this.workletNode?.disconnect();
    this.context?.close();
    this.workletNode = null;
    this.context = null;
    this.initialized = false;
  }
}
