/**
 * ZX Spectrum 48K Emulator — Main Entry Point
 */

import { Spectrum } from "./core/spectrum.js";
import { Renderer } from "./video/renderer.js";
import { Keyboard } from "./input/keyboard.js";
import { AudioManager } from "./audio/audio-manager.js";
import { BotAPI } from "./capture/bot-api.js";
import { FrameCapture, CapturedFrame } from "./capture/frame-capture.js";
import { loadSNA, saveSNA } from "./formats/sna.js";
import { loadZ80 } from "./formats/z80format.js";
import { TapeManager } from "./core/tape-manager.js";
import { ElementPicker, PickedElement } from "./capture/element-picker.js";

console.log("[zx-emul] Modules imported OK");

// Map (row_bit → overlay element) for virtual keyboard highlighting from physical keys
const vkbdOverlayMap = new Map<string, HTMLElement>();

// --- Initialize emulator ---
let spectrum: Spectrum;
let renderer: Renderer;
let keyboard: Keyboard;
let audio: AudioManager;
let bot: BotAPI;
let tapeManager: TapeManager;

try {
  spectrum = new Spectrum(48000);
  console.log("[zx-emul] Spectrum created");
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  if (!canvas) throw new Error("Canvas #screen not found");
  renderer = new Renderer(canvas);
  console.log("[zx-emul] Renderer created");
  keyboard = new Keyboard((row, bit, pressed) => {
    spectrum.io.setKey(row, bit, pressed);
    // Highlight virtual keyboard overlay if visible
    const el = vkbdOverlayMap.get(`${row}_${bit}`);
    if (el) el.classList.toggle("pressed", pressed);
  });
  audio = new AudioManager();
  bot = new BotAPI(spectrum);
  tapeManager = new TapeManager(spectrum);
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

// Frame timing: ZX Spectrum runs at ~50.08 fps (69,888 T-states @ 3.5MHz)
const MS_PER_FRAME = 1000 / 50.08;
let lastFrameTime = 0;
let timeAccumulator = 0;

// --- UI References ---
const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const btnPlayPause = document.getElementById("btn-play-pause") as HTMLButtonElement;
const btnStepFrame = document.getElementById("btn-step-frame") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnLoadSnap = document.getElementById("btn-load-snap") as HTMLButtonElement;
const fileSnap = document.getElementById("file-snap") as HTMLInputElement;
const btnRomToggle = document.getElementById("btn-rom-toggle") as HTMLButtonElement;
const btnCaptureFrame = document.getElementById("btn-capture-frame") as HTMLButtonElement;
const btnSaveSnapshot = document.getElementById("btn-save-snapshot") as HTMLButtonElement;
const btnCaptureText = document.getElementById("btn-capture-text") as HTMLButtonElement;
const btnCaptureSprites = document.getElementById("btn-capture-sprites") as HTMLButtonElement;
const btnCaptureTiles = document.getElementById("btn-capture-tiles") as HTMLButtonElement;
const btnRecordToggle = document.getElementById("btn-record-toggle") as HTMLButtonElement;
const btnTurboCapture = document.getElementById("btn-turbo-capture") as HTMLButtonElement;
const btnMemSearch = document.getElementById("btn-mem-search") as HTMLButtonElement;
const btnPickElement = document.getElementById("btn-pick-element") as HTMLButtonElement;
const selectScale = document.getElementById("select-scale") as HTMLSelectElement;
const galleryMosaic = document.getElementById("gallery-mosaic")!;
const galleryCount = document.getElementById("gallery-count")!;
const btnSelectAll = document.getElementById("btn-select-all") as HTMLButtonElement;
const btnSelectNone = document.getElementById("btn-select-none") as HTMLButtonElement;
const btnRestoreSnapshot = document.getElementById("btn-restore-snapshot") as HTMLButtonElement;
const btnDownloadSelected = document.getElementById("btn-download-selected") as HTMLButtonElement;
const btnClearGallery = document.getElementById("btn-clear-gallery") as HTMLButtonElement;

// --- Display scaling ---
const NATIVE_WIDTH = 352;
const NATIVE_HEIGHT = 288;
let previousScale = "auto";

function applyScale(value: string) {
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  if (value === "full") {
    const container = document.getElementById("screen-container")!;
    canvas.classList.add("fullscreen");
    container.requestFullscreen?.();
  } else if (value === "auto") {
    canvas.classList.remove("fullscreen");
    canvas.style.width = "100%";
    canvas.style.height = "auto";
  } else {
    const s = parseInt(value, 10);
    canvas.classList.remove("fullscreen");
    canvas.style.width = `${NATIVE_WIDTH * s}px`;
    canvas.style.height = `${NATIVE_HEIGHT * s}px`;
  }
}

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    const canvas = document.getElementById("screen") as HTMLCanvasElement;
    canvas.classList.remove("fullscreen");
    selectScale.value = previousScale;
    applyScale(previousScale);
  }
});

selectScale.addEventListener("change", () => {
  const value = selectScale.value;
  if (value !== "full") previousScale = value;
  applyScale(value);
});

// --- Gallery state ---

// SVG badge icons (inline HTML for gallery items)
const BADGE_FRAME = '<svg viewBox="0 0 24 24" fill="none" stroke="#8cf" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="3"/></svg>';
const BADGE_SNAP = '<svg viewBox="0 0 24 24" fill="none" stroke="#fc6" stroke-width="2.5"><path d="M19,21H5a2,2 0 0,1-2-2V5a2,2 0 0,1,2-2h11l5,5v11a2,2 0 0,1-2,2z"/><polyline points="17,21 17,13 7,13 7,21"/></svg>';
const BADGE_ELEMENT = '<svg viewBox="0 0 24 24" fill="none" stroke="#f8a" stroke-width="2.5"><circle cx="12" cy="12" r="6"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22" y2="12"/></svg>';

interface GalleryItemBase {
  wrapper: HTMLElement;
  canvas: HTMLCanvasElement;
  selected: boolean;
}
interface GalleryFrameItem extends GalleryItemBase {
  type: "frame";
  frame: CapturedFrame;
}
interface GallerySnapshotItem extends GalleryItemBase {
  type: "snapshot";
  snaData: Uint8Array;
  frameNumber: number;
}
interface GalleryElementItem extends GalleryItemBase {
  type: "element";
  elementData: PickedElement;
}
type GalleryItem = GalleryFrameItem | GallerySnapshotItem | GalleryElementItem;

const gallery: GalleryItem[] = [];

function createGalleryThumb(type: "frame" | "snapshot" | "element"): { wrapper: HTMLElement; canvas: HTMLCanvasElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "gallery-item";

  const canvas = document.createElement("canvas");
  wrapper.appendChild(canvas);

  // Badge
  const badge = document.createElement("div");
  badge.className = "gallery-badge";
  badge.innerHTML = type === "snapshot" ? BADGE_SNAP : type === "element" ? BADGE_ELEMENT : BADGE_FRAME;
  wrapper.appendChild(badge);

  return { wrapper, canvas };
}

function addToGallery(frame: CapturedFrame) {
  const { wrapper, canvas: thumb } = createGalleryThumb("frame");
  const aspect = frame.width / frame.height;
  thumb.width = 128;
  thumb.height = Math.round(128 / aspect);
  const ctx = thumb.getContext("2d")!;
  const src = FrameCapture.frameToCanvas(frame);
  ctx.drawImage(src, 0, 0, thumb.width, thumb.height);

  const item: GalleryFrameItem = { type: "frame", frame, wrapper, canvas: thumb, selected: false };
  gallery.push(item);

  wrapper.addEventListener("click", () => {
    item.selected = !item.selected;
    wrapper.classList.toggle("selected", item.selected);
    updateGalleryCount();
  });

  galleryMosaic.appendChild(wrapper);
  updateGalleryCount();
}

function addSnapshotToGallery(snaData: Uint8Array, frameNumber: number) {
  const { wrapper, canvas: thumb } = createGalleryThumb("snapshot");
  // Render current screen as thumbnail for the snapshot
  const frameCap = bot.getFrame(false);
  const aspect = frameCap.width / frameCap.height;
  thumb.width = 128;
  thumb.height = Math.round(128 / aspect);
  const ctx = thumb.getContext("2d")!;
  const src = FrameCapture.frameToCanvas(frameCap);
  ctx.drawImage(src, 0, 0, thumb.width, thumb.height);

  const item: GallerySnapshotItem = { type: "snapshot", snaData, frameNumber, wrapper, canvas: thumb, selected: false };
  gallery.push(item);

  wrapper.addEventListener("click", () => {
    item.selected = !item.selected;
    wrapper.classList.toggle("selected", item.selected);
    updateGalleryCount();
  });

  galleryMosaic.appendChild(wrapper);
  updateGalleryCount();
}

function addElementToGallery(element: PickedElement) {
  const { wrapper, canvas: thumb } = createGalleryThumb("element");
  // Scale to min 64px on smallest side
  const scale = Math.max(1, Math.ceil(64 / Math.max(element.pixelWidth, element.pixelHeight)));
  thumb.width = element.pixelWidth * scale;
  thumb.height = element.pixelHeight * scale;
  thumb.style.imageRendering = "pixelated";
  const ctx = thumb.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  // Draw element RGBA into a temp canvas at native size then scale
  const src = document.createElement("canvas");
  src.width = element.pixelWidth;
  src.height = element.pixelHeight;
  const srcCtx = src.getContext("2d")!;
  const imgData = new ImageData(
    new Uint8ClampedArray(element.rgbaPixels),
    element.pixelWidth,
    element.pixelHeight,
  );
  srcCtx.putImageData(imgData, 0, 0);
  ctx.drawImage(src, 0, 0, thumb.width, thumb.height);

  const item: GalleryElementItem = { type: "element", elementData: element, wrapper, canvas: thumb, selected: false };
  gallery.push(item);

  wrapper.addEventListener("click", () => {
    item.selected = !item.selected;
    wrapper.classList.toggle("selected", item.selected);
    updateGalleryCount();
  });

  galleryMosaic.appendChild(wrapper);
  updateGalleryCount();
}

function updateGalleryCount() {
  const selectedCount = gallery.filter(g => g.selected).length;
  const snapCount = gallery.filter(g => g.type === "snapshot").length;
  const frameCount = gallery.length - snapCount;
  let text = `${gallery.length} items`;
  if (frameCount > 0 && snapCount > 0) text += ` (${frameCount} frames, ${snapCount} snaps)`;
  if (selectedCount > 0) text += ` — ${selectedCount} selected`;
  galleryCount.textContent = text;
}

btnSelectAll.addEventListener("click", () => {
  for (const item of gallery) {
    item.selected = true;
    item.wrapper.classList.add("selected");
  }
  updateGalleryCount();
});

btnSelectNone.addEventListener("click", () => {
  for (const item of gallery) {
    item.selected = false;
    item.wrapper.classList.remove("selected");
  }
  updateGalleryCount();
});

btnRestoreSnapshot.addEventListener("click", () => {
  const selected = gallery.filter(g => g.selected && g.type === "snapshot") as GallerySnapshotItem[];
  if (selected.length === 0) {
    log("No snapshot selected (select a snapshot with the chip icon)");
    return;
  }
  if (selected.length > 1) {
    log("Select only one snapshot to restore");
    return;
  }
  const snap = selected[0];
  const wasRunning = running;
  if (running) pauseEmulation();

  loadSNA(spectrum, snap.snaData);
  spectrum.runFrame();
  renderer.render(spectrum.ula.framebuffer);

  const pc = spectrum.cpu.regs.pc.toString(16).toUpperCase().padStart(4, "0");
  log(`Snapshot restored: frame ${snap.frameNumber}, PC=$${pc}`);
  statusEl.textContent = `Frame: ${snap.frameNumber} | PC: $${pc} | Restored`;

  if (wasRunning) {
    startEmulation();
  }
});

btnDownloadSelected.addEventListener("click", async () => {
  const selected = gallery.filter(g => g.selected);
  if (selected.length === 0) {
    log("No captures selected");
    return;
  }
  log(`Downloading ${selected.length} item(s)...`);
  for (const item of selected) {
    if (item.type === "frame") {
      const blob = await FrameCapture.frameToPNG(item.frame);
      downloadBlob(blob, `frame_${item.frame.frameNumber.toString().padStart(6, "0")}.png`);
    } else if (item.type === "snapshot") {
      const blob = new Blob([new Uint8Array(item.snaData)], { type: "application/octet-stream" });
      downloadBlob(blob, `snapshot_${item.frameNumber.toString().padStart(6, "0")}.sna`);
    } else if (item.type === "element") {
      const el = item.elementData;
      const c = document.createElement("canvas");
      c.width = el.pixelWidth;
      c.height = el.pixelHeight;
      const ctx = c.getContext("2d")!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(el.rgbaPixels), el.pixelWidth, el.pixelHeight), 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        c.toBlob(b => b ? resolve(b) : reject(new Error("PNG failed")), "image/png"));
      downloadBlob(blob, `element_${el.charCol}_${el.charRow}_${el.widthCells}x${el.heightCells}.png`);
    }
  }
});

btnClearGallery.addEventListener("click", () => {
  gallery.length = 0;
  galleryMosaic.innerHTML = "";
  updateGalleryCount();
  log("Gallery cleared");
});

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
function emulationLoop(timestamp: number) {
  if (!running) return;

  if (lastFrameTime === 0) {
    lastFrameTime = timestamp;
  }

  const elapsed = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  // Cap accumulated time to avoid spiral of death (e.g. after tab switch)
  timeAccumulator += Math.min(elapsed, 100);

  let framesRun = 0;
  while (timeAccumulator >= MS_PER_FRAME) {
    timeAccumulator -= MS_PER_FRAME;

    // Record input if recording
    if (bot.inputRecorder.isRecording()) {
      bot.inputRecorder.recordFrame();
    }

    spectrum.runFrame();

    // Push audio samples
    if (audioInitialized) {
      audio.pushSamples(spectrum.beeper.audioBuffer);
    }

    framesRun++;
  }

  // Render only the last frame to screen
  if (framesRun > 0) {
    renderer.render(spectrum.ula.framebuffer);

    // Update status
    const frame = spectrum.ula.getFrameCount();
    const pc = spectrum.cpu.regs.pc.toString(16).toUpperCase().padStart(4, "0");
    statusEl.textContent = `Frame: ${frame} | PC: $${pc} | Running`;
  }

  animFrameId = requestAnimationFrame(emulationLoop);
}

const ICON_PLAY = '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20" fill="currentColor" stroke="none"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="15" y="4" width="4" height="16" fill="currentColor" stroke="none"/></svg>';

function updatePlayPauseButton() {
  btnPlayPause.innerHTML = running ? `${ICON_PAUSE}Pause` : `${ICON_PLAY}Play`;
  btnPlayPause.classList.toggle("active", running);
}

function startEmulation() {
  if (running) return;
  running = true;
  lastFrameTime = 0;
  timeAccumulator = 0;
  updatePlayPauseButton();
  animFrameId = requestAnimationFrame(emulationLoop);
}

function pauseEmulation() {
  running = false;
  cancelAnimationFrame(animFrameId);
  updatePlayPauseButton();
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

btnPlayPause.addEventListener("click", async () => {
  if (running) {
    pauseEmulation();
  } else {
    await initAudio();
    startEmulation();
  }
});

// Step one frame (1/50.08s ≈ 19.97ms — one Spectrum video frame)
btnStepFrame.addEventListener("click", () => {
  if (running) pauseEmulation();
  spectrum.runFrame();
  renderer.render(spectrum.ula.framebuffer);
  const frame = spectrum.ula.getFrameCount();
  const pc = spectrum.cpu.regs.pc.toString(16).toUpperCase().padStart(4, "0");
  statusEl.textContent = `Frame: ${frame} | PC: $${pc} | Step`;
});

btnReset.addEventListener("click", async () => {
  pauseEmulation();
  spectrum.reset();
  await loadCurrentRom();
  spectrum.runFrame();
  renderer.render(spectrum.ula.framebuffer);
  log("Reset complete");
});

async function loadSnapshotFile(file: File) {
  const data = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.toLowerCase().split(".").pop();

  if (ext === "tap" || ext === "tzx") {
    await loadTapeFile(data, ext as "tap" | "tzx", file.name);
    return;
  }

  if (ext === "sna") {
    loadSNA(spectrum, data);
  } else if (ext === "z80") {
    loadZ80(spectrum, data);
  } else {
    log(`Unknown format: .${ext}`);
    return;
  }
  log(`Loaded snapshot: ${file.name} (${data.length} bytes)`);

  spectrum.runFrame();
  renderer.render(spectrum.ula.framebuffer);

  await initAudio();
  startEmulation();
}

async function loadTapeFile(data: Uint8Array, format: "tap" | "tzx", filename: string) {
  // Stop current emulation
  if (running) pauseEmulation();

  // Eject any previous tape
  tapeManager.eject();

  // Load the tape blocks
  tapeManager.load(data, format);
  log(`Tape loaded: ${filename} (${data.length} bytes, ${format.toUpperCase()})`);

  // Reset Spectrum and load ROM
  spectrum.reset();
  await loadCurrentRom();

  // Run ~100 frames so BASIC is fully initialized
  log("Booting BASIC...");
  for (let i = 0; i < 100; i++) {
    spectrum.runFrame();
  }

  // Inject LOAD "" command
  tapeManager.injectLoadCommand();

  // Run a few frames for the ROM to process the ENTER key
  for (let i = 0; i < 5; i++) {
    spectrum.runFrame();
  }

  // Release ENTER key
  tapeManager.releaseEnter();

  // Render the current state
  renderer.render(spectrum.ula.framebuffer);

  log("Auto-loading tape...");

  // Start emulation — ROM will call LD-BYTES, trap will load data
  await initAudio();
  startEmulation();
}

btnLoadSnap.addEventListener("click", () => fileSnap.click());

fileSnap.addEventListener("change", async () => {
  const file = fileSnap.files?.[0];
  if (!file) return;
  try {
    await loadSnapshotFile(file);
  } catch (e) {
    log(`Error loading snapshot: ${e}`);
  }
  fileSnap.value = "";
});

// --- Drag & Drop on screen ---
const screenContainer = document.getElementById("screen-container")!;

screenContainer.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
  screenContainer.style.borderColor = "#88f";
});

screenContainer.addEventListener("dragleave", () => {
  screenContainer.style.borderColor = "";
});

screenContainer.addEventListener("drop", async (e) => {
  e.preventDefault();
  screenContainer.style.borderColor = "";
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  try {
    await loadSnapshotFile(file);
  } catch (err) {
    log(`Error loading snapshot: ${err}`);
  }
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

btnCaptureFrame.addEventListener("click", () => {
  const frame = bot.getFrame(true);
  addToGallery(frame);
  log(`Frame ${frame.frameNumber} added to gallery`);
});

btnSaveSnapshot.addEventListener("click", () => {
  const frameNum = spectrum.ula.getFrameCount();
  const snaData = saveSNA(spectrum);
  addSnapshotToGallery(snaData, frameNum);
  const pc = spectrum.cpu.regs.pc.toString(16).toUpperCase().padStart(4, "0");
  log(`Snapshot saved: frame ${frameNum}, PC=$${pc} (${snaData.length} bytes SNA)`);
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

const ICON_REC = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" fill="currentColor" stroke="none"/></svg>';

let recording = false;
btnRecordToggle.addEventListener("click", () => {
  if (!recording) {
    bot.startRecording("session");
    btnRecordToggle.innerHTML = `${ICON_STOP}Stop Recording`;
    btnRecordToggle.classList.add("active");
    recording = true;
    log("Recording started");
  } else {
    const rec = bot.stopRecording();
    btnRecordToggle.innerHTML = `${ICON_REC}Start Recording`;
    btnRecordToggle.classList.remove("active");
    recording = false;
    const json = JSON.stringify(rec);
    const blob = new Blob([json], { type: "application/json" });
    downloadBlob(blob, `recording_${Date.now()}.json`);
    log(`Recording saved: ${rec.inputs.length} input events`);
  }
});

btnTurboCapture.addEventListener("click", () => {
  const wasRunning = running;
  if (running) pauseEmulation();

  log("Turbo capturing 100 frames...");
  const t0 = performance.now();

  const frames = bot.frameCapture.captureFrames(100, 1, true);
  const elapsed = performance.now() - t0;
  log(`Captured ${frames.length} frames in ${elapsed.toFixed(0)}ms (${(frames.length / elapsed * 1000).toFixed(0)} fps)`);

  for (const frame of frames) {
    addToGallery(frame);
  }
  log(`Added ${frames.length} frames to gallery`);

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

// --- Element Picker ---
const pickerOverlay = document.getElementById("picker-overlay") as HTMLCanvasElement;
const elementPicker = new ElementPicker(spectrum, document.getElementById("screen") as HTMLCanvasElement, pickerOverlay);

btnPickElement.addEventListener("click", () => {
  if (elementPicker.isActive()) {
    elementPicker.deactivate();
    btnPickElement.classList.remove("active");
    log("Element picker deactivated");
  } else {
    if (running) pauseEmulation();
    elementPicker.activate((el) => {
      addElementToGallery(el);
      const typeStr = el.detectedAs === "char" && el.matchedChar
        ? `char '${el.matchedChar}'`
        : el.detectedAs;
      log(`Picked ${typeStr}: (${el.charCol},${el.charRow}) ${el.widthCells}x${el.heightCells} cells (${el.pixelWidth}x${el.pixelHeight}px)`);
      if (el.memoryMatches.length > 0) {
        const shown = el.memoryMatches.slice(0, 8);
        for (const m of shown) {
          const addr = "$" + m.address.toString(16).toUpperCase().padStart(4, "0");
          log(`  ${m.region} ${addr}${m.inverted ? " (inverted)" : ""}`);
        }
        if (el.memoryMatches.length > 8) {
          log(`  ... and ${el.memoryMatches.length - 8} more matches`);
        }
      } else {
        log("  No memory pattern matches found");
      }
    });
    btnPickElement.classList.add("active");
    log("Element picker activated — click on screen to inspect");
  }
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

// --- Virtual Keyboard (image-overlay approach) ---

interface VkbdHitbox {
  row: number;
  bit: number;
  x: number;   // % from left
  y: number;   // % from top
  w: number;   // % width
  h: number;   // % height
  isShift?: "cs" | "ss";
}

// Key hitbox coordinates as percentages of the keyboard image (2700×1114)
// Measured via pixel analysis of the actual PNG
function buildHitboxLayout(): VkbdHitbox[] {
  const keys: VkbdHitbox[] = [];
  const kH = 11.8; // all keys same height

  // Row 1: numbers 1-0 (y=13.5%)
  // Spectrum matrix: row3 bits 0-4 = keys 1-5, row4 bits 4-0 = keys 6-0
  const r1Y = 13.5;
  const r1X = [2.7, 11.7, 20.8, 29.8, 38.8, 47.9, 56.9, 65.9, 74.8, 83.5];
  const r1Spec: [number, number][] = [[3,0],[3,1],[3,2],[3,3],[3,4],[4,4],[4,3],[4,2],[4,1],[4,0]];
  for (let i = 0; i < 10; i++) {
    keys.push({ row: r1Spec[i][0], bit: r1Spec[i][1], x: r1X[i], y: r1Y, w: 6.8, h: kH });
  }

  // Row 2: Q-P (y=35.7%)
  // Spectrum matrix: row2 bits 0-4 = Q-T, row5 bits 4-0 = Y-P
  const r2Y = 35.7;
  const r2X = [7.5, 16.5, 25.6, 34.6, 43.6, 52.6, 61.7, 70.6, 79.6, 88.2];
  const r2Spec: [number, number][] = [[2,0],[2,1],[2,2],[2,3],[2,4],[5,4],[5,3],[5,2],[5,1],[5,0]];
  for (let i = 0; i < 10; i++) {
    keys.push({ row: r2Spec[i][0], bit: r2Spec[i][1], x: r2X[i], y: r2Y, w: 6.8, h: kH });
  }

  // Row 3: A-L + ENTER (y=57.6%)
  // Spectrum matrix: row1 bits 0-4 = A-G, row6 bits 4-0 = H-ENTER
  const r3Y = 57.6;
  const r3X = [10.1, 19.1, 28.1, 37.2, 46.2, 55.2, 64.3, 73.3, 82.0];
  const r3Spec: [number, number][] = [[1,0],[1,1],[1,2],[1,3],[1,4],[6,4],[6,3],[6,2],[6,1]];
  for (let i = 0; i < 9; i++) {
    keys.push({ row: r3Spec[i][0], bit: r3Spec[i][1], x: r3X[i], y: r3Y, w: 6.8, h: kH });
  }
  // ENTER is wider
  keys.push({ row: 6, bit: 0, x: 90.9, y: r3Y, w: 8.7, h: kH });

  // Row 4: CAPS, Z-M, SYM, SPACE (y=79.8%)
  // Spectrum matrix: row0 = CAPS+Z-V, row7 = SPACE+SYM+M-B
  const r4Y = 79.8;
  keys.push(
    { row: 0, bit: 0, x: 3.8,  y: r4Y, w: 8.3,  h: kH, isShift: "cs" }, // CAPS SHIFT
    { row: 0, bit: 1, x: 14.5, y: r4Y, w: 6.8,  h: kH },                // Z
    { row: 0, bit: 2, x: 23.5, y: r4Y, w: 6.8,  h: kH },                // X
    { row: 0, bit: 3, x: 32.5, y: r4Y, w: 6.8,  h: kH },                // C
    { row: 0, bit: 4, x: 41.6, y: r4Y, w: 6.8,  h: kH },                // V
    { row: 7, bit: 4, x: 50.6, y: r4Y, w: 6.8,  h: kH },                // B
    { row: 7, bit: 3, x: 59.6, y: r4Y, w: 6.8,  h: kH },                // N
    { row: 7, bit: 2, x: 68.6, y: r4Y, w: 6.8,  h: kH },                // M
    { row: 7, bit: 1, x: 77.7, y: r4Y, w: 6.8,  h: kH, isShift: "ss" }, // SYM SHIFT
    { row: 7, bit: 0, x: 86.5, y: r4Y, w: 11.1, h: kH },                // SPACE
  );

  return keys;
}

const VKBD_HITBOXES = buildHitboxLayout();

const btnVkbd = document.getElementById("btn-vkbd") as HTMLButtonElement;
const vkbdPanel = document.getElementById("vkbd-panel")!;
const vkbdClose = vkbdPanel.querySelector(".vkbd-close") as HTMLButtonElement;
const vkbdKeysContainer = document.getElementById("vkbd-keys")!;
const vkbdModeEl = document.getElementById("vkbd-mode")!;

// Add the keyboard image
const vkbdImg = document.createElement("img");
vkbdImg.src = "/images/zx48-keyboard.png";
vkbdImg.alt = "ZX Spectrum 48K Keyboard";
vkbdImg.draggable = false;
vkbdKeysContainer.appendChild(vkbdImg);

// Shift states
let csActive = false;
let ssActive = false;
let csOverlay: HTMLElement | null = null;
let ssOverlay: HTMLElement | null = null;

function updateModeIndicator() {
  if (csActive && ssActive) {
    vkbdModeEl.textContent = "Extended (CS+SS)";
  } else if (csActive) {
    vkbdModeEl.textContent = "CAPS SHIFT";
  } else if (ssActive) {
    vkbdModeEl.textContent = "SYM SHIFT";
  } else {
    vkbdModeEl.textContent = "Normal";
  }
}

// Build overlay hitboxes over the image
for (const hb of VKBD_HITBOXES) {
  const div = document.createElement("div");
  div.className = "vkbd-hitbox";
  div.style.left = `${hb.x}%`;
  div.style.top = `${hb.y}%`;
  div.style.width = `${hb.w}%`;
  div.style.height = `${hb.h}%`;

  // Register in overlay map for physical keyboard highlighting
  vkbdOverlayMap.set(`${hb.row}_${hb.bit}`, div);

  // Track shift overlays
  if (hb.isShift === "cs") csOverlay = div;
  if (hb.isShift === "ss") ssOverlay = div;

  // --- Mouse/touch interaction ---
  const pressKey = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();

    if (hb.isShift === "cs") {
      csActive = !csActive;
      div.classList.toggle("shift-active", csActive);
      spectrum.io.setKey(0, 0, csActive);
      updateModeIndicator();
      return;
    }
    if (hb.isShift === "ss") {
      ssActive = !ssActive;
      div.classList.toggle("shift-active", ssActive);
      spectrum.io.setKey(7, 1, ssActive);
      updateModeIndicator();
      return;
    }

    // Non-shift key: also press active sticky shifts
    if (csActive) spectrum.io.setKey(0, 0, true);
    if (ssActive) spectrum.io.setKey(7, 1, true);
    spectrum.io.setKey(hb.row, hb.bit, true);
    div.classList.add("pressed");
  };

  const releaseKey = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (hb.isShift) return;

    spectrum.io.setKey(hb.row, hb.bit, false);
    div.classList.remove("pressed");

    // Auto-release sticky shifts after one key press
    if (csActive) {
      spectrum.io.setKey(0, 0, false);
      csActive = false;
      csOverlay?.classList.remove("shift-active");
    }
    if (ssActive) {
      spectrum.io.setKey(7, 1, false);
      ssActive = false;
      ssOverlay?.classList.remove("shift-active");
    }
    updateModeIndicator();
  };

  div.addEventListener("mousedown", pressKey);
  div.addEventListener("mouseup", releaseKey);
  div.addEventListener("mouseleave", (e) => {
    if (hb.isShift) return;
    if (div.classList.contains("pressed")) releaseKey(e);
  });
  div.addEventListener("touchstart", pressKey, { passive: false });
  div.addEventListener("touchend", releaseKey, { passive: false });

  vkbdKeysContainer.appendChild(div);
}

// Set initial width for the resizable panel
vkbdPanel.style.width = "680px";

// Toggle visibility
btnVkbd.addEventListener("click", () => {
  const isVisible = vkbdPanel.classList.toggle("visible");
  btnVkbd.classList.toggle("active", isVisible);
  if (isVisible) {
    const pw = vkbdPanel.offsetWidth;
    const ph = vkbdPanel.offsetHeight;
    vkbdPanel.style.left = `${Math.max(0, (window.innerWidth - pw) / 2)}px`;
    vkbdPanel.style.top = `${Math.max(0, (window.innerHeight - ph) / 2)}px`;
  }
});

vkbdClose.addEventListener("click", () => {
  vkbdPanel.classList.remove("visible");
  btnVkbd.classList.remove("active");
});

// Dragging
{
  const titlebar = vkbdPanel.querySelector(".vkbd-titlebar") as HTMLElement;
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  titlebar.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).classList.contains("vkbd-close")) return;
    dragging = true;
    dragOffsetX = e.clientX - vkbdPanel.offsetLeft;
    dragOffsetY = e.clientY - vkbdPanel.offsetTop;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    let x = e.clientX - dragOffsetX;
    let y = e.clientY - dragOffsetY;
    x = Math.max(0, Math.min(x, window.innerWidth - vkbdPanel.offsetWidth));
    y = Math.max(0, Math.min(y, window.innerHeight - vkbdPanel.offsetHeight));
    vkbdPanel.style.left = `${x}px`;
    vkbdPanel.style.top = `${y}px`;
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
  });
}

// --- Right panel resizer ---
{
  const resizer = document.getElementById("panel-resizer")!;
  const rightPanel = document.querySelector(".right-panel") as HTMLElement;
  let resizing = false;
  let startX = 0;
  let startW = 0;

  resizer.addEventListener("mousedown", (e) => {
    resizing = true;
    startX = e.clientX;
    startW = rightPanel.offsetWidth;
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    // Dragging left increases width, dragging right decreases
    const delta = startX - e.clientX;
    const newW = Math.max(180, Math.min(500, startW + delta));
    rightPanel.style.width = `${newW}px`;
  });

  document.addEventListener("mouseup", () => {
    if (resizing) {
      resizing = false;
      document.body.style.cursor = "";
    }
  });
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

    log("ZX Spectrum 48K emulator ready");
    log("Z80 CPU: lkesteloot/z80-emulator (MIT, 1356 FUSE tests)");
    log("ROMs: Original Amstrad + OpenSE BASIC (GPL v2)");
    log("");
    log("Bot API in console: window.bot / window.spectrum");

    // Auto-play on boot
    await initAudio();
    startEmulation();
  } catch (e) {
    console.error("Boot failed:", e);
    statusEl.textContent = `Error: ${e}`;
    log(`BOOT ERROR: ${e}`);
  }
})();
