# Plan: Emulador Pixel-Perfect del ZX Spectrum 48K en el Navegador

## Objetivo

Emular con precisión de ciclo (cycle-accurate) un ZX Spectrum 48K en un navegador web moderno, incluyendo efectos de borde multicolor, contended memory, audio del beeper y carga de cintas. El resultado debe ser indistinguible del hardware original a nivel de píxel.

**Caso de uso principal:** Extraer fotogramas, secuencias de video y datos estructurados de juegos en ejecucion, para que una IA pueda analizar la logica del juego y generar un remake moderno.

---

## Arquitectura General

```
┌─────────────────────────────────────────────────────┐
│                    Main Thread                       │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ UI/React │  │  Canvas   │  │ Keyboard / Input │ │
│  │ Controls │  │ Renderer  │  │    Handler       │ │
│  └────┬─────┘  └─────┬─────┘  └────────┬─────────┘ │
│       │              │                  │            │
│       └──────────────┼──────────────────┘            │
│                      │ SharedArrayBuffer             │
│ ─────────────────────┼───────────────────────────── │
│                      │                               │
│  ┌───────────────────┴───────────────────────────┐  │
│  │              Web Worker                        │  │
│  │  ┌─────────┐  ┌─────┐  ┌──────┐  ┌────────┐ │  │
│  │  │ Z80 CPU │  │ ULA │  │ MEM  │  │ Beeper │ │  │
│  │  │  (WASM) │  │     │  │ 64KB │  │        │ │  │
│  │  └─────────┘  └─────┘  └──────┘  └────────┘ │  │
│  └───────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │           AudioWorklet Thread                 │   │
│  │  ┌─────────────────────────────────────────┐ │   │
│  │  │  Ring Buffer → AudioWorkletProcessor    │ │   │
│  │  └─────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Justificacion de la arquitectura:**
- **Web Worker** para el core de emulacion: evita bloquear el hilo principal (UI permanece responsiva a 50fps)
- **SharedArrayBuffer** para el framebuffer y estado del teclado: comunicacion zero-copy entre Worker y Main Thread
- **AudioWorklet** para audio: hilo dedicado evita glitches de audio bajo carga de CPU
- **WASM (AssemblyScript o Rust→wasm)**: rendimiento cercano a nativo para el core Z80 + ULA

---

## Modulos del Proyecto

### 1. CPU Z80 — Core de Ejecucion

**Que reutilizar:**
- **JSSpeccy3** (GPL-3.0) — Core Z80 en AssemblyScript/WASM. El mas probado para Spectrum. Incluye contended memory inline.
- **DrGoldfire/Z80.js** (MIT) — Core standalone limpio, pasa ZEXALL. API sencilla: `run_instruction()` devuelve T-states.
- **lkesteloot/z80-emulator** (MIT) — Core en TypeScript puro, opcodes autogenerados desde tablas de datos.

**Que implementar:**
- Todas las instrucciones documentadas y no documentadas del Z80
- Registro MEMPTR/WZ (interno, afecta flags en BIT n,(HL))
- Registro R con comportamiento exacto de 7 bits (bit 7 solo via `LD R,A`)
- Contador de T-states por acceso a memoria individual (no por instruccion)
- Interrupciones IM1: aceptacion en 13 T-states, muestreo en flanco del ultimo ciclo

**Tests de validacion:**
- ZEXALL (exhaustivo, todas las instrucciones)
- FUSE test suite (incluye tests de timing y flags no documentados)
- Woody's Z80 tests

**Estimacion:** ~3,000-4,000 lineas si se escribe desde cero; ~500 lineas de integracion si se reutiliza un core existente.

---

### 2. ULA — Video y Timing

**Especificaciones exactas:**

| Parametro | Valor |
|-----------|-------|
| T-states por frame | 69,888 |
| Scanlines por frame | 312 |
| T-states por scanline | 224 |
| Frecuencia de refresco | 50.08 Hz |
| Borde superior | 64 lineas |
| Area de display | 192 lineas |
| Borde inferior | 56 lineas |
| Pixeles por T-state | 2 |
| Resolucion de display | 256 x 192 |
| Resolucion visible total | 352 x 296 (con bordes) |

**Renderizado diferido (tecnica de JSSpeccy3):**

En lugar de renderizar pixel a pixel en sincronía con la CPU (costoso), se usa un enfoque de "deferred rendering":

1. Durante la ejecucion del frame, registrar en un log:
   - Cada escritura al border (port $FE bits 0-2) con su T-state exacto
   - Cada escritura a la memoria de pantalla ($4000-$5AFF) con su T-state
2. Al final del frame (o antes de cualquier lectura del framebuffer), reconstruir la imagen:
   - Recorrer los 312 scanlines en orden
   - Para cada T-state del scanline, consultar el border color vigente
   - Para el area activa, leer pixel data + attributes de la RAM en el orden que lo haria la ULA

**Contended Memory:**

La ULA comparte el bus con la CPU para las direcciones $4000-$7FFF. Durante el display activo, la ULA "roba" ciclos a la CPU:

```
Patron de retraso (se repite cada 8 T-states):
Offset:  0  1  2  3  4  5  6  7
Delay:   6  5  4  3  2  1  0  0
```

- Primera contencion del frame: T-state 14,335 tras la interrupcion
- Se aplica a CADA acceso individual a memoria contendida (no por instruccion)
- Tambien afecta a I/O (ver tabla de 4 casos en seccion I/O)

**Contention en I/O (4 casos):**

| High byte contended? | Bit 0 (ULA?) | Patron |
|---------------------|---------------|--------|
| No | 0 (ULA) | N:1, C:3 |
| No | 1 | N:4 |
| Si | 0 (ULA) | C:1, C:3 |
| Si | 1 | C:1, C:1, C:1, C:1 |

**Atributos y colores:**

```
Byte de atributo: [FLASH | BRIGHT | PAPER2 PAPER1 PAPER0 | INK2 INK1 INK0]
                   bit 7   bit 6    bits 5-3                bits 2-0
```

Paleta (16 colores = 8 normales + 8 brillantes):

| Color | Normal (R,G,B) | Bright (R,G,B) |
|-------|----------------|-----------------|
| Black | (0,0,0) | (0,0,0) |
| Blue | (0,0,205) | (0,0,255) |
| Red | (205,0,0) | (255,0,0) |
| Magenta | (205,0,205) | (255,0,255) |
| Green | (0,205,0) | (0,255,0) |
| Cyan | (0,205,205) | (0,255,255) |
| Yellow | (205,205,0) | (255,255,0) |
| White | (205,205,205) | (255,255,255) |

- FLASH: conmuta INK/PAPER cada 16 frames (global, no por celda)

**Memoria de pantalla — Layout no lineal:**

```
Direccion del pixel (x, y):
  High byte: 010 Y7 Y6 Y2 Y1 Y0
  Low byte:  Y5 Y4 Y3 X4 X3 X2 X1 X0

Donde x = columna de caracter (0-31), los bits Y se intercalan entre tercios.
```

3 tercios de 64 lineas cada uno:
- Tercio 0: $4000-$47FF (lineas 0-63)
- Tercio 1: $4800-$4FFF (lineas 64-127)
- Tercio 2: $5000-$57FF (lineas 128-191)

Atributos: $5800-$5AFF, lineales (32 bytes/fila x 24 filas).

---

### 3. Memoria — 64KB Map

```
$0000-$3FFF  ROM 16KB (Sinclair BASIC) — solo lectura, sin contencion
$4000-$57FF  Pixel data (6,144 bytes) — contendida
$5800-$5AFF  Attributes (768 bytes) — contendida
$5B00-$7FFF  RAM libre — contendida
$8000-$FFFF  RAM 32KB superior — sin contencion
```

**Que necesitamos:**
- Array de 65,536 bytes (Uint8Array o similar en WASM)
- ROM del ZX Spectrum 48K (16KB) — disponible como `48.rom`, copyright Amstrad pero con uso libre autorizado para emuladores
- Funciones `readByte(addr)` y `writeByte(addr, val)` que apliquen contention delay segun el T-state actual

---

### 4. Teclado — Matriz 8x5

**Mapeo de puertos:**

```
Puerto     | Bit4 | Bit3 | Bit2 | Bit1 | Bit0
$FEFE (A8) |  V   |  C   |  X   |  Z   | CAPS SHIFT
$FDFE (A9) |  G   |  F   |  D   |  S   |  A
$FBFE (A10)|  T   |  R   |  E   |  W   |  Q
$F7FE (A11)|  5   |  4   |  3   |  2   |  1
$EFFE (A12)|  6   |  7   |  8   |  9   |  0
$DFFE (A13)|  Y   |  U   |  I   |  O   |  P
$BFFE (A14)|  H   |  J   |  K   |  L   | ENTER
$7FFE (A15)|  B   |  N   |  M   | SYM  | SPACE
```

- Bits 0-4: estado de teclas (0=pulsada, 1=no pulsada)
- Bit 6: entrada EAR (cinta)
- Multiples half-rows se pueden leer simultaneamente (AND de resultados)

**Implementacion:**
- Array de 8 bytes (uno por half-row) en SharedArrayBuffer
- El Main Thread escribe el estado segun `keydown`/`keyup` del navegador
- El Worker lee el array en cada `IN $FE`
- Mapear teclas PC → teclas Spectrum (incluir combinaciones como Shift+Symbol para signos de puntuacion)

---

### 5. Audio — Beeper 1-bit

**Hardware emulado:**
- Bit 4 de port $FE: salida al altavoz (EAR)
- Bit 3 de port $FE: salida MIC (mas debil, pero contribuye al sonido)
- Sin DAC, sin envolvente, sin volumen — solo ON/OFF

**Implementacion con AudioWorklet:**

```
[Web Worker]                    [AudioWorklet Thread]
     │                                │
     │  Escribe samples en           │
     │  ring buffer (SAB)            │
     │  ──────────────────>          │
     │                        Lee samples del
     │                        ring buffer y los
     │                        envia al DAC
     │                                │
```

1. Durante la ejecucion del frame, en cada `OUT` al puerto $FE:
   - Calcular cuantas muestras de audio corresponden desde el ultimo OUT
   - Rellenar el ring buffer con el valor del beeper (0.0 o 1.0)
2. Al final del frame, rellenar el resto del buffer hasta completar 69,888 T-states
3. El AudioWorkletProcessor lee del ring buffer y produce la salida

**Frecuencia de muestreo:** 44,100 Hz o 48,000 Hz
- A 44,100 Hz: cada sample = ~79.4 T-states (3,500,000 / 44,100)
- Se necesita interpolacion para evitar aliasing en motores de beeper multicanal

---

### 6. Carga de Cintas — TAP y TZX

**Dos modos de carga:**

1. **Carga rapida (ROM trap):** Interceptar la llamada a la rutina ROM en $0556. Cuando la CPU llega ahi, inyectar los datos del bloque directamente en memoria. Instantaneo pero no funciona con turbo-loaders custom.

2. **Carga real (emulacion de senal):** Generar los pulsos de cinta en tiempo real:

| Componente | T-states por pulso |
|---|---|
| Tono piloto | 2,168 (8,063 pulsos header / 3,223 pulsos datos) |
| Sync 1 | 667 |
| Sync 2 | 735 |
| Bit 0 | 855 (x2 pulsos) |
| Bit 1 | 1,710 (x2 pulsos) |

**Formatos soportados:**
- **.TAP**: Secuencia de bloques con longitud de 2 bytes + datos crudos
- **.TZX**: Contenedor con multiples tipos de bloque (ID $10 standard speed, ID $11 turbo, ID $12 pure tone, etc.)
- **.SNA**: Snapshot de memoria (carga instantanea, 49,179 bytes)
- **.Z80**: Snapshot comprimido (multiples versiones)

---

### 7. Puertos I/O

| Puerto | Lectura | Escritura |
|--------|---------|-----------|
| $FE (bit 0 = 0) | Teclado (bits 0-4) + EAR (bit 6) | Border (bits 0-2) + MIC (bit 3) + Speaker (bit 4) |
| $1F | Kempston joystick (bits 0-4) | — |
| Otros | Floating bus (dato que la ULA esta leyendo) | Ignorados |

**Floating bus:** Cuando se lee un puerto no asignado con bit 0 = 1, se devuelve el byte que la ULA esta leyendo en ese momento de la memoria de pantalla. Algunos programas lo usan para sincronizacion sin interrupciones.

---

## Stack Tecnologico Propuesto

| Componente | Tecnologia | Justificacion |
|---|---|---|
| Core Z80 + ULA | **AssemblyScript → WASM** o **Rust → WASM** | Rendimiento cercano a nativo, necesario para cycle-accuracy |
| Web Worker | Worker API nativa | Aislar el core del hilo principal |
| Comunicacion | SharedArrayBuffer | Zero-copy para framebuffer, teclado, audio |
| Audio | AudioWorklet API | Hilo dedicado, baja latencia |
| Renderizado | Canvas 2D (`putImageData`) | Suficiente para copiar un framebuffer; WebGL solo si se quieren shaders CRT |
| UI | HTML/CSS vanilla o Preact | Controles minimos: play/pause, carga de archivos, teclado virtual |
| Formatos | TypeScript en Main Thread | Parseo de TAP/TZX/SNA/Z80 no necesita WASM |
| Build | Vite | Hot reload, soporte WASM nativo, rapido |
| Tests | Vitest + FUSE test suite | Unit tests del Z80 contra FUSE, visual regression |

---

## Codigo Existente a Reutilizar

### Opcion A: Fork de JSSpeccy3 (recomendada para maxima precision)
- **Repo:** https://github.com/gasman/jsspeccy3
- **Licencia:** GPL-3.0
- **Que tiene:** Core Z80 en WASM, ULA cycle-accurate, deferred rendering, contended memory, TAP/TZX, audio
- **Que le falta:** UI moderna, mobile support, shaders CRT
- **Estrategia:** Forkear, modernizar el build (Vite), añadir UI y efectos visuales

### Opcion B: Core Z80 standalone + ULA propia
- **Z80.js (DrGoldfire):** MIT, API limpia, ~3,400 lineas. Usarlo como base del CPU.
- **ULA:** Escribirla desde cero siguiendo las especificaciones de este documento.
- **Ventaja:** Licencia MIT (mas permisiva), control total
- **Desventaja:** Mas trabajo, riesgo de bugs de timing

### Opcion C: Hibrida
- Usar **lkesteloot/z80-emulator** (MIT, TypeScript) como base del Z80
- Portar la logica ULA de JSSpeccy3 (estudiando su enfoque pero reescribiendo)
- Escribir audio y I/O desde cero

---

## Fases de Desarrollo

### Fase 1: Scaffolding y CPU (~1 semana)
- [ ] Setup del proyecto: Vite + TypeScript + WASM toolchain
- [ ] Integrar o escribir el core Z80 (todas las instrucciones)
- [ ] Implementar memoria de 64KB con ROM cargada
- [ ] Validar contra FUSE test suite (al menos instrucciones basicas)
- [ ] Estructura basica: `runFrame()` ejecuta 69,888 T-states

### Fase 2: Video basico (~1 semana)
- [ ] Renderizar la pantalla del Spectrum (256x192) desde la memoria
- [ ] Implementar el layout no lineal de la memoria de video
- [ ] Atributos: INK, PAPER, BRIGHT, FLASH
- [ ] Canvas rendering con `putImageData`
- [ ] Debe mostrar la pantalla de copyright al arrancar con la ROM

### Fase 3: Teclado e Interaccion (~3 dias)
- [ ] Mapeo PC keyboard → Spectrum matrix
- [ ] Lectura de puerto $FE con half-row addressing
- [ ] Debe poder escribir en BASIC y ejecutar programas simples

### Fase 4: Contended Memory y Timing Exacto (~1 semana)
- [ ] Implementar contencion por acceso a memoria individual
- [ ] Contencion I/O (4 casos)
- [ ] Timing exacto de interrupciones (IM1 a T-state 0)
- [ ] Validar contra demos conocidos que dependan de timing (e.g., border effects)

### Fase 5: Audio del Beeper (~3 dias)
- [ ] AudioWorklet con ring buffer en SharedArrayBuffer
- [ ] Muestreo del beeper sincronizado con T-states
- [ ] Fallback a ScriptProcessorNode para Safari <14.1
- [ ] Probar con programas de beeper music (e.g., Tritone engine)

### Fase 6: Carga de Cintas (~3 dias)
- [ ] Parser de formato TAP
- [ ] Parser de formato TZX (al menos bloques standard ID $10)
- [ ] Carga rapida via ROM trap ($0556)
- [ ] Carga real con emulacion de pulsos (para turbo-loaders)
- [ ] Carga de snapshots SNA y Z80

### Fase 7: Polish y Extras (~1 semana)
- [ ] Borde pixel-perfect (efectos multicolor)
- [ ] Floating bus
- [ ] Kempston joystick (Gamepad API)
- [ ] Teclado virtual para movil
- [ ] Shader CRT opcional (scanlines, curvatura, bloom)
- [ ] Sonido EAR durante carga de cinta (las tipicas rayas)
- [ ] Guardar/cargar estado (save states)
- [ ] Selector de velocidad (turbo mode)
- [ ] Drag & drop de archivos

### Fase 8: Modulo de Extraccion para IA (~2 semanas)
- [ ] Frame capture: exportacion de fotogramas individuales (PNG/raw)
- [ ] State snapshots: volcado de registros + RAM + input por frame
- [ ] Modo turbo/headless: emulacion a maxima velocidad sin render
- [ ] Input recorder: grabacion y replay determinista de partidas
- [ ] Bot API: interfaz programatica para que una IA controle el emulador
- [ ] Memory watch: scan diferencial y busqueda de variables de juego
- [ ] Sprite detector: deteccion automatica de sprites via diff de frames
- [ ] Tile extractor: identificacion de patrones repetidos 8x8 / 16x16
- [ ] Text OCR: lectura de texto en pantalla via charset de la ROM
- [ ] Video export: generacion de MP4/WebM via WebCodecs o ffmpeg.wasm
- [ ] Dataset builder: generacion del paquete completo (metadata + frames + assets + recordings)
- [ ] CLI headless: ejecucion en Node.js/Bun para captura masiva sin navegador
- [ ] UI de captura: panel en el navegador para controlar la extraccion interactivamente

---

## Headers HTTP Requeridos

Para usar `SharedArrayBuffer` el servidor debe enviar:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite puede configurarse para esto en `vite.config.ts`:

```typescript
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
```

---

## Estructura de Archivos Propuesta

```
zx-emul/
├── public/
│   └── roms/
│       └── 48.rom              # ROM del ZX Spectrum 48K
├── src/
│   ├── core/                   # Web Worker
│   │   ├── z80.ts              # CPU Z80 (o .as si AssemblyScript)
│   │   ├── ula.ts              # ULA: video timing, contention
│   │   ├── memory.ts           # Mapa de memoria 64KB
│   │   ├── io.ts               # Puertos I/O
│   │   ├── beeper.ts           # Generacion de samples de audio
│   │   └── worker.ts           # Entry point del Web Worker
│   ├── audio/
│   │   └── worklet.ts          # AudioWorkletProcessor
│   ├── formats/
│   │   ├── tap.ts              # Parser TAP
│   │   ├── tzx.ts              # Parser TZX
│   │   ├── sna.ts              # Parser SNA snapshots
│   │   └── z80format.ts        # Parser Z80 snapshots
│   ├── input/
│   │   ├── keyboard.ts         # Mapeo teclado PC → Spectrum
│   │   ├── joystick.ts         # Kempston via Gamepad API
│   │   └── bot-api.ts          # Input programatico para bots/IA
│   ├── video/
│   │   ├── renderer.ts         # Canvas 2D rendering
│   │   └── crt-shader.ts       # Efecto CRT opcional (WebGL)
│   ├── capture/                # Modulo de extraccion para IA
│   │   ├── frame-capture.ts    # Captura de fotogramas (PNG/raw)
│   │   ├── video-export.ts     # Exportacion de video (WebCodecs/ffmpeg.wasm)
│   │   ├── state-snapshot.ts   # Snapshot de estado completo (CPU + RAM + input)
│   │   ├── memory-watch.ts     # Scan diferencial, busqueda de variables
│   │   ├── input-recorder.ts   # Grabacion y replay de inputs
│   │   ├── sprite-detector.ts  # Deteccion automatica de sprites y tiles
│   │   ├── text-ocr.ts         # OCR via charset ROM (score, vidas, mensajes)
│   │   └── dataset-builder.ts  # Genera el dataset estructurado completo
│   ├── ui/
│   │   ├── controls.ts         # Play/Pause, velocidad, etc.
│   │   ├── file-loader.ts      # Drag & drop, file input
│   │   ├── capture-panel.ts    # UI para controles de captura/extraccion
│   │   ├── memory-viewer.ts    # Visor hex + heatmap de escrituras
│   │   └── virtual-keyboard.ts # Teclado tactil para movil
│   ├── headless/               # Ejecucion sin navegador (Node/Bun)
│   │   ├── cli.ts              # Interfaz de linea de comandos
│   │   └── headless-runner.ts  # Emulador sin Canvas, maxima velocidad
│   ├── main.ts                 # Entry point (browser)
│   └── types.ts                # Tipos compartidos
├── tests/
│   ├── z80/                    # Tests del CPU contra FUSE
│   ├── ula/                    # Tests de video timing
│   ├── capture/                # Tests del modulo de extraccion
│   └── formats/                # Tests de parsers
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── PLAN.md                     # Este archivo
```

---

## Modulo 8: Extraccion de Datos para IA (Nuevo)

Este es el modulo diferenciador del proyecto. El emulador no solo reproduce el juego, sino que actua como **instrumento de observacion** para alimentar a una IA con datos estructurados.

### 8.1 Captura de Fotogramas

**Exportacion por frame:**
- Cada frame (50.08 fps) se puede capturar como imagen PNG/raw desde el framebuffer
- Modo headless (sin Canvas): el Worker genera frames sin renderizar en pantalla, a maxima velocidad
- Formato de salida: PNG individual, o secuencia numerada (`frame_000001.png` ... `frame_NNN.png`)
- Resolucion nativa 256x192 (solo display) o 352x296 (con bordes) — sin escalado, sin filtros CRT

```typescript
interface FrameCapture {
  frameNumber: number;       // Numero de frame desde el inicio
  timestamp: number;         // Segundos desde el inicio (frameNumber / 50.08)
  pixels: Uint8Array;        // RGBA 256x192 = 196,608 bytes
  borderColor: number;       // Color del borde dominante en este frame
}
```

**Modo turbo para captura masiva:**
- Desacoplar la emulacion del reloj real: ejecutar frames tan rapido como la CPU lo permita
- Sin audio, sin `requestAnimationFrame` — puro calculo
- Un ZX Spectrum a 3.5 MHz en WASM deberia poder emularse a 50-200x velocidad real en hardware moderno
- Esto permite capturar 10 minutos de gameplay (~30,000 frames) en segundos

### 8.2 Exportacion de Video

**WebCodecs API (navegadores modernos):**
```typescript
const encoder = new VideoEncoder({
  output: (chunk) => muxer.addVideoChunk(chunk),
  error: console.error,
});
encoder.configure({
  codec: 'vp09.00.10.08', // VP9 o 'avc1.42001E' para H.264
  width: 256,
  height: 192,
  framerate: 50,
});
// Por cada frame del emulador:
const vf = new VideoFrame(canvas, { timestamp: frameNum * 20000 }); // 20ms per frame
encoder.encode(vf);
```

**Alternativa: mp4-muxer / webm-muxer (librerias JS):**
- `mp4-muxer` de Vani-GitHub — genera MP4 directamente en el navegador
- `webm-muxer` — genera WebM sin servidor
- Ambas funcionan con WebCodecs

**Alternativa offline: ffmpeg.wasm:**
- Exportar frames como PNG secuencial, luego ensamblar con ffmpeg.wasm
- Mas lento pero maximo control sobre codecs y calidad

### 8.3 Extraccion de Estado Interno (lo mas valioso para la IA)

Mas alla de los pixeles, el estado interno de la maquina revela la **logica** del juego:

```typescript
interface GameStateSnapshot {
  frame: number;

  // CPU
  registers: {
    AF: number; BC: number; DE: number; HL: number;
    IX: number; IY: number; SP: number; PC: number;
    AF_: number; BC_: number; DE_: number; HL_: number;
  };

  // Memoria relevante del juego
  screenPixels: Uint8Array;      // $4000-$57FF (6144 bytes)
  screenAttrs: Uint8Array;       // $5800-$5AFF (768 bytes)
  gameVariables: Uint8Array;     // Rango configurable (ej: $8000-$8FFF)

  // Input del jugador en este frame
  keysPressed: string[];         // ["Q", "SPACE", ...]
  kempston: number;              // Estado del joystick

  // Metadata
  borderColor: number;
  beeperState: boolean;          // ON/OFF del beeper
}
```

**Por que esto importa:** Una IA que solo ve pixeles necesita "adivinar" las variables del juego (vidas, puntuacion, posicion del jugador). Si le damos acceso a la RAM, puede correlacionar directamente los cambios de memoria con lo que ve en pantalla.

### 8.4 Memory Watch — Deteccion Automatica de Variables

Herramienta para identificar automaticamente que direcciones de memoria corresponden a variables del juego:

1. **Scan diferencial:** Comparar la RAM entre frames consecutivos. Las direcciones que cambian cuando el jugador pierde una vida probablemente son el contador de vidas.
2. **Busqueda por valor:** "Busco la direccion que contiene el valor 3" → el jugador tiene 3 vidas → cambiar vidas → "ahora busco entre esas las que contienen 2" → localizada.
3. **Heatmap de escrituras:** Registrar que direcciones de memoria escribe la CPU en cada frame. Las zonas calientes son las variables activas del game loop.
4. **Exportar mapa de variables:**

```typescript
interface GameVariableMap {
  gameName: string;
  variables: {
    name: string;         // "lives", "score", "player_x", "player_y"
    address: number;      // $8000
    size: 1 | 2;          // bytes
    encoding: 'binary' | 'bcd';  // BCD comun en juegos Spectrum
    range?: [number, number];     // min/max observados
  }[];
}
```

### 8.5 Input Recording & Replay

Grabar las acciones del jugador para poder reproducir una partida identica:

```typescript
interface InputRecording {
  game: string;               // Nombre/hash del snapshot
  inputs: {
    frame: number;            // Frame exacto del input
    keys: number[];           // Estado de los 8 half-rows del teclado
    kempston: number;         // Estado del joystick
  }[];
}
```

**Usos:**
- **Replay determinista:** El Spectrum es 100% determinista — mismo snapshot + mismos inputs = misma ejecucion exacta. Se puede reproducir una partida sin almacenar frames.
- **Dataset de entrenamiento:** Grabar a un humano jugando, luego generar pares (frame, accion) para entrenar una IA.
- **Automated testing:** Inyectar inputs programaticamente para explorar el juego sin intervencion humana.

### 8.6 Input Programatico — Bot API

Permitir que un script externo (o una IA) controle el emulador:

```typescript
interface EmulatorAPI {
  // Control
  loadSnapshot(data: Uint8Array): void;
  runFrames(count: number): void;           // Avanzar N frames
  runUntilPC(address: number): void;        // Ejecutar hasta que PC llegue a una direccion

  // Lectura
  getFrame(): ImageData;                    // Capturar frame actual
  getMemory(start: number, length: number): Uint8Array;
  getRegisters(): Z80Registers;

  // Input
  pressKeys(keys: string[]): void;          // Pulsar teclas
  releaseKeys(keys: string[]): void;
  setKempston(state: number): void;

  // Observacion
  onFrame(callback: (state: GameStateSnapshot) => void): void;
  onMemoryWrite(address: number, callback: (value: number) => void): void;
  onPC(address: number, callback: () => void): void;  // Breakpoint
}
```

**Caso de uso completo:**
```
1. IA carga un snapshot del juego
2. IA observa el frame, lee la memoria
3. IA decide una accion (press RIGHT + FIRE)
4. Emulador avanza 1 frame
5. IA observa el resultado
6. Repetir → la IA construye un modelo mental del juego
```

### 8.7 Sprite Detection — Analisis Visual Automatico

Detectar sprites automaticamente comparando frames:

1. **Diff de frames:** Restar frame N - frame N-1. Los pixeles que cambian son sprites en movimiento o animaciones.
2. **Bounding boxes:** Agrupar pixeles cambiados en rectangulos. Cada grupo es un sprite candidato.
3. **Sprite sheet extraction:** Si un sprite se mueve por la pantalla, capturar todas sus poses unicas y exportar un sprite sheet.
4. **Deteccion de tiles:** Analizar el area de juego buscando patrones repetidos de 8x8 o 16x16 para extraer el tileset.
5. **Deteccion de fuente:** Comparar las celdas de 8x8 del area de texto con el charset de la ROM para hacer OCR del texto en pantalla (puntuacion, vidas, mensajes).

```typescript
interface SpriteDetectionResult {
  frame: number;
  sprites: {
    id: number;
    x: number; y: number;
    width: number; height: number;
    pixels: Uint8Array;       // Bitmap del sprite
    color: { ink: number; paper: number; bright: boolean };
  }[];
  tiles: {
    hash: string;             // Hash del patron 8x8
    positions: [number, number][];  // Donde aparece en pantalla
    pixels: Uint8Array;
  }[];
  text: {
    x: number; y: number;
    content: string;          // Texto detectado via OCR del charset ROM
  }[];
}
```

### 8.8 Formato de Dataset para la IA

Estructura propuesta para el dataset completo que consumira la IA de remakes:

```
dataset/
├── game_metadata.json          # Nombre, genero, controles, resolucion
├── variable_map.json           # Mapa de variables detectadas
├── sprite_sheet.png            # Todos los sprites unicos extraidos
├── tileset.png                 # Tiles unicos extraidos
├── font.png                    # Charset del juego
├── frames/
│   ├── frame_000001.png        # Fotogramas clave (no todos, solo cambios)
│   ├── frame_000001.json       # Estado de memoria + input de ese frame
│   └── ...
├── recordings/
│   ├── playthrough_01.jsonl    # Input recording de una partida completa
│   └── playthrough_02.jsonl
├── analysis/
│   ├── screen_regions.json     # Mapa de zonas: "score_area", "play_area", "lives_area"
│   ├── game_states.json        # FSM detectada: menu → playing → dead → game_over
│   └── sprite_behaviors.json   # Patrones de movimiento observados por sprite
└── video/
    └── full_playthrough.mp4    # Video para referencia visual
```

**`game_metadata.json` ejemplo:**
```json
{
  "name": "Manic Miner",
  "genre": "platformer",
  "year": 1983,
  "controls": {
    "left": "CAPS+Z or Kempston LEFT",
    "right": "CAPS+X or Kempston RIGHT",
    "jump": "SPACE or Kempston FIRE"
  },
  "screen_layout": {
    "play_area": { "x": 0, "y": 0, "w": 256, "h": 160 },
    "status_bar": { "x": 0, "y": 160, "w": 256, "h": 32 },
    "score_display": { "x": 64, "y": 168, "w": 48, "h": 8 }
  },
  "known_variables": {
    "lives": { "address": "0x8455", "size": 1 },
    "score": { "address": "0x8456", "size": 3, "encoding": "bcd" },
    "current_level": { "address": "0x8459", "size": 1 }
  }
}
```

### 8.9 Modo Headless / CLI

Para extraccion masiva, el emulador debe poder correr sin navegador:

- **Node.js + WASM:** El core WASM es el mismo; solo se sustituye Canvas por escritura a disco
- **Deno/Bun:** Alternativas viables
- Comando ejemplo:

```bash
# Capturar 5000 frames a maxima velocidad, exportar como PNG + estado
node zx-capture.js --snapshot manic_miner.z80 --frames 5000 --output ./dataset/
# Generar video
node zx-capture.js --snapshot manic_miner.z80 --frames 15000 --video output.mp4
# Replay con input recording
node zx-capture.js --snapshot manic_miner.z80 --replay playthrough.jsonl --output ./dataset/
```

### 8.10 Sugerencias para el Pipeline IA → Remake

**Paso 1: Captura automatizada**
- Cargar el juego, jugar manualmente o con bot, capturar todo

**Paso 2: Analisis con vision (Claude / GPT-4V)**
- Enviar frames clave + metadata a un modelo multimodal
- Prompt: "Analiza estos fotogramas de un juego de ZX Spectrum. Describe: genero, mecanicas, tipos de enemigos, estructura de niveles, patron de movimiento del jugador"

**Paso 3: Extraccion de assets**
- Sprite detection automatica → sprite sheet limpio
- Tile detection → tileset reutilizable
- Font extraction → texto legible

**Paso 4: Ingenieria inversa asistida**
- Memory watch + input recording → correlacionar acciones con cambios en RAM
- La IA puede formular hipotesis: "la direccion $8455 decrementa cuando el sprite del jugador colisiona con un enemigo → es el contador de vidas"

**Paso 5: Generacion del remake**
- Con todos los datos, pedirle a la IA que genere:
  - Game design document basado en lo observado
  - Codigo del remake en un engine moderno (Phaser, Godot, Unity)
  - Usando los sprites/tiles extraidos (o generando versiones HD)

---

## Referencias Clave

- **JSSpeccy3:** https://github.com/gasman/jsspeccy3 (GPL-3.0) — Referencia de implementacion
- **JSSpeccy3 Tech Notes:** https://github.com/gasman/jsspeccy3/blob/main/tech_notes.md
- **Z80.js (DrGoldfire):** https://github.com/DrGoldfire/Z80.js (MIT) — Core Z80 reutilizable
- **z80-emulator:** https://github.com/lkesteloot/z80-emulator (MIT) — Core Z80 en TypeScript
- **MinZX:** https://github.com/dcrespo3d/MinZX (MIT) — Referencia educativa
- **ZX-Dream:** https://github.com/XMypuK/zx-dream (MIT) — AudioWorklet + Web Worker
- **48K Reference:** https://worldofspectrum.org/faq/reference/48kreference.htm
- **Contended Memory:** https://sinclair.wiki.zxnet.co.uk/wiki/Contended_memory
- **FUSE Test Suite:** https://fuse-emulator.sourceforge.io/ — Tests del Z80
- **The Undocumented Z80:** http://www.z80.info/zip/z80-documented.pdf
- **TZX Format:** https://worldofspectrum.net/TZXformat.html
