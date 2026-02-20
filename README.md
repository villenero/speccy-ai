```
   _____ ____  ______ _____ _______     __          ___  ___
  / ____|  _ \|  ____/ ____|__   __|    \ \   /\   |_ _||_ _|
 | (___ | |_) | |__ | |       | | _____ _\ \ /  \   | |  | |
  \___ \|  __/|  __|| |       | ||_____/ __| / /\ \  | |  | |
  ____) | |   | |___| |____   | |     | (__|| /  \ | | |  | |
 |_____/|_|   |______\_____|  |_|      \___||_/  \_||___||___|

 ░▒▓█  Z X   S P E C T R U M   4 8 K   E M U L A T O R  █▓▒░
      ─────── for AI game analysis & retro fun ───────
```

# Speccy AI

A **pixel-perfect ZX Spectrum 48K emulator** running entirely in the browser, built with TypeScript and designed for both retro gaming and AI-powered game analysis.

## Features

### Emulation Core
- **Cycle-accurate Z80 CPU** — based on [lkesteloot/z80-emulator](https://github.com/lkesteloot/z80-emulator), passing 1356 FUSE tests
- **Pixel-perfect ULA rendering** — 352x288 output with border, attribute flash, and contention timing
- **1-bit beeper audio** — via Web Audio API worklet for glitch-free sound
- **Full keyboard input** — physical keyboard mapping + floating virtual keyboard with shift modes
- **Dual ROM support** — Original Amstrad ROM and OpenSE BASIC (GPL v2)

### File Format Support
| Format | Type | Description |
|--------|------|-------------|
| `.sna` | Snapshot | Load & save 48K SNA snapshots |
| `.z80` | Snapshot | Load Z80 v1/v2/v3 snapshots |
| `.tap` | Tape | Standard TAP tape images |
| `.tzx` | Tape | TZX tape images (standard, turbo & pure data blocks) |

Tape loading uses a **ROM trap at `$0556`** (LD-BYTES) for instant loading — no audio simulation needed. When a `.tap`/`.tzx` is loaded, the emulator resets, boots BASIC, injects `LOAD ""`, and intercepts the ROM's load routine to copy blocks directly into memory.

### AI Capture Tools
- **Frame Capture** — grab individual frames or turbo-capture 100 frames at once
- **Snapshot Gallery** — save/restore SNA snapshots with visual thumbnails
- **Text Detection** — OCR-like detection of on-screen text using the Spectrum font
- **Sprite Detection** — identifies moving objects across frame diffs
- **Tile Detection** — finds repeated patterns in the display
- **Element Picker** — click on screen to inspect characters, sprites, and memory locations
- **Input Recording** — record and replay keyboard input sessions
- **Memory Search** — find byte values in RAM with progressive narrowing

### UI
- Drag & drop files directly onto the screen
- Resizable sidebar with all tools
- Display scaling: Auto / 1x / 2x / 4x / 8x / Fullscreen
- Frame stepping for debugging
- Console API: `window.bot` / `window.spectrum`

## Quick Start

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser.

### Load a game

1. **Drag & drop** a `.sna`, `.z80`, `.tap`, or `.tzx` file onto the screen
2. Or click **Load Snapshot** and pick a file
3. Tape files (`.tap`/`.tzx`) auto-boot with `LOAD ""`

## Architecture

```
src/
├── core/               # Emulation engine
│   ├── z80/            # Z80 CPU (registers, decoder, flags)
│   ├── spectrum.ts     # Main emulator class (ties CPU + ULA + IO)
│   ├── memory.ts       # 64KB memory map (16K ROM + 48K RAM)
│   ├── ula.ts          # Video + contention timing
│   ├── io.ts           # Port I/O (keyboard, ULA, beeper)
│   ├── beeper.ts       # 1-bit audio generation
│   └── tape-manager.ts # ROM trap tape loading
├── formats/            # File format parsers
│   ├── sna.ts          # SNA snapshot load/save
│   ├── z80format.ts    # Z80 snapshot loader
│   ├── tap.ts          # TAP tape parser
│   └── tzx.ts          # TZX tape parser
├── video/
│   └── renderer.ts     # Canvas rendering
├── audio/
│   ├── audio-manager.ts
│   └── worklet.ts      # AudioWorklet processor
├── input/
│   └── keyboard.ts     # Physical keyboard mapping
├── capture/            # AI analysis tools
│   ├── bot-api.ts      # High-level API for game analysis
│   ├── frame-capture.ts
│   ├── sprite-detector.ts
│   ├── element-picker.ts
│   ├── input-recorder.ts
│   ├── memory-watch.ts
│   └── state-snapshot.ts
└── main.ts             # UI wiring & boot
```

## Console API

Open DevTools and use the full emulator API:

```js
// Capture a frame
bot.getFrame(true)

// Detect text on screen
bot.detectText()

// Search for a value in RAM
bot.searchValue(42)

// Direct CPU/memory access
spectrum.cpu.regs.pc
spectrum.memory.read(0x4000)

// Run N frames in turbo mode
spectrum.runFrames(500)
```

## Tech Stack

- **TypeScript** — strict mode, zero runtime dependencies
- **Vite** — dev server & build
- **Web Audio API** — AudioWorklet for beeper output
- **Canvas 2D** — pixel-perfect rendering with `image-rendering: pixelated`

## License

Z80 CPU core: MIT (lkesteloot/z80-emulator)
OpenSE BASIC ROM: GPL v2
