// The MCP server: twelve tools over a registry of open documents. Every result carries structuredContent plus the
// same JSON as text, and every edit returns the text grid of the frame it touched so the model sees what it did.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { decodeAseprite, encodeAseprite } from "./aseprite.ts";
import { TentenError, flatten, type Doc } from "./doc.ts";
import { Editor } from "./editor.ts";
import { load, serialize } from "./format.ts";
import { diffPixels, frameGrid, indexToChar } from "./grid.ts";
import type { Op } from "./ops.ts";
import { PALETTES, ramp, hexToRgba, rgbaToHex } from "./palette.ts";
import { startPreview, type Preview } from "./preview.ts";
import { asepriteJson, framePng, previewPng, sheet, type SheetLayout } from "./render.ts";

const INSTRUCTIONS = `tenten draws indexed pixel art and animations headlessly. Documents are sprites: a palette (index 0 is transparent), layers, frames with durations, tags, slices.
1. tt_new makes a document (name, size, a named palette or hex colours); tt_open loads a .tt or .aseprite file. Several can be open; every tool takes doc (default: the newest).
2. Read before you draw: tt_describe gives size, palette, layers, frames, tags, slices and the text grid of a frame. Each palette entry is "index=colour (grid char)": "." is transparent and 0-9a-zA-Z stand for palette indices 1-61, so index 1 is drawn as "0". Use the char in brackets when writing grids.
3. Draw with tt_draw: a batch of ops applied in order as one undo step. The cheapest way to draw a sprite is one grid op with rows of text; use pixel, line, rect, ellipse, diamond (2:1 isometric footprint), flood, outline, shift, flip, replace, copy for edits. The result is the grid of the frame you touched (frame 0 unless an op names another). A failed op rolls the whole batch back.
4. Frames and animation are ops too: addFrame (copies the previous frame unless copy:false), removeFrame, duration, tag. Layers: addLayer, removeLayer; ops take layer by name (default: the top layer) and frame by index.
5. Palette: palette (replace all), colour (append or set an index). tt_palettes lists the built-in palettes and makes shading ramps.
6. tt_render returns a frame as text, or every frame as a zoomed PNG image (view: "png") with its index under it, when you need to judge the look. tt_diff lists the pixels that differ between two frames or two documents, for round-trip and regression checks; tt_export writes PNGs, a sheet and Aseprite-style JSON that Phaser and Pixi load (and .aseprite with aseprite: true). tt_save writes .tt or .aseprite by extension. tt_undo undoes batches.
7. tt_preview opens a small window for the human that shows every open document and plays its animations, updating on every change. tt_watch re-exports a document to a directory after every change, so a dev server watching that directory hot-reloads the art.`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (v: unknown) => ({ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) });
const ok = (body: Record<string, unknown>, extra: Content[] = []) => ({ content: [text(body), ...extra], structuredContent: body });
const fail = (e: unknown) => {
  const te = e instanceof TentenError ? e : new TentenError("INTERNAL", e instanceof Error ? e.message : String(e));
  return { isError: true, content: [text(`${te.code}: ${te.message}${te.hint ? "\nHint: " + te.hint : ""}`)], structuredContent: { code: te.code, message: te.message, hint: te.hint } };
};

interface ExportOptions { dir: string; layout?: SheetLayout; scale?: number; padding?: number; frames?: boolean; debuff?: boolean; aseprite?: boolean }
interface Entry { e: Editor; watch?: ExportOptions }

export async function exportDoc(d: Doc, a: ExportOptions) {
  await mkdir(a.dir, { recursive: true });
  const scale = a.scale ?? 1;
  const s = sheet(d, a.layout ?? "horizontal", scale, a.padding ?? 0);
  const written: string[] = [];
  const put = async (name: string, data: Uint8Array | string) => { const p = join(a.dir, name); await writeFile(p, data); written.push(p); };
  await put(`${d.name}.png`, s.png);
  await put(`${d.name}.json`, JSON.stringify(asepriteJson(d, s, `${d.name}.png`, scale), null, 2));
  if (a.frames) for (const [i, f] of d.frames.entries()) await put(`${d.name}-${i}.png`, framePng(d, f, scale));
  if (a.debuff) await put(`${d.name}@${d.width * scale}x${d.height * scale}.png`, sheet(d, "horizontal", scale, 0).png);
  if (a.aseprite) await put(`${d.name}.aseprite`, encodeAseprite(d));
  return { written, sheet: { width: s.width, height: s.height, columns: s.columns, frames: s.frames.length } };
}

export async function loadAny(path: string): Promise<Doc> {
  if (extname(path).toLowerCase() === ".aseprite" || extname(path).toLowerCase() === ".ase") { const d = decodeAseprite(await readFile(path)); d.name = basename(path, extname(path)); return d; }
  return load(path);
}

export async function saveAny(d: Doc, path: string) {
  await mkdir(dirname(path), { recursive: true });
  const ext = extname(path).toLowerCase();
  if (ext === ".aseprite" || ext === ".ase") await writeFile(path, encodeAseprite(d));
  else await writeFile(path, serialize(d), "utf8");
}

export function createServer(version = "0.0.1") {
  const server = new McpServer({ name: "tenten", version }, { instructions: INSTRUCTIONS });
  const docs = new Map<string, Entry>();
  let current: Entry | undefined;
  let preview: Preview | undefined;

  const get = (name?: string) => {
    const en = name ? docs.get(name) : current;
    if (!en) throw new TentenError("NO_DOC", name ? `no open document "${name}"` : "no document is open", `open: ${[...docs.keys()].join(", ") || "none"}; use tt_new or tt_open`);
    current = en;
    return en;
  };
  const adopt = (e: Editor) => { const en: Entry = { e }; docs.set(e.doc.name, en); current = en; return en; };
  const changed = async (en?: Entry) => {
    preview?.changed();
    if (en?.watch) await exportDoc(en.e.doc, en.watch);
  };
  const describe = (d: Doc, frame = 0) => ({
    name: d.name, width: d.width, height: d.height,
    palette: d.palette.map((c, i) => `${i}=${i === 0 ? "transparent" : rgbaToHex(c)}${i < 62 ? ` (${indexToChar(i)})` : ""}`),
    layers: d.layers.map((l) => l.visible ? l.name : `${l.name} (hidden)`),
    frames: d.frames.map((f) => f.durationMs), tags: d.tags, slices: d.slices,
    frame, grid: frameGrid(d, d.frames[frame] ?? d.frames[0]),
  });
  const run = <A,>(fn: (a: A) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>) => async (a: A) => { try { return await fn(a); } catch (e) { return fail(e); } };
  const docArg = z.string().optional().describe("document name; default the newest");
  const exportArgs = { layout: z.enum(["horizontal", "vertical", "grid"]).optional(), scale: z.number().int().min(1).max(16).optional(), padding: z.number().int().min(0).optional(), frames: z.boolean().optional().describe("also write one PNG per frame"), debuff: z.boolean().optional().describe("also write name@WxH.png, the horizontal strip debuff's asset compiler reads"), aseprite: z.boolean().optional().describe("also write name.aseprite") };

  server.registerTool("tt_new", {
    title: "New document",
    description: "Create a sprite with a size and a palette (a built-in name such as pico8, endesga16, squish, or hex colours).",
    inputSchema: { name: z.string(), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(1024), palette: z.union([z.string(), z.array(z.string())]).optional().describe("built-in palette name or hex colours; index 0 is always transparent"), frames: z.number().int().min(1).max(256).optional(), durationMs: z.number().int().min(1).optional() },
  }, run(async (a: { name: string; width: number; height: number; palette?: string | string[]; frames?: number; durationMs?: number }) => {
    const colours = typeof a.palette === "string" ? PALETTES[a.palette] : a.palette;
    if (typeof a.palette === "string" && !colours) throw new TentenError("NO_PALETTE", `no built-in palette "${a.palette}"`, `built in: ${Object.keys(PALETTES).join(", ")}`);
    const en = adopt(Editor.create(a.name, a.width, a.height, (colours ?? []).map(hexToRgba)));
    const ops: Op[] = [];
    for (let i = 1; i < (a.frames ?? 1); i++) ops.push({ op: "addFrame", copy: false });
    if (a.durationMs) ops.push({ op: "duration", ms: a.durationMs });
    if (ops.length) { en.e.batch(ops); en.e.past = []; }
    await changed(en);
    return ok(describe(en.e.doc));
  }));

  server.registerTool("tt_open", {
    title: "Open a file",
    description: "Load a .tt or .aseprite file; tt_save writes it back to the same path. An RGB or grayscale .aseprite opens with a palette of only the colours it uses, so saving it back writes a smaller indexed file.",
    inputSchema: { path: z.string() },
  }, run(async (a: { path: string }) => { const en = adopt(new Editor(await loadAny(a.path), resolve(a.path))); await changed(en); return ok(describe(en.e.doc)); }));

  server.registerTool("tt_save", {
    title: "Save",
    description: "Write the document as .tt (JSON with text-grid cels, diffable in git) or .aseprite, by extension.",
    inputSchema: { doc: docArg, path: z.string().optional().describe("default: the path it was opened from, or <name>.tt") },
  }, run(async (a: { doc?: string; path?: string }) => {
    const en = get(a.doc);
    const path = resolve(a.path ?? en.e.path ?? `${en.e.doc.name}.tt`);
    await saveAny(en.e.doc, path); en.e.path = path;
    return ok({ saved: path });
  }));

  server.registerTool("tt_describe", {
    title: "Describe",
    description: "Size, palette with indices, layers, frames, tags, slices, and the text grid of one frame.",
    inputSchema: { doc: docArg, frame: z.number().int().min(0).optional() },
  }, run(async (a: { doc?: string; frame?: number }) => ok(describe(get(a.doc).e.doc, a.frame ?? 0))));

  server.registerTool("tt_draw", {
    title: "Draw",
    description: "Apply a batch of ops as one undo step and return the grid of the frame touched. Ops: grid, pixel, line, rect, ellipse, diamond (2:1 isometric footprint), flood, outline, shift, flip, replace, copy, clear, addLayer, removeLayer, addFrame, removeFrame, duration, tag, untag, slice, unslice, colour, palette.",
    inputSchema: { doc: docArg, ops: z.array(z.record(z.string(), z.unknown())).min(1).describe("each {op: name, ...fields}; layer by name and frame by index are optional on pixel ops"), show: z.number().int().min(0).optional().describe("frame to return; default the last frame an op named") },
  }, run(async (a: { doc?: string; ops: Record<string, unknown>[]; show?: number }) => {
    const en = get(a.doc), e = en.e;
    e.batch(a.ops as unknown as Op[]);
    await changed(en);
    const last = [...a.ops].reverse().find((o) => typeof o.frame === "number");
    const frame = a.show ?? (typeof last?.frame === "number" ? last.frame : 0);
    const f = e.doc.frames[Math.min(frame, e.doc.frames.length - 1)];
    return ok({ applied: a.ops.length, frame: e.doc.frames.indexOf(f), frames: e.doc.frames.length, grid: frameGrid(e.doc, f) });
  }));

  server.registerTool("tt_undo", {
    title: "Undo",
    description: "Undo (or redo) the last batches.",
    inputSchema: { doc: docArg, steps: z.number().int().min(1).optional(), redo: z.boolean().optional() },
  }, run(async (a: { doc?: string; steps?: number; redo?: boolean }) => {
    const en = get(a.doc), e = en.e;
    const n = a.redo ? e.redo(a.steps ?? 1) : e.undo(a.steps ?? 1);
    await changed(en);
    return ok({ [a.redo ? "redone" : "undone"]: n, grid: frameGrid(e.doc, e.doc.frames[0]) });
  }));

  server.registerTool("tt_render", {
    title: "Render",
    description: "A frame as a text grid, or every frame as one zoomed PNG image (view: png) with its index drawn under it, to judge the look.",
    inputSchema: { doc: docArg, frame: z.number().int().min(0).optional(), view: z.enum(["text", "png"]).optional(), scale: z.number().int().min(1).max(32).optional().describe("png zoom, default 8") },
  }, run(async (a: { doc?: string; frame?: number; view?: "text" | "png"; scale?: number }) => {
    const e = get(a.doc).e;
    if (a.view === "png") {
      const png = a.frame === undefined ? previewPng(e.doc, a.scale ?? 8) : framePng(e.doc, e.doc.frames[a.frame], a.scale ?? 8);
      return ok({ frames: e.doc.frames.length, scale: a.scale ?? 8 }, [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }]);
    }
    const frames = a.frame === undefined ? e.doc.frames : [e.doc.frames[a.frame]];
    return ok({ grids: frames.map((f) => frameGrid(e.doc, f)) });
  }));

  const side = z.object({ doc: docArg, frame: z.number().int().min(0).optional() }).optional();
  server.registerTool("tt_diff", {
    title: "Diff",
    description: "The pixels that differ between two frames, of one document or two. With no frames given, every frame of a is compared with the same frame of b. The grid shows the new index where a pixel changed and - elsewhere.",
    inputSchema: { a: side.describe("first side; default the newest document"), b: side.describe("second side; default the same document as a"), maxCells: z.number().int().min(0).optional().describe("changed cells to list per frame, default 64") },
  }, run(async (a: { a?: { doc?: string; frame?: number }; b?: { doc?: string; frame?: number }; maxCells?: number }) => {
    const da = get(a.a?.doc).e.doc, db = get(a.b?.doc ?? a.a?.doc).e.doc;
    if (da.width !== db.width || da.height !== db.height) throw new TentenError("SIZE_MISMATCH", `${da.name} is ${da.width}x${da.height} but ${db.name} is ${db.width}x${db.height}`);
    const pairs = a.a?.frame !== undefined || a.b?.frame !== undefined
      ? [[a.a?.frame ?? 0, a.b?.frame ?? a.a?.frame ?? 0]]
      : Array.from({ length: Math.max(da.frames.length, db.frames.length) }, (_, i) => [i, i]);
    const frames = pairs.map(([fa, fb]) => {
      const A = da.frames[fa], B = db.frames[fb];
      if (!A || !B) return { a: fa, b: fb, missing: !A ? da.name : db.name };
      return { a: fa, b: fb, ...diffPixels(flatten(da, A), flatten(db, B), da.width, da.height, a.maxCells) };
    });
    const paletteSame = da.palette.length === db.palette.length && da.palette.every((c, i) => c.every((v, k) => v === db.palette[i][k]));
    return ok({ a: da.name, b: db.name, same: paletteSame && frames.every((f) => "changed" in f && f.changed === 0), paletteSame, frames });
  }));

  server.registerTool("tt_export", {
    title: "Export",
    description: "Write <name>.png (a sheet) and <name>.json (Aseprite-style, loads in Phaser and Pixi) to a directory; optionally one PNG per frame, a debuff name@WxH.png strip, and a .aseprite file.",
    inputSchema: { doc: docArg, dir: z.string(), ...exportArgs },
  }, run(async (a: { doc?: string } & ExportOptions) => ok(await exportDoc(get(a.doc).e.doc, a))));

  server.registerTool("tt_watch", {
    title: "Watch (hot reload)",
    description: "Re-export the document to a directory after every change, so a dev server watching that directory (debuff, Vite) reloads the art as you draw. Pass stop: true to end it.",
    inputSchema: { doc: docArg, dir: z.string().optional(), stop: z.boolean().optional(), ...exportArgs },
  }, run(async (a: { doc?: string; dir?: string; stop?: boolean } & Partial<ExportOptions>) => {
    const en = get(a.doc);
    if (a.stop) { en.watch = undefined; return ok({ watching: false }); }
    if (!a.dir) throw new TentenError("NO_DIR", "dir is required to start watching");
    en.watch = { ...a, dir: a.dir };
    const first = await exportDoc(en.e.doc, en.watch);
    return ok({ watching: true, dir: resolve(a.dir), ...first });
  }));

  server.registerTool("tt_preview", {
    title: "Preview window",
    description: "Start (and open in the browser) a small page showing every open document zoomed, playing its animations, updated on every change. Returns the URL.",
    inputSchema: { open: z.boolean().optional().describe("open the page in the default browser; default true") },
  }, run(async (a: { open?: boolean }) => {
    preview ??= await startPreview(() => [...docs.values()].map((en) => en.e.doc));
    if (a.open !== false) preview.open();
    return ok({ url: preview.url });
  }));

  server.registerTool("tt_palettes", {
    title: "Palettes and ramps",
    description: "List the built-in palettes, or make a shading ramp from a base colour to append with the colour op.",
    inputSchema: { ramp: z.object({ base: z.string(), steps: z.number().int().min(2).max(9) }).optional() },
  }, run(async (a: { ramp?: { base: string; steps: number } }) => {
    if (a.ramp) return ok({ ramp: ramp(hexToRgba(a.ramp.base), a.ramp.steps).map(rgbaToHex) });
    return ok({ palettes: PALETTES });
  }));

  const close = () => { preview?.close(); };
  return { server, docs, close };
}
