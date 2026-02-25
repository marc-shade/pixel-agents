/**
 * Generate cyberpunk-themed pixel art furniture sprites as PNG files.
 * Uses ONLY Node.js built-in modules (fs, path, zlib).
 *
 * Each sprite is a minimal valid PNG with RGBA pixels.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_DIR = join(__dirname, '..', 'webview-ui', 'public', 'assets', 'furniture');

// ── Cyberpunk color palette ────────────────────────────────────
const C = {
  TRANSPARENT: [0, 0, 0, 0],
  DARK_PURPLE:  [0x2D, 0x1B, 0x4E, 255],
  MAGENTA:      [0xFF, 0x00, 0xFF, 255],
  CYAN:         [0x00, 0xFF, 0xFF, 255],
  GREEN:        [0x00, 0xFF, 0x88, 255],
  METAL_DARK:   [0x4A, 0x4A, 0x6A, 255],
  METAL_LIGHT:  [0x6A, 0x6A, 0x8A, 255],
  WOOD_DARK:    [0x3D, 0x2B, 0x1F, 255],
  ORANGE:       [0xFF, 0xAA, 0x00, 255],
  BLACK:        [0x10, 0x10, 0x18, 255],
  SCREEN_BG:    [0x0A, 0x0A, 0x1A, 255],
  SCREEN_GREEN: [0x00, 0xCC, 0x66, 255],
  WHITE:        [0xDD, 0xDD, 0xEE, 255],
  BROWN:        [0x55, 0x33, 0x22, 255],
  RED:          [0xFF, 0x33, 0x33, 255],
  PURPLE_MID:   [0x55, 0x33, 0x77, 255],
  BLUE:         [0x33, 0x66, 0xFF, 255],
};

const _ = C.TRANSPARENT;
const DP = C.DARK_PURPLE;
const MG = C.MAGENTA;
const CY = C.CYAN;
const GN = C.GREEN;
const MD = C.METAL_DARK;
const ML = C.METAL_LIGHT;
const WD = C.WOOD_DARK;
const OR = C.ORANGE;
const BK = C.BLACK;
const SB = C.SCREEN_BG;
const SG = C.SCREEN_GREEN;
const WH = C.WHITE;
const BR = C.BROWN;
const RD = C.RED;
const PM = C.PURPLE_MID;
const BL = C.BLUE;

// ── CRC32 ──────────────────────────────────────────────────────
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG writer ─────────────────────────────────────────────────
function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function writePNG(filePath, width, height, pixels) {
  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT — raw pixel data with filter byte 0 per row
  const rowSize = 1 + width * 4; // filter byte + RGBA per pixel
  const rawData = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const pixel = pixels[y][x];
      const pixelOffset = rowOffset + 1 + x * 4;
      rawData[pixelOffset]     = pixel[0]; // R
      rawData[pixelOffset + 1] = pixel[1]; // G
      rawData[pixelOffset + 2] = pixel[2]; // B
      rawData[pixelOffset + 3] = pixel[3]; // A
    }
  }
  const compressed = deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  const png = Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
  writeFileSync(filePath, png);
}

// Helper: create empty pixel grid
function createGrid(w, h, fill = _) {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => [...fill]));
}

// Helper: draw a filled rectangle
function fillRect(grid, x, y, w, h, color) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (y + dy < grid.length && x + dx < grid[0].length) {
        grid[y + dy][x + dx] = [...color];
      }
    }
  }
}

// Helper: draw a single pixel
function setPixel(grid, x, y, color) {
  if (y >= 0 && y < grid.length && x >= 0 && x < grid[0].length) {
    grid[y][x] = [...color];
  }
}

// Helper: draw horizontal line
function hLine(grid, x, y, len, color) {
  for (let i = 0; i < len; i++) setPixel(grid, x + i, y, color);
}

// Helper: draw vertical line
function vLine(grid, x, y, len, color) {
  for (let i = 0; i < len; i++) setPixel(grid, x, y + i, color);
}

// Helper: draw rectangle outline
function drawRect(grid, x, y, w, h, color) {
  hLine(grid, x, y, w, color);
  hLine(grid, x, y + h - 1, w, color);
  vLine(grid, x, y, h, color);
  vLine(grid, x + w - 1, y, h, color);
}

// ── Sprite designs ─────────────────────────────────────────────

function drawDeskCyber() {
  // 32x32 cyberpunk desk with glowing trim
  const g = createGrid(32, 32);

  // Desk surface (top-down isometric feel)
  fillRect(g, 1, 10, 30, 3, ML);          // desk top surface
  fillRect(g, 2, 11, 28, 1, MD);          // surface shadow
  hLine(g, 1, 10, 30, CY);                // cyan glow top edge
  hLine(g, 1, 12, 30, MG);                // magenta glow bottom edge

  // Front panel
  fillRect(g, 2, 13, 28, 10, MD);         // front panel
  fillRect(g, 3, 14, 26, 8, DP);          // inner panel

  // Neon trim lines on front
  hLine(g, 4, 16, 24, CY);
  hLine(g, 4, 19, 24, MG);

  // Legs
  fillRect(g, 3, 23, 2, 8, ML);           // left leg
  fillRect(g, 27, 23, 2, 8, ML);          // right leg
  setPixel(g, 3, 30, CY);                 // left foot glow
  setPixel(g, 4, 30, CY);
  setPixel(g, 27, 30, MG);                // right foot glow
  setPixel(g, 28, 30, MG);

  // Items on desk: small monitor
  fillRect(g, 12, 4, 8, 6, BK);           // monitor body
  fillRect(g, 13, 5, 6, 4, SB);           // screen
  hLine(g, 13, 5, 6, SG);                 // screen text line 1
  hLine(g, 14, 7, 4, SG);                 // screen text line 2
  fillRect(g, 15, 10, 2, 1, ML);          // monitor stand

  // Keyboard on desk
  fillRect(g, 6, 8, 6, 2, MD);
  hLine(g, 7, 8, 4, GN);                  // key glow

  return g;
}

function drawChairCyber() {
  // 16x16 holographic chair
  const g = createGrid(16, 16);

  // Seat
  fillRect(g, 3, 7, 10, 3, MD);           // seat base
  fillRect(g, 4, 8, 8, 1, ML);            // seat highlight
  hLine(g, 3, 7, 10, CY);                 // glow top
  hLine(g, 3, 9, 10, MG);                 // glow bottom

  // Backrest
  fillRect(g, 5, 2, 6, 5, MD);
  fillRect(g, 6, 3, 4, 3, DP);
  hLine(g, 6, 4, 4, CY);                  // backrest glow stripe

  // Legs / base
  vLine(g, 5, 10, 4, ML);
  vLine(g, 10, 10, 4, ML);
  hLine(g, 4, 14, 8, MD);                 // wheel base
  setPixel(g, 4, 15, CY);                 // wheel glow
  setPixel(g, 11, 15, CY);

  return g;
}

function drawServerRack() {
  // 16x32 server rack with blinking lights
  const g = createGrid(16, 32);

  // Outer frame
  drawRect(g, 1, 0, 14, 31, ML);
  fillRect(g, 2, 1, 12, 29, DP);

  // Server units (4 units stacked)
  for (let i = 0; i < 4; i++) {
    const yOff = 2 + i * 7;
    fillRect(g, 3, yOff, 10, 5, MD);      // unit body
    fillRect(g, 4, yOff + 1, 8, 3, BK);   // unit face
    // Status LEDs
    setPixel(g, 5, yOff + 2, GN);
    setPixel(g, 7, yOff + 2, CY);
    setPixel(g, 9, yOff + 2, i % 2 === 0 ? GN : OR);
    // Vent lines
    hLine(g, 5, yOff + 3, 5, MD);
  }

  // Bottom vent
  fillRect(g, 3, 30, 10, 1, MD);

  // Cable on side
  vLine(g, 14, 3, 25, MG);

  return g;
}

function drawMonitorWall() {
  // 32x16 wall-mounted monitor / display panel
  const g = createGrid(32, 16);

  // Outer bezel
  fillRect(g, 1, 1, 30, 14, MD);
  drawRect(g, 0, 0, 32, 16, ML);

  // Screen area
  fillRect(g, 3, 3, 26, 10, SB);

  // Screen content — cyberpunk dashboard
  // Top bar
  hLine(g, 4, 4, 24, CY);
  // Data lines
  hLine(g, 4, 6, 10, GN);
  hLine(g, 4, 7, 14, SG);
  hLine(g, 4, 8, 8, GN);
  // Chart bars
  for (let i = 0; i < 6; i++) {
    const h = 2 + (i * 3 % 5);
    vLine(g, 20 + i * 2, 11 - h, h, MG);
  }

  // Glow edges
  hLine(g, 0, 0, 32, CY);
  hLine(g, 0, 15, 32, CY);

  // Mount bracket (center)
  fillRect(g, 14, 1, 4, 2, ML);

  return g;
}

function drawPlantNeon() {
  // 16x16 neon-glowing plant in pot
  const g = createGrid(16, 16);

  // Pot
  fillRect(g, 4, 10, 8, 5, DP);
  fillRect(g, 5, 10, 6, 1, PM);           // pot rim
  hLine(g, 4, 14, 8, MG);                 // pot glow base
  fillRect(g, 5, 15, 6, 1, DP);           // pot base

  // Stem
  vLine(g, 7, 5, 5, GN);
  vLine(g, 8, 4, 6, GN);

  // Leaves — neon green glow
  setPixel(g, 5, 4, GN);
  setPixel(g, 4, 3, GN);
  setPixel(g, 6, 3, GN);
  setPixel(g, 10, 4, GN);
  setPixel(g, 11, 3, GN);
  setPixel(g, 9, 3, GN);
  setPixel(g, 7, 2, CY);                  // top leaf
  setPixel(g, 8, 1, CY);
  setPixel(g, 6, 5, GN);
  setPixel(g, 9, 5, GN);
  setPixel(g, 3, 4, CY);                  // leaf tips glow
  setPixel(g, 12, 4, CY);

  // Small glow dots (bioluminescent spores)
  setPixel(g, 5, 2, MG);
  setPixel(g, 10, 2, MG);

  return g;
}

function drawCoffeeMachine() {
  // 16x16 cyberpunk coffee bot
  const g = createGrid(16, 16);

  // Base
  fillRect(g, 3, 12, 10, 3, MD);
  hLine(g, 3, 14, 10, ML);
  hLine(g, 3, 12, 10, CY);                // glow line

  // Body
  fillRect(g, 4, 4, 8, 8, ML);
  fillRect(g, 5, 5, 6, 6, MD);

  // Top
  fillRect(g, 5, 2, 6, 2, ML);
  hLine(g, 5, 2, 6, OR);                  // warm glow top

  // Display screen
  fillRect(g, 6, 5, 4, 2, SB);
  hLine(g, 6, 5, 4, GN);                  // status text

  // Drip area
  fillRect(g, 6, 8, 4, 2, BK);
  setPixel(g, 7, 9, CY);                  // drip
  setPixel(g, 8, 10, CY);

  // Cup
  fillRect(g, 6, 10, 4, 2, WH);
  setPixel(g, 7, 10, BR);                 // coffee inside
  setPixel(g, 8, 10, BR);

  // Steam
  setPixel(g, 7, 3, WH);
  setPixel(g, 9, 2, WH);

  // Status LED
  setPixel(g, 11, 6, GN);

  // Neon accent
  vLine(g, 3, 5, 7, MG);

  return g;
}

function drawCouchCyber() {
  // 32x16 cyberpunk couch/sofa
  const g = createGrid(32, 16);

  // Seat base
  fillRect(g, 2, 8, 28, 4, MD);
  fillRect(g, 3, 9, 26, 2, ML);           // seat cushion highlight

  // Backrest
  fillRect(g, 2, 3, 28, 5, MD);
  fillRect(g, 3, 4, 26, 3, DP);

  // Neon trim along backrest
  hLine(g, 2, 3, 28, CY);
  hLine(g, 2, 7, 28, MG);

  // Armrests
  fillRect(g, 0, 5, 3, 7, ML);            // left armrest
  fillRect(g, 29, 5, 3, 7, ML);           // right armrest
  vLine(g, 0, 5, 7, CY);                  // left glow
  vLine(g, 31, 5, 7, CY);                 // right glow

  // Cushion lines (dividers)
  vLine(g, 10, 4, 3, MG);
  vLine(g, 21, 4, 3, MG);

  // Legs
  fillRect(g, 3, 12, 2, 3, ML);
  fillRect(g, 27, 12, 2, 3, ML);
  setPixel(g, 3, 14, MG);                 // foot glow
  setPixel(g, 4, 14, MG);
  setPixel(g, 27, 14, MG);
  setPixel(g, 28, 14, MG);

  // Accent lighting under seat
  hLine(g, 5, 12, 22, OR);

  return g;
}

function drawBookshelf() {
  // 16x32 data shelf / bookshelf
  const g = createGrid(16, 32);

  // Outer frame
  drawRect(g, 0, 0, 16, 31, ML);
  fillRect(g, 1, 1, 14, 29, DP);

  // Shelves (5 shelf levels)
  for (let i = 0; i < 5; i++) {
    const yOff = 1 + i * 6;
    hLine(g, 1, yOff + 5, 14, ML);        // shelf surface

    if (i === 0) {
      // Data crystals
      fillRect(g, 3, yOff + 1, 2, 4, CY);
      fillRect(g, 6, yOff + 2, 2, 3, MG);
      fillRect(g, 9, yOff + 1, 2, 4, GN);
      fillRect(g, 12, yOff + 2, 2, 3, CY);
    } else if (i === 1) {
      // Books
      fillRect(g, 2, yOff + 1, 2, 4, MG);
      fillRect(g, 4, yOff + 0, 2, 5, BL);
      fillRect(g, 6, yOff + 1, 2, 4, OR);
      fillRect(g, 8, yOff + 0, 2, 5, GN);
      fillRect(g, 10, yOff + 1, 3, 4, RD);
    } else if (i === 2) {
      // Storage boxes
      fillRect(g, 2, yOff + 1, 5, 4, MD);
      drawRect(g, 2, yOff + 1, 5, 4, ML);
      fillRect(g, 9, yOff + 1, 5, 4, MD);
      drawRect(g, 9, yOff + 1, 5, 4, ML);
      setPixel(g, 4, yOff + 3, CY);       // box lock LED
      setPixel(g, 11, yOff + 3, GN);
    } else if (i === 3) {
      // Discs / media
      for (let d = 0; d < 4; d++) {
        setPixel(g, 3 + d * 3, yOff + 2, CY);
        setPixel(g, 3 + d * 3, yOff + 3, ML);
      }
    } else {
      // Bottom: misc electronics
      fillRect(g, 3, yOff + 1, 4, 3, BK);
      setPixel(g, 4, yOff + 2, GN);       // LED
      setPixel(g, 5, yOff + 2, OR);       // LED
      fillRect(g, 9, yOff + 1, 4, 3, MD);
      hLine(g, 9, yOff + 2, 4, MG);       // glow strip
    }
  }

  // Side accent glow
  vLine(g, 0, 0, 31, MG);
  vLine(g, 15, 0, 31, MG);

  return g;
}

// ── Main ───────────────────────────────────────────────────────

const sprites = [
  { name: 'desk-cyber.png',     w: 32, h: 32, draw: drawDeskCyber },
  { name: 'chair-cyber.png',    w: 16, h: 16, draw: drawChairCyber },
  { name: 'server-rack.png',    w: 16, h: 32, draw: drawServerRack },
  { name: 'monitor-wall.png',   w: 32, h: 16, draw: drawMonitorWall },
  { name: 'plant-neon.png',     w: 16, h: 16, draw: drawPlantNeon },
  { name: 'coffee-machine.png', w: 16, h: 16, draw: drawCoffeeMachine },
  { name: 'couch-cyber.png',    w: 32, h: 16, draw: drawCouchCyber },
  { name: 'bookshelf.png',      w: 16, h: 32, draw: drawBookshelf },
];

mkdirSync(OUTPUT_DIR, { recursive: true });

for (const sprite of sprites) {
  const pixels = sprite.draw();
  const filePath = join(OUTPUT_DIR, sprite.name);
  writePNG(filePath, sprite.w, sprite.h, pixels);
  console.log(`  OK  ${sprite.name} (${sprite.w}x${sprite.h})`);
}

console.log(`\nGenerated ${sprites.length} sprites in ${OUTPUT_DIR}`);
