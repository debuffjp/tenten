// The .tt file: one JSON document an agent can read with cat and diff in git. Cels are stored as text-grid rows
// while the palette fits the grid alphabet (up to 61 colours), and as base64 bytes beyond that.
import { readFile, writeFile } from "node:fs/promises";
import type { Cel, Doc } from "./doc.ts";
import { TentenError } from "./doc.ts";
import { fromGrid, toGrid } from "./grid.ts";
import { hexToRgba, rgbaToHex } from "./palette.ts";

export const FORMAT = "tenten/1";
const GRID_LIMIT = 62;

interface TtCel { layer: string; frame: number; rows?: string[]; base64?: string }

export function serialize(d: Doc): string {
  const layerName = (id: number) => d.layers.find((l) => l.id === id)!.name;
  const frameIndex = (id: number) => d.frames.findIndex((f) => f.id === id);
  const cels: TtCel[] = d.cels
    .filter((c) => c.pixels.some((p) => p !== 0))
    .map((c) => ({ layer: layerName(c.layer), frame: frameIndex(c.frame), ...(d.palette.length <= GRID_LIMIT ? { rows: toGrid(c.pixels, d.width, d.height).split("\n") } : { base64: Buffer.from(c.pixels).toString("base64") }) }))
    .sort((a, b) => a.frame - b.frame || a.layer.localeCompare(b.layer));
  const out = {
    format: FORMAT,
    name: d.name,
    size: [d.width, d.height],
    palette: d.palette.slice(1).map(rgbaToHex),
    layers: d.layers.map((l) => ({ name: l.name, ...(l.visible ? {} : { visible: false }), ...(l.opacity === 255 ? {} : { opacity: l.opacity }) })),
    frames: d.frames.map((f) => f.durationMs),
    tags: d.tags,
    slices: d.slices,
    cels,
  };
  return JSON.stringify(out, null, 1).replace(/\[\n\s+("[.0-9a-zA-Z]+",?\n\s+)+\]/g, (m) => m.replace(/\n\s+/g, " ").replace("[ ", "[").replace(" ]", "]"));
}

export function deserialize(text: string): Doc {
  let j: ReturnType<typeof JSON.parse>;
  try { j = JSON.parse(text); } catch (e) { throw new TentenError("BAD_TT", `not JSON: ${(e as Error).message}`); }
  if (j.format !== FORMAT) throw new TentenError("BAD_TT", `unknown format ${j.format}`, `expected ${FORMAT}`);
  const [width, height] = j.size as [number, number];
  let nextId = 1;
  const layers = (j.layers as { name: string; visible?: boolean; opacity?: number }[]).map((l) => ({ id: nextId++, name: l.name, visible: l.visible !== false, opacity: l.opacity ?? 255 }));
  const frames = (j.frames as number[]).map((ms) => ({ id: nextId++, durationMs: ms }));
  const cels: Cel[] = (j.cels as TtCel[]).map((c) => {
    const layer = layers.find((l) => l.name === c.layer);
    const frame = frames[c.frame];
    if (!layer || !frame) throw new TentenError("BAD_TT", `cel refers to missing layer "${c.layer}" or frame ${c.frame}`);
    const pixels = c.rows ? fromGrid(c.rows, width, height) : new Uint8Array(Buffer.from(c.base64 ?? "", "base64"));
    if (pixels.length !== width * height) throw new TentenError("BAD_TT", `cel ${c.layer}/${c.frame} has ${pixels.length} pixels, expected ${width * height}`);
    return { layer: layer.id, frame: frame.id, pixels };
  });
  return { name: j.name, width, height, palette: [[0, 0, 0, 0], ...(j.palette as string[]).map(hexToRgba)], layers, frames, cels, tags: j.tags ?? [], slices: j.slices ?? [], nextId };
}

export async function save(d: Doc, path: string) { await writeFile(path, serialize(d), "utf8"); }
export async function load(path: string): Promise<Doc> { return deserialize(await readFile(path, "utf8")); }
