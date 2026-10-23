// Rasterise frames to RGBA and PNG, build sheets, and write the Aseprite-style JSON that Phaser and Pixi loaders read.
import { encode } from "fast-png";
import type { Doc, Frame } from "./doc.ts";
import { TentenError, flatten } from "./doc.ts";

export function frameRgba(d: Doc, frame: Frame, scale = 1): { width: number; height: number; data: Uint8Array } {
  const idx = flatten(d, frame);
  const w = d.width * scale, h = d.height * scale;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = d.palette[idx[Math.floor(y / scale) * d.width + Math.floor(x / scale)]] ?? [0, 0, 0, 0];
    data.set(c, (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}

export function framePng(d: Doc, frame: Frame, scale = 1): Uint8Array {
  const img = frameRgba(d, frame, scale);
  return encode({ ...img, channels: 4, depth: 8 });
}

export type SheetLayout = "horizontal" | "vertical" | "grid";

export interface Sheet {
  png: Uint8Array;
  width: number;
  height: number;
  frames: { index: number; x: number; y: number; durationMs: number }[];
  columns: number;
}

// Pack frames at their full size, no trimming, so frame i is at a predictable cell. Grid picks the squarest column count.
export function sheet(d: Doc, layout: SheetLayout = "horizontal", scale = 1, padding = 0): Sheet {
  const { data, ...r } = sheetRgba(d, layout, scale, padding);
  return { ...r, png: encode({ width: r.width, height: r.height, data, channels: 4, depth: 8 }) };
}

function sheetRgba(d: Doc, layout: SheetLayout, scale: number, padding: number): Omit<Sheet, "png"> & { data: Uint8Array } {
  const n = d.frames.length;
  const cols = layout === "horizontal" ? n : layout === "vertical" ? 1 : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const fw = d.width * scale, fh = d.height * scale;
  const width = cols * fw + (cols - 1) * padding, height = rows * fh + (rows - 1) * padding;
  const data = new Uint8Array(width * height * 4);
  const frames: Sheet["frames"] = [];
  d.frames.forEach((f, i) => {
    const cx = (i % cols) * (fw + padding), cy = Math.floor(i / cols) * (fh + padding);
    const img = frameRgba(d, f, scale);
    for (let y = 0; y < fh; y++) data.set(img.data.subarray(y * fw * 4, (y + 1) * fw * 4), ((cy + y) * width + cx) * 4);
    frames.push({ index: i, x: cx, y: cy, durationMs: f.durationMs });
  });
  return { data, width, height, frames, columns: cols };
}

// Aseprite's JSON "hash" export, the shape `this.load.aseprite` in Phaser and Pixi's spritesheet parser accept.
export function asepriteJson(d: Doc, s: Sheet, imageName: string, scale = 1) {
  const fw = d.width * scale, fh = d.height * scale;
  const frames: Record<string, unknown> = {};
  for (const f of s.frames) frames[`${d.name} ${f.index}.ase`] = { frame: { x: f.x, y: f.y, w: fw, h: fh }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: fw, h: fh }, sourceSize: { w: fw, h: fh }, duration: f.durationMs };
  return {
    frames,
    meta: {
      app: "tenten", version: "0.0.1", image: imageName, format: "RGBA8888", size: { w: s.width, h: s.height }, scale: String(scale),
      frameTags: d.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction })),
      layers: d.layers.map((l) => ({ name: l.name, opacity: l.opacity, blendMode: "normal" })),
      slices: d.slices.map((sl) => ({ name: sl.name, color: sl.kind === "hitbox" ? "#ff0000ff" : "#0000ffff", keys: [{ frame: 0, bounds: { x: sl.x * scale, y: sl.y * scale, w: sl.w * scale, h: sl.h * scale }, ...(sl.pivot ? { pivot: { x: sl.pivot[0] * scale, y: sl.pivot[1] * scale } } : {}) }] })),
    },
  };
}

// A zoomed preview of every frame in a row with its index under it, for a human or a model to look at.
const DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];

export function previewPng(d: Doc, scale = 8): Uint8Array {
  if (scale < 1) throw new TentenError("BAD_SCALE", "scale must be at least 1");
  const s = sheetRgba(d, "horizontal", scale, scale);
  const z = Math.max(1, Math.floor(scale / 4));
  const width = s.width, height = s.height + 7 * z;
  const data = new Uint8Array(width * height * 4);
  data.set(s.data);
  const put = (x: number, y: number) => { if (x < width) data.set([128, 128, 128, 255], ((s.height + z + y) * width + x) * 4); };
  for (const f of s.frames) {
    const text = String(f.index);
    for (let i = 0; i < text.length; i++) {
      const glyph = DIGITS[Number(text[i])];
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) if (glyph[gy * 3 + gx] === "1") {
        for (let dy = 0; dy < z; dy++) for (let dx = 0; dx < z; dx++) put(f.x + (i * 4 + gx) * z + dx, gy * z + dy);
      }
    }
  }
  return encode({ width, height, data, channels: 4, depth: 8 });
}
