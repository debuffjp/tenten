// Text grids: the way an agent reads and writes pixels. One character per pixel, "." for transparent,
// then 0-9, a-z, A-Z for palette indices 1..61. Larger palettes use the index itself in a hex grid.
import type { Doc, Frame } from "./doc.ts";
import { TentenError, flatten } from "./doc.ts";

const ALPHABET = ".0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function indexToChar(i: number) {
  if (i < ALPHABET.length) return ALPHABET[i];
  throw new TentenError("GRID_RANGE", `palette index ${i} has no grid character`, "grids cover indices 0..61; use draw ops for larger palettes");
}

export function charToIndex(ch: string) {
  const i = ALPHABET.indexOf(ch);
  if (i < 0) throw new TentenError("GRID_CHAR", `unknown grid character "${ch}"`, `use . for transparent and ${ALPHABET.slice(1, 12)}… for palette indices`);
  return i;
}

export function toGrid(pixels: Uint8Array, width: number, height: number): string {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) row += indexToChar(pixels[y * width + x]);
    rows.push(row);
  }
  return rows.join("\n");
}

export function frameGrid(d: Doc, frame: Frame) { return toGrid(flatten(d, frame), d.width, d.height); }

// Parse rows of text into pixels. Rows may be shorter than the width (padded transparent) and fewer than the height.
// A space is treated as transparent too, so grids can be written with spaces for readability.
export function fromGrid(text: string | string[], width: number, height: number): Uint8Array {
  const rows = Array.isArray(text) ? text : text.split(/\r?\n/);
  const out = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    if (y >= height) throw new TentenError("GRID_SIZE", `grid has more than ${height} rows`, "the grid must fit the sprite");
    for (let x = 0; x < row.length; x++) {
      if (x >= width) throw new TentenError("GRID_SIZE", `row ${y} is wider than ${width}`, "the grid must fit the sprite");
      const ch = row[x];
      out[y * width + x] = ch === " " ? 0 : charToIndex(ch);
    }
  });
  return out;
}

export interface GridDiff { changed: number; cells: { x: number; y: number; from: number; to: number }[]; grid: string }

// Compare two flat index buffers of the same size. The grid shows the new index where a pixel changed and "-" elsewhere.
export function diffPixels(a: Uint8Array, b: Uint8Array, width: number, height: number, maxCells = 64): GridDiff {
  const cells: GridDiff["cells"] = [];
  let changed = 0;
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (a[i] === b[i]) { row += "-"; continue; }
      changed++;
      if (cells.length < maxCells) cells.push({ x, y, from: a[i], to: b[i] });
      row += indexToChar(b[i]);
    }
    rows.push(row);
  }
  return { changed, cells, grid: rows.join("\n") };
}
