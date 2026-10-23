// Every edit is an op in this union. `apply` mutates the document; the editor snapshots before a batch for undo.
import type { Doc, Rgba } from "./doc.ts";
import { TentenError, ensureCel, frameAt, getCel, inBounds, layerByName } from "./doc.ts";
import { fromGrid } from "./grid.ts";
import { hexToRgba } from "./palette.ts";

type Target = { layer?: string | number; frame?: number };
export type Op =
  | ({ op: "pixel"; x: number; y: number; c: number } & Target)
  | ({ op: "line"; x0: number; y0: number; x1: number; y1: number; c: number } & Target)
  | ({ op: "rect"; x: number; y: number; w: number; h: number; c: number; fill?: boolean } & Target)
  | ({ op: "ellipse"; x: number; y: number; w: number; h: number; c: number; fill?: boolean } & Target)
  | ({ op: "flood"; x: number; y: number; c: number } & Target)
  | ({ op: "grid"; rows: string | string[]; x?: number; y?: number } & Target)
  | ({ op: "clear" } & Target)
  | ({ op: "shift"; dx: number; dy: number; wrap?: boolean } & Target)
  | ({ op: "flip"; axis: "x" | "y" } & Target)
  | ({ op: "replace"; from: number; to: number } & Target)
  | ({ op: "outline"; c: number } & Target)
  | ({ op: "copy"; fromFrame: number; fromLayer?: string | number } & Target)
  | { op: "addLayer"; name: string }
  | { op: "removeLayer"; layer: string | number }
  | { op: "addFrame"; copy?: boolean; durationMs?: number; at?: number }
  | { op: "removeFrame"; frame: number }
  | { op: "duration"; frame?: number; ms: number }
  | { op: "tag"; name: string; from: number; to: number; direction?: "forward" | "reverse" | "pingpong" }
  | { op: "untag"; name: string }
  | { op: "slice"; name: string; x: number; y: number; w: number; h: number; pivot?: [number, number]; kind?: "hitbox" | "slice" }
  | { op: "unslice"; name: string }
  | { op: "colour"; index?: number; hex: string }
  | { op: "palette"; colours: string[] };

function target(d: Doc, t: Target) {
  const layer = layerByName(d, t.layer);
  const frame = frameAt(d, t.frame);
  return { layer, frame, cel: ensureCel(d, layer, frame) };
}

function checkIndex(d: Doc, c: number) {
  if (!Number.isInteger(c) || c < 0 || c >= d.palette.length) throw new TentenError("NO_COLOUR", `palette index ${c} does not exist`, `palette has indices 0..${d.palette.length - 1}; add colours with the colour op`);
}

function put(d: Doc, px: Uint8Array, x: number, y: number, c: number) { if (inBounds(d, x, y)) px[y * d.width + x] = c; }

function line(d: Doc, px: Uint8Array, x0: number, y0: number, x1: number, y1: number, c: number) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    put(d, px, x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function ellipse(d: Doc, px: Uint8Array, x: number, y: number, w: number, h: number, c: number, fill: boolean) {
  // Zingl's midpoint ellipse in a bounding box: the shapes pixel artists expect for both odd and even sizes.
  if (w <= 0 || h <= 0) return;
  let x0 = x, y0 = y, x1 = x + w - 1, y1 = y + h - 1;
  let a = x1 - x0, b = y1 - y0;
  const b1 = b & 1;
  let dx = 4 * (1 - a) * b * b, dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  y0 += (b + 1) >> 1; y1 = y0 - b1;
  a = 8 * a * a; const bb = 8 * b * b;
  const span = (xa: number, xb: number, yy: number) => { if (fill) for (let i = xa; i <= xb; i++) put(d, px, i, yy, c); else { put(d, px, xa, yy, c); put(d, px, xb, yy, c); } };
  do {
    span(x0, x1, y0); span(x0, x1, y1);
    const e2 = 2 * err;
    if (e2 <= dy) { y0++; y1--; dy += a; err += dy; }
    if (e2 >= dx || 2 * err > dy) { x0++; x1--; dx += bb; err += dx; }
  } while (x0 <= x1);
  while (y0 - y1 <= b) { span(x0 - 1, x1 + 1, y0++); span(x0 - 1, x1 + 1, y1--); }
}

function flood(d: Doc, px: Uint8Array, x: number, y: number, c: number) {
  if (!inBounds(d, x, y)) return;
  const from = px[y * d.width + x];
  if (from === c) return;
  const stack = [x + y * d.width];
  while (stack.length) {
    const i = stack.pop()!;
    if (px[i] !== from) continue;
    px[i] = c;
    const ix = i % d.width, iy = (i - ix) / d.width;
    if (ix > 0) stack.push(i - 1);
    if (ix < d.width - 1) stack.push(i + 1);
    if (iy > 0) stack.push(i - d.width);
    if (iy < d.height - 1) stack.push(i + d.width);
  }
}

export function apply(d: Doc, o: Op): void {
  switch (o.op) {
    case "pixel": { checkIndex(d, o.c); put(d, target(d, o).cel.pixels, o.x, o.y, o.c); return; }
    case "line": { checkIndex(d, o.c); line(d, target(d, o).cel.pixels, o.x0, o.y0, o.x1, o.y1, o.c); return; }
    case "rect": {
      checkIndex(d, o.c);
      const px = target(d, o).cel.pixels;
      for (let yy = o.y; yy < o.y + o.h; yy++) for (let xx = o.x; xx < o.x + o.w; xx++)
        if (o.fill || yy === o.y || yy === o.y + o.h - 1 || xx === o.x || xx === o.x + o.w - 1) put(d, px, xx, yy, o.c);
      return;
    }
    case "ellipse": { checkIndex(d, o.c); ellipse(d, target(d, o).cel.pixels, o.x, o.y, o.w, o.h, o.c, !!o.fill); return; }
    case "flood": { checkIndex(d, o.c); flood(d, target(d, o).cel.pixels, o.x, o.y, o.c); return; }
    case "grid": {
      const { cel } = target(d, o);
      const rows = Array.isArray(o.rows) ? o.rows : o.rows.split(/\r?\n/);
      const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
      const src = fromGrid(rows, w, h);
      const ox = o.x ?? 0, oy = o.y ?? 0;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const c = src[yy * w + xx];
        if (c) { checkIndex(d, c); put(d, cel.pixels, ox + xx, oy + yy, c); }
      }
      return;
    }
    case "clear": { target(d, o).cel.pixels.fill(0); return; }
    case "shift": {
      const { cel } = target(d, o);
      const out = new Uint8Array(cel.pixels.length);
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
        let nx = x + o.dx, ny = y + o.dy;
        if (o.wrap) { nx = ((nx % d.width) + d.width) % d.width; ny = ((ny % d.height) + d.height) % d.height; }
        if (inBounds(d, nx, ny)) out[ny * d.width + nx] = cel.pixels[y * d.width + x];
      }
      cel.pixels.set(out);
      return;
    }
    case "flip": {
      const { cel } = target(d, o);
      const out = new Uint8Array(cel.pixels.length);
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
        const sx = o.axis === "x" ? d.width - 1 - x : x, sy = o.axis === "y" ? d.height - 1 - y : y;
        out[y * d.width + x] = cel.pixels[sy * d.width + sx];
      }
      cel.pixels.set(out);
      return;
    }
    case "replace": {
      checkIndex(d, o.to);
      const { cel } = target(d, o);
      for (let i = 0; i < cel.pixels.length; i++) if (cel.pixels[i] === o.from) cel.pixels[i] = o.to;
      return;
    }
    case "outline": {
      // Paint c on every transparent pixel that touches a painted one (4-neighbourhood): the 1 px outline drawn last.
      checkIndex(d, o.c);
      const { cel } = target(d, o);
      const src = new Uint8Array(cel.pixels);
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
        if (src[y * d.width + x]) continue;
        const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inBounds(d, x + dx, y + dy) && src[(y + dy) * d.width + x + dx]);
        if (n) cel.pixels[y * d.width + x] = o.c;
      }
      return;
    }
    case "copy": {
      const dst = target(d, o);
      const srcLayer = layerByName(d, o.fromLayer ?? dst.layer.id);
      const src = getCel(d, srcLayer, frameAt(d, o.fromFrame));
      dst.cel.pixels.set(src ? src.pixels : new Uint8Array(dst.cel.pixels.length));
      return;
    }
    case "addLayer": {
      if (d.layers.some((l) => l.name === o.name)) throw new TentenError("DUP_LAYER", `layer "${o.name}" exists`);
      d.layers.push({ id: d.nextId++, name: o.name, visible: true, opacity: 255 });
      return;
    }
    case "removeLayer": {
      const l = layerByName(d, o.layer);
      if (d.layers.length === 1) throw new TentenError("LAST_LAYER", "cannot remove the only layer");
      d.layers = d.layers.filter((x) => x !== l);
      d.cels = d.cels.filter((c) => c.layer !== l.id);
      return;
    }
    case "addFrame": {
      const at = o.at ?? d.frames.length;
      const prev = d.frames[Math.min(at, d.frames.length) - 1];
      const f = { id: d.nextId++, durationMs: o.durationMs ?? prev?.durationMs ?? 100 };
      d.frames.splice(at, 0, f);
      if (o.copy !== false && prev) for (const c of d.cels.filter((c) => c.frame === prev.id)) d.cels.push({ layer: c.layer, frame: f.id, pixels: new Uint8Array(c.pixels) });
      return;
    }
    case "removeFrame": {
      const f = frameAt(d, o.frame);
      if (d.frames.length === 1) throw new TentenError("LAST_FRAME", "cannot remove the only frame");
      d.frames = d.frames.filter((x) => x !== f);
      d.cels = d.cels.filter((c) => c.frame !== f.id);
      d.tags = d.tags.map((t) => ({ ...t, from: Math.min(t.from, d.frames.length - 1), to: Math.min(t.to, d.frames.length - 1) }));
      return;
    }
    case "duration": {
      if (o.frame === undefined) for (const f of d.frames) f.durationMs = o.ms; else frameAt(d, o.frame).durationMs = o.ms;
      return;
    }
    case "tag": {
      frameAt(d, o.from); frameAt(d, o.to);
      d.tags = d.tags.filter((t) => t.name !== o.name);
      d.tags.push({ name: o.name, from: o.from, to: o.to, direction: o.direction ?? "forward" });
      return;
    }
    case "untag": { d.tags = d.tags.filter((t) => t.name !== o.name); return; }
    case "slice": {
      d.slices = d.slices.filter((s) => s.name !== o.name);
      d.slices.push({ name: o.name, x: o.x, y: o.y, w: o.w, h: o.h, pivot: o.pivot, kind: o.kind ?? "slice" });
      return;
    }
    case "unslice": { d.slices = d.slices.filter((s) => s.name !== o.name); return; }
    case "colour": {
      const c: Rgba = hexToRgba(o.hex);
      if (o.index === undefined) d.palette.push(c);
      else {
        if (o.index === 0) throw new TentenError("INDEX_0", "index 0 is always transparent");
        if (o.index > d.palette.length) throw new TentenError("NO_COLOUR", `index ${o.index} would leave a gap`, `next free index is ${d.palette.length}`);
        d.palette[o.index] = c;
      }
      return;
    }
    case "palette": { d.palette = [[0, 0, 0, 0], ...o.colours.map(hexToRgba)]; return; }
    default: throw new TentenError("BAD_OP", `unknown op ${(o as { op: string }).op}`);
  }
}
