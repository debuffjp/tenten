// The document: an indexed sprite. Every cel is a byte per pixel naming a palette entry; 0 is transparent.
// A cel exists only where a layer has pixels in a frame, keyed "layer/frame" by id.

export type Rgba = [number, number, number, number];

export interface Layer { id: number; name: string; visible: boolean; opacity: number }
export interface Frame { id: number; durationMs: number }
export interface Cel { layer: number; frame: number; pixels: Uint8Array }
export interface Tag { name: string; from: number; to: number; direction: "forward" | "reverse" | "pingpong" }
export interface Slice { name: string; x: number; y: number; w: number; h: number; pivot?: [number, number]; kind: "hitbox" | "slice" }

export interface Doc {
  name: string;
  width: number;
  height: number;
  palette: Rgba[];
  layers: Layer[];
  frames: Frame[];
  cels: Cel[];
  tags: Tag[];
  slices: Slice[];
  nextId: number;
}

export const TRANSPARENT: Rgba = [0, 0, 0, 0];

export function newDoc(name: string, width: number, height: number, palette: Rgba[] = []): Doc {
  const pal = palette.length ? [TRANSPARENT, ...palette.filter((_, i) => i > 0 || !isTransparent(palette[0]))] : [TRANSPARENT];
  return { name, width, height, palette: pal, layers: [{ id: 1, name: "base", visible: true, opacity: 255 }], frames: [{ id: 2, durationMs: 100 }], cels: [], tags: [], slices: [], nextId: 3 };
}

const isTransparent = (c: Rgba | undefined) => !!c && c[3] === 0;

export function cloneDoc(d: Doc): Doc {
  return { ...d, palette: d.palette.map((c) => [...c] as Rgba), layers: d.layers.map((l) => ({ ...l })), frames: d.frames.map((f) => ({ ...f })), cels: d.cels.map((c) => ({ ...c, pixels: new Uint8Array(c.pixels) })), tags: d.tags.map((t) => ({ ...t })), slices: d.slices.map((s) => ({ ...s, pivot: s.pivot ? [...s.pivot] as [number, number] : undefined })) };
}

export function layerByName(d: Doc, name: string | number | undefined): Layer {
  const l = name === undefined ? d.layers[d.layers.length - 1] : typeof name === "number" ? d.layers.find((x) => x.id === name) : d.layers.find((x) => x.name === name);
  if (!l) throw new TentenError("NO_LAYER", `no layer "${name}"`, `layers: ${d.layers.map((x) => x.name).join(", ")}`);
  return l;
}

export function frameAt(d: Doc, index: number | undefined): Frame {
  const i = index ?? 0;
  const f = d.frames[i];
  if (!f) throw new TentenError("NO_FRAME", `no frame ${i}`, `frames: 0..${d.frames.length - 1}`);
  return f;
}

export function getCel(d: Doc, layer: Layer, frame: Frame): Cel | undefined {
  return d.cels.find((c) => c.layer === layer.id && c.frame === frame.id);
}

export function ensureCel(d: Doc, layer: Layer, frame: Frame): Cel {
  let c = getCel(d, layer, frame);
  if (!c) { c = { layer: layer.id, frame: frame.id, pixels: new Uint8Array(d.width * d.height) }; d.cels.push(c); }
  return c;
}

export function inBounds(d: Doc, x: number, y: number) { return x >= 0 && y >= 0 && x < d.width && y < d.height; }

// Composite one frame to a flat index buffer, top layer wins where its pixel is non-zero.
export function flatten(d: Doc, frame: Frame): Uint8Array {
  const out = new Uint8Array(d.width * d.height);
  for (const l of d.layers) {
    if (!l.visible) continue;
    const c = getCel(d, l, frame);
    if (!c) continue;
    for (let i = 0; i < out.length; i++) if (c.pixels[i]) out[i] = c.pixels[i];
  }
  return out;
}

export class TentenError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) { super(message); this.code = code; this.hint = hint; }
}
