/**
 * ZX Spectrum 48K Emulator — Main Entry Point
 */

import { Spectrum } from "./core/spectrum.js";
import { Renderer } from "./video/renderer.js";
import { Keyboard } from "./input/keyboard.js";
import { AudioManager } from "./audio/audio-manager.js";
import { BotAPI } from "./capture/bot-api.js";
import { FrameCapture } from "./capture/frame-capture.js";
import { loadSNA } from "./formats/sna.js";
import { loadZ80 } from "./formats/z80format.js";

console.log("[zx-emul] Modules imported OK");

// --- Initialize emulator ---
let spectrum: Spectrum;
let renderer: Renderer;
let keyboard: Keyboard;
let audio: AudioManager;
let bot: BotAPI;

try {
  spectrum = new Spectrum(48000);
  console.log("[zx-emul] Spectrum created");
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  if (!canvas) throw new Error("Canvas #screen not found");
  renderer = new Renderer(canvas);
  console.log("[zx-emul] Renderer created");
  keyboard = new Keyboard((row, bit, pressed) => spectrum.io.setKey(row, bit, pressed));
  audio = new AudioManager();
  bot = new BotAPI(spectrum);
  console.log("[zx-emul] All components initialized");
} catch (e) {
  document.getElementById("status")!.textContent = `Init error: ${e}`;
  console.error("[zx-emul] Init failed:", e);
  throw e;
}

// --- State ---
let running = false;
let animFrameId = 0;
let useOriginalRom = true;
let audioInitialized = false;

// --- UI References ---
const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const btnRun = document.getElementById("btn-run") as HTMLButtonElement;
const btnPause = document.getElementById("btn-pause") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnLoadSnap = document.getElementById("btn-load-snap") as HTMLButtonElement;
const fileSnap = document.getElementById("file-snap") as HTMLInputElement;
const btnRomToggle = document.getElementById("btn-rom-toggle") as HTMLButtonElement;
const btnCaptureFrame = document.getElementById("btn-capture-frame") as HTMLButtonElement;
const btnCaptureState = document.getElementById("btn-capture-state") as HTMLButtonElement;
const btnCaptureText = document.getElementById("btn-capture-text") as HTMLButtonElement;
const btnCaptureSprites = document.getElementById("btn-capture-sprites") as HTMLButtonElement;
const btnCaptureTiles = document.getElementById("btn-capture-tiles") as HTMLButtonElement;
const btnRecordToggle = document.getElementById("btn-record-toggle") as HTMLButtonElement;
const btnTurboCapture = document.getElementById("btn-turbo-capture") as HTMLButtonElement;
const btnMemSearch = document.getElementById("btn-mem-search") as HTMLButtonElement;

function log(msg: string) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
  logEl.textContent += line;
  logEl.scrollTop = logEl.scrollHeight;
}

// --- ROM loading ---
async function loadCurrentRom() {
  const romUrl = useOriginalRom ? "/roms/48.rom" : "/roms/opense.rom";
  try {
    await spectrum.loadRom(romUrl);
    log(`ROM loaded: ${useOriginalRom ? "Original Amstrad" : "OpenSE BASIC (GPL)"}`);
  } catch (e) {
    log(`Failed to load ROM: ${e}`);
  }
}

// --- Main emulation loop ---
function emulationLoop() {
  if (!running) return;

  // Record input if recording
  if (bot.inputRecorder.isRecording()) {
    bot.inputRecorder.recordFrame();
  }

  spectrum.runFrame();
  renderer.render(spectrum.ula.framebuffer);

  // Push audio samples
  if (audioInitialized) {
    audio.pushSamples(spectrum.beeper.audioBuffer);
  }

  // Update status
  const frame = spectrum.ula.getFrameCount();
  const pc = spectrum.cpu.regs.pc.toString(16).toUpperCase().padStart(4, "0");
  statusEl.textContent = `Frame: ${frame} | PC: $${pc} | Running`;

  animFrameId = requestAnimationFrame(emulationLoop);
}

function startEmulation() {
  if (running) return;
  running = true;
  btnRun.classList.add("active");
  btnPause.classList.remove("active");
  emulationLoop();
}

function pauseEmulation() {
  running = false;
  cancelAnimationFrame(animFrameId);
  btnRun.classList.remove("active");
  btnPause.classList.add("active");
  const frame = spectrum.ula.getFrameCount();
  const pc = spectrum.cpu.regs.pc.toString(16).toUpperCase().padStart(4, "0");
  statusEl.textContent = `Frame: ${frame} | PC: $${pc} | Paused`;
}

async function initAudio() {
  if (audioInitialized) return;
  try {
    await audio.init();
    await audio.resume();
    audioInitialized = true;
    log("Audio initialized");
  } catch (e) {
    log(`Audio init failed: ${e}`);
  }
}

// --- Event handlers ---

btnRun.addEventListener("click", async () => {
  await initAudio();
  startEmulation();
});

btnPause.addEventListener("click", () => pauseEmulation());

btnReset.addEventListener("click", async () => {
  pauseEmulation();
  spectrum.reset();
  await loadCurrentRom();
  spectrum.runFrame();
  renderer.render(spectrum.ula.framebuffer);
  log("Reset complete");
});

btnLoadSnap.addEventListener("click", () => fileSnap.click());

fileSnap.addEventListener("change", async () => {
  const file = fileSnap.files?.[0];
  if (!file) return;

  const data = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.toLowerCase().split(".").pop();

  try {
    if (ext === "sna") {
      loadSNA(spectrum, data);
    } else if (ext === "z80") {
      loadZ80(spectrum, data);
    } else {
      log(`Unknown format: .${ext}`);
      return;
    }
    log(`Loaded snapshot: ${file.name} (${data.length} bytes)`);

    // Render one frame to show the loaded state
    spectrum.runFrame();
    renderer.render(spectrum.ula.framebuffer);

    await initAudio();
    startEmulation();
  } catch (e) {
    log(`Error loading snapshot: ${e}`);
  }

  fileSnap.value = "";
});

btnRomToggle.addEventListener("click", async () => {
  useOriginalRom = !useOriginalRom;
  btnRomToggle.textContent = `ROM: ${useOriginalRom ? "Original" : "OpenSE"}`;
  pauseEmulation();
  spectrum.reset();
  await loadCurrentRom();
  spectrum.runFrame();
  renderer.render(spectrum.ula.framebuffer);
});

// --- Capture tools ---

btnCaptureFrame.addEventListener("click", async () => {
  const frame = bot.getFrame(true);
  try {
    const blob = await FrameCapture.frameToPNG(frame);
    downloadBlob(blob, `frame_${frame.frameNumber.toString().padStart(6, "0")}.png`);
    log(`Frame ${frame.frameNumber} captured as PNG (${blob.size} bytes)`);
  } catch (e) {
    log(`Frame capture failed: ${e}`);
  }
});

btnCaptureState.addEventListener("click", () => {
  const state = bot.stateCapture.capture();
  const json = JSON.stringify(bot.stateCapture.toJSON(state), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  downloadBlob(blob, `state_frame_${state.frame}.json`);
  log(`State captured: frame ${state.frame}, PC=$${state.registers.PC.toString(16).toUpperCase()}`);
});

btnCaptureText.addEventListener("click", () => {
  const texts = bot.detectText();
  if (texts.length === 0) {
    log("No text detected on screen");
  } else {
    for (const t of texts) {
      log(`Text at (${t.charCol},${t.charRow}): "${t.content}"`);
    }
  }
});

btnCaptureSprites.addEventListener("click", () => {
  const sprites = bot.detectSprites();
  if (sprites.length === 0) {
    log("No sprite changes detected (need 2+ frames of diff)");
  } else {
    log(`Detected ${sprites.length} sprites:`);
    for (const s of sprites) {
      log(`  #${s.id}: (${s.x},${s.y}) ${s.width}x${s.height}`);
    }
  }
});

btnCaptureTiles.addEventListener("click", () => {
  const tiles = bot.detectTiles();
  log(`Detected ${tiles.length} unique repeated tiles`);
  for (const t of tiles.slice(0, 10)) {
    log(`  Tile ${t.hash}: appears ${t.positions.length}x`);
  }
  if (tiles.length > 10) log(`  ... and ${tiles.length - 10} more`);
});

let recording = false;
btnRecordToggle.addEventListener("click", () => {
  if (!recording) {
    bot.startRecording("session");
    btnRecordToggle.textContent = "Stop Recording";
    btnRecordToggle.classList.add("active");
    recording = true;
    log("Recording started");
  } else {
    const rec = bot.stopRecording();
    btnRecordToggle.textContent = "Start Recording";
    btnRecordToggle.classList.remove("active");
    recording = false;
    const json = JSON.stringify(rec);
    const blob = new Blob([json], { type: "application/json" });
    downloadBlob(blob, `recording_${Date.now()}.json`);
    log(`Recording saved: ${rec.inputs.length} input events`);
  }
});

btnTurboCapture.addEventListener("click", async () => {
  const wasRunning = running;
  if (running) pauseEmulation();

  log("Turbo capturing 100 frames...");
  const t0 = performance.now();

  const frames = bot.frameCapture.captureFrames(100, 1, true);
  const elapsed = performance.now() - t0;
  log(`Captured ${frames.length} frames in ${elapsed.toFixed(0)}ms (${(frames.length / elapsed * 1000).toFixed(0)} fps)`);

  // Download last frame as sample
  const lastFrame = frames[frames.length - 1];
  const blob = await FrameCapture.frameToPNG(lastFrame);
  downloadBlob(blob, `turbo_frame_${lastFrame.frameNumber}.png`);

  // Render current state
  renderer.render(spectrum.ula.framebuffer);

  if (wasRunning) startEmulation();
});

btnMemSearch.addEventListener("click", () => {
  const input = prompt("Enter value to search in RAM (0-255):");
  if (input === null) return;
  const value = parseInt(input, 10);
  if (isNaN(value) || value < 0 || value > 255) {
    log("Invalid value (must be 0-255)");
    return;
  }
  const results = bot.searchValue(value);
  log(`Found ${results.length} addresses containing ${value}`);
  if (results.length <= 20) {
    log(`  ${results.map(a => "$" + a.toString(16).toUpperCase()).join(", ")}`);
  } else {
    log(`  First 20: ${results.slice(0, 20).map(a => "$" + a.toString(16).toUpperCase()).join(", ")} ...`);
  }
  log("  Search again to narrow down (intersects previous results)");
});

// --- Utility ---

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Boot ---

(async () => {
  try {
    keyboard.attach();

    // Expose for console access immediately
    (window as any).bot = bot;
    (window as any).spectrum = spectrum;

    statusEl.textContent = "Loading ROM...";
    await loadCurrentRom();

    statusEl.textContent = "Running first frame...";

    // Run a few frames to get past ROM init
    for (let i = 0; i < 5; i++) {
      spectrum.runFrame();
    }
    renderer.render(spectrum.ula.framebuffer);

    statusEl.textContent = "Ready. Click 'Run' to start or load a snapshot.";
    log("ZX Spectrum 48K emulator ready");
    log("Z80 CPU: lkesteloot/z80-emulator (MIT, 1356 FUSE tests)");
    log("ROMs: Original Amstrad + OpenSE BASIC (GPL v2)");
    log("");
    log("Bot API in console: window.bot / window.spectrum");
  } catch (e) {
    console.error("Boot failed:", e);
    statusEl.textContent = `Error: ${e}`;
    log(`BOOT ERROR: ${e}`);
  }
})();
