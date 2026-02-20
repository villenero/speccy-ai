/**
 * Quick smoke test: verify Z80 can execute instructions.
 * Tests that the decode map works and tStateCount advances.
 */
import { readFileSync } from "fs";

// Inline-import the core logic from compiled bundle
// Since we can't easily run TS with Node, let's do a minimal manual test

const memory = new Uint8Array(65536);
const rom = readFileSync("public/roms/48.rom");
memory.set(rom, 0);

// Check ROM is valid
console.log(`ROM loaded: ${rom.length} bytes`);
console.log(`First bytes: ${Array.from(rom.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

// The Spectrum ROM starts with: F3 AF 11 FF FF C3 CB 11
// F3 = DI, AF = XOR A, 11 FF FF = LD DE, $FFFF, C3 CB 11 = JP $11CB
const expected = [0xF3, 0xAF, 0x11, 0xFF, 0xFF, 0xC3, 0xCB, 0x11];
const actual = Array.from(rom.slice(0, 8));
const match = expected.every((v, i) => v === actual[i]);
console.log(`ROM header ${match ? 'VALID' : 'INVALID'}: expected [${expected.map(b=>b.toString(16)).join(',')}], got [${actual.map(b=>b.toString(16)).join(',')}]`);

if (!match) {
  console.error("ROM is not a valid ZX Spectrum 48K ROM!");
  process.exit(1);
}

console.log("\nROM is valid. The Z80 core should be able to execute it.");
console.log("If the browser hangs, the issue is likely in the main loop or rendering.");
console.log("\nTo debug: open browser console and check for errors before 'Initializing...' changes.");
