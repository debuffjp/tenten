// .aseprite in and out, written from the published file spec (aseprite.org/docs/aseprite-file-format). Reads RGBA,
// grayscale and indexed files with raw, compressed or linked cels at any offset; writes indexed files with
// transparent index 0, a palette, layers, tags and slices that Aseprite 1.3 opens.
import { deflateSync, inflateSync } from "node:zlib";
import type { Cel, Doc, Layer, Rgba } from "./doc.ts";
import { TentenError } from "./doc.ts";
import { rgbaToHex } from "./palette.ts";

const MAGIC = 0xa5e0, FRAME_MAGIC = 0xf1fa;
const CHUNK = { oldPalette: 0x0004, oldPalette2: 0x0011, layer: 0x2004, cel: 0x2005, colorProfile: 0x2007, tags: 0x2018, palette: 0x2019, userData: 0x2020, slice: 0x2022, tileset: 0x2023 } as const;
const DIRECTIONS = ["forward", "reverse", "pingpong", "pingpong"] as const;

class Reader {
  off = 0;
  view: DataView;
  buf: Uint8Array;
  constructor(buf: Uint8Array) { this.buf = buf; this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8() { return this.buf[this.off++]; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16() { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  i32() { const v = this.view.getInt32(this.off, true); this.off += 4; return v; }
  bytes(n: number) { const v = this.buf.subarray(this.off, this.off + n); this.off += n; return v; }
  skip(n: number) { this.off += n; }
  str() { const n = this.u16(); return new TextDecoder().decode(this.bytes(n)); }
}

class Writer {
  parts: Uint8Array[] = [];
  size = 0;
  private push(b: Uint8Array) { this.parts.push(b); this.size += b.length; }
  u8(v: number) { this.push(new Uint8Array([v & 255])); }
  u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
  i16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v, true); this.push(b); }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.push(b); }
  i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.push(b); }
  bytes(b: Uint8Array) { this.push(b); }
  zeros(n: number) { this.push(new Uint8Array(n)); }
  str(s: string) { const b = new TextEncoder().encode(s); this.u16(b.length); this.push(b); }
  done() { const out = new Uint8Array(this.size); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

interface RawLayer { name: string; visible: boolean; opacity: number; type: number; level: number }

// Decode to a document. RGBA and grayscale pixels are mapped to palette indices by exact colour; more than 255 distinct
// opaque colours is an error, since the document is indexed.
export function decodeAseprite(buf: Uint8Array): Doc {
  const r = new Reader(buf);
  r.u32();
  if (r.u16() !== MAGIC) throw new TentenError("BAD_ASE", "not an .aseprite file (bad magic)");
  const frameCount = r.u16(), width = r.u16(), height = r.u16(), depth = r.u16();
  r.u32(); r.u16(); r.u32(); r.u32();
  const transparentIndex = r.u8(); r.skip(3);
  let colourCount = r.u16(); if (colourCount === 0) colourCount = 256;
  r.skip(2 + 2 + 2 + 2 + 2 + 84);
  if (depth !== 32 && depth !== 16 && depth !== 8) throw new TentenError("BAD_ASE", `unsupported colour depth ${depth}`);
  const bpp = depth / 8;

  let filePalette: Rgba[] = [];
  const rawLayers: RawLayer[] = [];
  const frames: { durationMs: number; cels: { layer: number; x: number; y: number; w: number; h: number; pixels: Uint8Array; link?: number }[] }[] = [];
  const tags: Doc["tags"] = [];
  const slices: Doc["slices"] = [];

  for (let fi = 0; fi < frameCount; fi++) {
    const start = r.off;
    const frameBytes = r.u32();
    if (r.u16() !== FRAME_MAGIC) throw new TentenError("BAD_ASE", `bad frame magic at frame ${fi}`);
    const oldChunks = r.u16(), durationMs = r.u16(); r.skip(2);
    const newChunks = r.u32();
    const chunks = newChunks || oldChunks;
    const frame: (typeof frames)[number] = { durationMs, cels: [] };
    for (let ci = 0; ci < chunks; ci++) {
      const cstart = r.off, size = r.u32(), type = r.u16();
      const end = cstart + size;
      switch (type) {
        case CHUNK.layer: {
          const flags = r.u16(), ltype = r.u16(), level = r.u16(); r.u16(); r.u16(); r.u16();
          const opacity = r.u8(); r.skip(3);
          const name = r.str();
          rawLayers.push({ name, visible: !!(flags & 1), opacity, type: ltype, level });
          break;
        }
        case CHUNK.cel: {
          const layer = r.u16(), x = r.i16(), y = r.i16(); r.u8();
          const ctype = r.u16(); r.i16(); r.skip(5);
          if (ctype === 0) { const w = r.u16(), h = r.u16(); frame.cels.push({ layer, x, y, w, h, pixels: r.bytes(w * h * bpp) }); }
          else if (ctype === 1) { frame.cels.push({ layer, x, y, w: 0, h: 0, pixels: new Uint8Array(0), link: r.u16() }); }
          else if (ctype === 2) { const w = r.u16(), h = r.u16(); frame.cels.push({ layer, x, y, w, h, pixels: new Uint8Array(inflateSync(r.bytes(end - r.off))) }); }
          else throw new TentenError("BAD_ASE", `tilemap cels are not supported (layer ${rawLayers[layer]?.name ?? layer})`, "flatten tilemap layers in Aseprite first");
          break;
        }
        case CHUNK.palette: {
          const n = r.u32(), first = r.u32(), last = r.u32(); r.skip(8);
          if (filePalette.length < n) filePalette = [...filePalette, ...Array.from({ length: n - filePalette.length }, () => [0, 0, 0, 0] as Rgba)];
          for (let i = first; i <= last; i++) { const flags = r.u16(); filePalette[i] = [r.u8(), r.u8(), r.u8(), r.u8()]; if (flags & 1) r.str(); }
          break;
        }
        case CHUNK.oldPalette: case CHUNK.oldPalette2: {
          if (filePalette.length) break;
          const packets = r.u16(); let idx = 0; const pal: Rgba[] = [];
          for (let p = 0; p < packets; p++) { idx += r.u8(); let count = r.u8(); if (count === 0) count = 256; for (let i = 0; i < count; i++) { const scale = type === CHUNK.oldPalette2 ? 4 : 1; pal[idx + i] = [r.u8() * scale, r.u8() * scale, r.u8() * scale, 255]; } }
          filePalette = pal;
          break;
        }
        case CHUNK.tags: {
          const n = r.u16(); r.skip(8);
          for (let i = 0; i < n; i++) { const from = r.u16(), to = r.u16(), dir = r.u8(); r.u16(); r.skip(6); r.skip(3); r.u8(); tags.push({ name: r.str(), from, to, direction: DIRECTIONS[dir] ?? "forward" }); }
          break;
        }
        case CHUNK.slice: {
          const keys = r.u32(), flags = r.u32(); r.u32();
          const name = r.str();
          for (let k = 0; k < keys; k++) {
            r.u32(); const x = r.i32(), y = r.i32(), w = r.u32(), h = r.u32();
            if (flags & 1) { r.i32(); r.i32(); r.u32(); r.u32(); }
            const pivot = flags & 2 ? ([r.i32(), r.i32()] as [number, number]) : undefined;
            if (k === 0) slices.push({ name, x, y, w, h, pivot, kind: "slice" });
          }
          break;
        }
        default: break;
      }
      r.off = end;
    }
    frames.push(frame);
    r.off = start + frameBytes;
  }

  // Palette: indexed files keep theirs; RGBA and grayscale files get one built from the colours used.
  let palette: Rgba[];
  const toIndex = new Map<string, number>();
  const key = (c: Rgba) => `${c[0]},${c[1]},${c[2]},${c[3]}`;
  if (depth === 8) {
    palette = filePalette.map((c, i) => (i === transparentIndex ? [0, 0, 0, 0] : c));
    if (transparentIndex !== 0) {
      // Move the transparent entry to 0 so the document invariant holds; remap below.
      const moved = [palette[transparentIndex], ...palette.filter((_, i) => i !== transparentIndex)];
      palette = moved;
    }
  } else {
    palette = [[0, 0, 0, 0]];
  }
  const indexOf = (c: Rgba) => {
    if (c[3] === 0) return 0;
    const k = key(c);
    let i = toIndex.get(k);
    if (i === undefined) {
      i = palette.length;
      if (i > 255) throw new TentenError("TOO_MANY_COLOURS", "more than 255 distinct colours; tenten documents are indexed", "reduce colours in Aseprite (Sprite > Color Mode > Indexed) and re-import");
      palette.push(c); toIndex.set(k, i);
    }
    return i;
  };
  const remapIndexed = (v: number) => (transparentIndex === 0 ? v : v === transparentIndex ? 0 : v < transparentIndex ? v + 1 : v);

  let nextId = 1;
  const layers: Layer[] = [];
  const layerIdByRaw = new Map<number, number>();
  rawLayers.forEach((l, i) => { if (l.type === 0) { const id = nextId++; layers.push({ id, name: l.name, visible: l.visible, opacity: l.opacity }); layerIdByRaw.set(i, id); } });
  if (!layers.length) throw new TentenError("BAD_ASE", "no image layers in file");
  const docFrames = frames.map((f) => ({ id: nextId++, durationMs: f.durationMs }));
  const cels: Cel[] = [];
  const celByFrameLayer = new Map<string, Cel>();
  frames.forEach((f, fi) => {
    for (const c of f.cels) {
      const layerId = layerIdByRaw.get(c.layer);
      if (layerId === undefined) continue;
      let pixels: Uint8Array;
      if (c.link !== undefined) {
        const src = celByFrameLayer.get(`${c.link}/${layerId}`);
        pixels = src ? new Uint8Array(src.pixels) : new Uint8Array(width * height);
      } else {
        pixels = new Uint8Array(width * height);
        for (let yy = 0; yy < c.h; yy++) for (let xx = 0; xx < c.w; xx++) {
          const dx = c.x + xx, dy = c.y + yy;
          if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
          const s = (yy * c.w + xx) * bpp;
          let idx: number;
          if (depth === 32) idx = indexOf([c.pixels[s], c.pixels[s + 1], c.pixels[s + 2], c.pixels[s + 3]]);
          else if (depth === 16) idx = indexOf([c.pixels[s], c.pixels[s], c.pixels[s], c.pixels[s + 1]]);
          else idx = remapIndexed(c.pixels[s]);
          pixels[dy * width + dx] = idx;
        }
      }
      const cel = { layer: layerId, frame: docFrames[fi].id, pixels };
      cels.push(cel); celByFrameLayer.set(`${fi}/${layerId}`, cel);
    }
  });
  return { name: "sprite", width, height, palette, layers, frames: docFrames, cels, tags, slices, nextId };
}

export function encodeAseprite(d: Doc): Uint8Array {
  if (d.palette.length > 256) throw new TentenError("TOO_MANY_COLOURS", "palette has more than 256 entries");
  const chunk = (type: number, body: Uint8Array) => { const w = new Writer(); w.u32(body.length + 6); w.u16(type); w.bytes(body); return w.done(); };
  const frames: Uint8Array[] = [];
  d.frames.forEach((f, fi) => {
    const chunks: Uint8Array[] = [];
    if (fi === 0) {
      const cp = new Writer(); cp.u16(1); cp.u16(0); cp.u32(0); cp.zeros(8); chunks.push(chunk(CHUNK.colorProfile, cp.done()));
      const pal = new Writer(); pal.u32(d.palette.length); pal.u32(0); pal.u32(d.palette.length - 1); pal.zeros(8);
      for (const c of d.palette) { pal.u16(0); pal.u8(c[0]); pal.u8(c[1]); pal.u8(c[2]); pal.u8(c[3]); }
      chunks.push(chunk(CHUNK.palette, pal.done()));
      const old = new Writer(); old.u16(1); old.u8(0); old.u8(d.palette.length & 255); for (const c of d.palette) { old.u8(c[0]); old.u8(c[1]); old.u8(c[2]); }
      chunks.push(chunk(CHUNK.oldPalette, old.done()));
      for (const l of d.layers) { const w = new Writer(); w.u16((l.visible ? 1 : 0) | 2); w.u16(0); w.u16(0); w.u16(0); w.u16(0); w.u16(0); w.u8(l.opacity); w.zeros(3); w.str(l.name); chunks.push(chunk(CHUNK.layer, w.done())); }
      if (d.tags.length) {
        const w = new Writer(); w.u16(d.tags.length); w.zeros(8);
        for (const t of d.tags) { w.u16(t.from); w.u16(t.to); w.u8(DIRECTIONS.indexOf(t.direction)); w.u16(0); w.zeros(6); w.u8(0); w.u8(0); w.u8(0); w.u8(0); w.str(t.name); }
        chunks.push(chunk(CHUNK.tags, w.done()));
      }
      for (const s of d.slices) {
        const w = new Writer(); w.u32(1); w.u32(s.pivot ? 2 : 0); w.u32(0); w.str(s.name);
        w.u32(0); w.i32(s.x); w.i32(s.y); w.u32(s.w); w.u32(s.h); if (s.pivot) { w.i32(s.pivot[0]); w.i32(s.pivot[1]); }
        chunks.push(chunk(CHUNK.slice, w.done()));
      }
    }
    d.layers.forEach((l, li) => {
      const cel = d.cels.find((c) => c.layer === l.id && c.frame === f.id);
      if (!cel || !cel.pixels.some((p) => p)) return;
      const w = new Writer(); w.u16(li); w.i16(0); w.i16(0); w.u8(255); w.u16(2); w.i16(0); w.zeros(5); w.u16(d.width); w.u16(d.height);
      w.bytes(new Uint8Array(deflateSync(cel.pixels)));
      chunks.push(chunk(CHUNK.cel, w.done()));
    });
    const body = chunks.reduce((n, c) => n + c.length, 0);
    const fw = new Writer(); fw.u32(16 + body); fw.u16(FRAME_MAGIC); fw.u16(Math.min(chunks.length, 0xffff)); fw.u16(f.durationMs); fw.zeros(2); fw.u32(chunks.length);
    for (const c of chunks) fw.bytes(c);
    frames.push(fw.done());
  });
  const total = 128 + frames.reduce((n, f) => n + f.length, 0);
  const h = new Writer();
  h.u32(total); h.u16(MAGIC); h.u16(d.frames.length); h.u16(d.width); h.u16(d.height); h.u16(8); h.u32(1); h.u16(d.frames[0].durationMs); h.u32(0); h.u32(0);
  h.u8(0); h.zeros(3); h.u16(d.palette.length); h.u8(1); h.u8(1); h.i16(0); h.i16(0); h.u16(16); h.u16(16); h.zeros(84);
  for (const f of frames) h.bytes(f);
  return h.done();
}

export const paletteHex = (d: Doc) => d.palette.map(rgbaToHex);
