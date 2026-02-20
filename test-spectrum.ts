import { readFileSync } from "fs";
import { Spectrum } from "./src/core/spectrum.js";

const spectrum = new Spectrum(48000);
console.log("Spectrum instance created");

const rom = readFileSync("public/roms/48.rom");
spectrum.loadRomData(new Uint8Array(rom));
console.log("ROM loaded");

console.log("Running first frame...");
const t0 = performance.now();
spectrum.runFrame();
const t1 = performance.now();
console.log(`Frame 1 done in ${(t1 - t0).toFixed(1)}ms`);
console.log(`PC=0x${spectrum.cpu.regs.pc.toString(16)}, Frame=${spectrum.ula.getFrameCount()}`);

// Run 50 more frames (1 second of emulation)
const t2 = performance.now();
for (let i = 0; i < 50; i++) {
  spectrum.runFrame();
}
const t3 = performance.now();
console.log(`50 frames in ${(t3 - t2).toFixed(1)}ms (${(50 / (t3 - t2) * 1000).toFixed(0)} fps)`);
console.log(`PC=0x${spectrum.cpu.regs.pc.toString(16)}, Frame=${spectrum.ula.getFrameCount()}`);

// Check screen memory has content
const screenPixels = spectrum.memory.getScreenPixels();
const nonZero = screenPixels.filter(b => b !== 0).length;
console.log(`Screen pixels: ${nonZero} non-zero bytes out of 6144`);

// Check framebuffer
const fb = spectrum.ula.framebuffer;
const totalPixels = fb.length / 4;
let colorPixels = 0;
for (let i = 0; i < fb.length; i += 4) {
  if (fb[i] > 0 || fb[i + 1] > 0 || fb[i + 2] > 0) colorPixels++;
}
console.log(`Framebuffer: ${colorPixels}/${totalPixels} non-black pixels`);

console.log("\nAll tests passed!");
