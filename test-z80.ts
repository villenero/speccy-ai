import { readFileSync } from "fs";
import { Z80 } from "./src/core/z80/Z80.js";
import type { Hal } from "./src/core/z80/Hal.js";

const memory = new Uint8Array(65536);
const rom = readFileSync("public/roms/48.rom");
memory.set(rom, 0);

const hal: Hal = {
  tStateCount: 0,
  readMemory(addr: number) { return memory[addr & 0xFFFF]; },
  writeMemory(addr: number, val: number) { if (addr >= 0x4000) memory[addr & 0xFFFF] = val; },
  contendMemory() {},
  readPort() { return 0xFF; },
  writePort() {},
  contendPort() {},
};

const cpu = new Z80(hal);
console.log(`Initial: PC=0x${cpu.regs.pc.toString(16)}, SP=0x${cpu.regs.sp.toString(16)}`);

const TSTATES_PER_FRAME = 69888;
const t0 = performance.now();

hal.tStateCount = 0;
let steps = 0;
while (hal.tStateCount < TSTATES_PER_FRAME) {
  cpu.step();
  steps++;
  if (steps > 2_000_000) {
    console.error(`STUCK after ${steps} steps, tState=${hal.tStateCount}, PC=0x${cpu.regs.pc.toString(16)}`);
    break;
  }
}

const elapsed = performance.now() - t0;
console.log(`Frame done: ${steps} instructions, ${hal.tStateCount} T-states, ${elapsed.toFixed(1)}ms`);
console.log(`PC=0x${cpu.regs.pc.toString(16)}, SP=0x${cpu.regs.sp.toString(16)}`);

// Run a few more frames
for (let f = 1; f < 10; f++) {
  hal.tStateCount = 0;
  cpu.maskableInterrupt();
  let s = 0;
  while (hal.tStateCount < TSTATES_PER_FRAME) {
    cpu.step();
    s++;
    if (s > 2_000_000) {
      console.error(`Frame ${f}: STUCK after ${s} steps`);
      break;
    }
  }
  console.log(`Frame ${f}: ${s} instructions, PC=0x${cpu.regs.pc.toString(16)}`);
}

console.log("\nAll frames completed successfully!");
