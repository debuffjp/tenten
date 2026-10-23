// The MCP server: nine tools over a registry of open documents. Every result carries structuredContent plus the
// same JSON as text, and every edit returns the text grid of the frame it touched so the model sees what it did.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TentenError, type Doc } from "./doc.ts";
import { Editor } from "./editor.ts";
import { load, save } from "./format.ts";
import { frameGrid } from "./grid.ts";
import type { Op } from "./ops.ts";
import { PALETTES, ramp, hexToRgba, rgbaToHex } from "./palette.ts";
import { asepriteJson, framePng, previewPng, sheet, type SheetLayout } from "./render.ts";

const INSTRUCTIONS = `tenten draws indexed pixel art and animations headlessly. Documents are sprites: a palette (index 0 is transparent), layers, frames with durations, tags, slices.
1. tt_new makes a document (name, size, a named palette or hex colours); tt_open loads a .tt file. Several can be open; every tool takes doc (default: the newest).
2. Read before you draw: tt_describe gives size, palette with indices, layers, frames, tags, slices and the text grid of a frame. In grids "." is transparent and 0-9a-zA-Z are palette indices 1-61.
3. Draw with tt_draw: a batch of ops applied in order as one undo step. The cheapest way to draw a sprite is one grid op with rows of text; use pixel, line, rect, ellipse, flood, outline, shift, flip, replace, copy for edits. The result is the grid of the frame you touched (frame 0 unless an op names another). A failed op rolls the whole batch back.
4. Frames and animation are ops too: addFrame (copies the previous frame unless copy:false), removeFrame, duration, tag. Layers: addLayer, removeLayer; ops take layer by name (default: the top layer) and frame by index.
5. Palette: palette (replace all), colour (append or set an index). tt_palettes lists the built-in palettes and makes shading ramps.
6. tt_render returns a frame as text, or as a zoomed PNG image (view: "png") when you need to judge the look; tt_export writes PNGs, a sheet and Aseprite-style JSON that Phaser and Pixi load. tt_save writes the .tt file. tt_undo undoes batches.`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (v: unknown) => ({ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) });
const ok = (body: Record<string, unknown>, extra: Content[] = []) => ({ content: [text(body), ...extra], structuredContent: body });
const fail = (e: unknown) => {
  const te = e instanceof TentenError ? e : new TentenError("INTERNAL", e instanceof Error ? e.message : String(e));
  return { isError: true, content: [text(`${te.code}: ${te.message}${te.hint ? "\nHint: " + te.hint : ""}`)], structuredContent: { code: te.code, message: te.message, hint: te.hint } };
};

export function createServer(version = "0.0.1") {
  const server = new McpServer({ name: "tenten", version }, { instructions: INSTRUCTIONS });
  const docs = new Map<string, Editor>();
  let current: Editor | undefined;

  const get = (name?: string) => {
    const e = name ? docs.get(name) : current;
    if (!e) throw new TentenError("NO_DOC", name ? `no open document "${name}"` : "no document is open", `open: ${[...docs.keys()].join(", ") || "none"}; use tt_new or tt_open`);
    current = e;
    return e;
  };
  const adopt = (e: Editor) => { docs.set(e.doc.name, e); current = e; return e; };
  const describe = (d: Doc, frame = 0) => ({
    name: d.name, width: d.width, height: d.height,
    palette: d.palette.map((c, i) => `${i}=${i === 0 ? "transparent" : rgbaToHex(c)}`),
    layers: d.layers.map((l) => l.visible ? l.name : `${l.name} (hidden)`),
    frames: d.frames.map((f) => f.durationMs), tags: d.tags, slices: d.slices,
    frame, grid: frameGrid(d, d.frames[frame] ?? d.frames[0]),
  });
  const run = <A,>(fn: (a: A) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>) => async (a: A) => { try { return await fn(a); } catch (e) { return fail(e); } };
  const docArg = z.string().optional().describe("document name; default the newest");

  server.registerTool("tt_new", {
    title: "New document",
    description: "Create a sprite with a size and a palette (a built-in name such as pico8, endesga16, squish, or hex colours).",
    inputSchema: { name: z.string(), width: z.number().int().min(1).max(1024), height: z.number().int().min(1).max(1024), palette: z.union([z.string(), z.array(z.string())]).optional().describe("built-in palette name or hex colours; index 0 is always transparent"), frames: z.number().int().min(1).max(256).optional(), durationMs: z.number().int().min(1).optional() },
  }, run(async (a: { name: string; width: number; height: number; palette?: string | string[]; frames?: number; durationMs?: number }) => {
    const colours = typeof a.palette === "string" ? PALETTES[a.palette] : a.palette;
    if (typeof a.palette === "string" && !colours) throw new TentenError("NO_PALETTE", `no built-in palette "${a.palette}"`, `built in: ${Object.keys(PALETTES).join(", ")}`);
    const e = adopt(Editor.create(a.name, a.width, a.height, (colours ?? []).map(hexToRgba)));
    const ops: Op[] = [];
    for (let i = 1; i < (a.frames ?? 1); i++) ops.push({ op: "addFrame", copy: false });
    if (a.durationMs) ops.push({ op: "duration", ms: a.durationMs });
    if (ops.length) { e.batch(ops); e.past = []; }
    return ok(describe(e.doc));
  }));

  server.registerTool("tt_open", {
    title: "Open a .tt file",
    description: "Load a document from disk; tt_save writes it back to the same path.",
    inputSchema: { path: z.string() },
  }, run(async (a: { path: string }) => { const e = adopt(new Editor(await load(a.path), resolve(a.path))); return ok(describe(e.doc)); }));

  server.registerTool("tt_save", {
    title: "Save",
    description: "Write the document as a .tt file (JSON with text-grid cels, diffable in git).",
    inputSchema: { doc: docArg, path: z.string().optional().describe("default: the path it was opened from, or <name>.tt") },
  }, run(async (a: { doc?: string; path?: string }) => {
    const e = get(a.doc);
    const path = resolve(a.path ?? e.path ?? `${e.doc.name}.tt`);
    await mkdir(dirname(path), { recursive: true });
    await save(e.doc, path); e.path = path;
    return ok({ saved: path });
  }));

  server.registerTool("tt_describe", {
    title: "Describe",
    description: "Size, palette with indices, layers, frames, tags, slices, and the text grid of one frame.",
    inputSchema: { doc: docArg, frame: z.number().int().min(0).optional() },
  }, run(async (a: { doc?: string; frame?: number }) => ok(describe(get(a.doc).doc, a.frame ?? 0))));

  server.registerTool("tt_draw", {
    title: "Draw",
    description: "Apply a batch of ops as one undo step and return the grid of the frame touched. Ops: grid, pixel, line, rect, ellipse, diamond (2:1 isometric footprint), flood, outline, shift, flip, replace, copy, clear, addLayer, removeLayer, addFrame, removeFrame, duration, tag, untag, slice, unslice, colour, palette.",
    inputSchema: { doc: docArg, ops: z.array(z.record(z.string(), z.unknown())).min(1).describe("each {op: name, ...fields}; layer by name and frame by index are optional on pixel ops"), show: z.number().int().min(0).optional().describe("frame to return; default the last frame an op named") },
  }, run(async (a: { doc?: string; ops: Record<string, unknown>[]; show?: number }) => {
    const e = get(a.doc);
    e.batch(a.ops as unknown as Op[]);
    const last = [...a.ops].reverse().find((o) => typeof o.frame === "number");
    const frame = a.show ?? (typeof last?.frame === "number" ? last.frame : e.doc.frames.length - 1 === 0 ? 0 : 0);
    const f = e.doc.frames[Math.min(frame, e.doc.frames.length - 1)];
    return ok({ applied: a.ops.length, frame: e.doc.frames.indexOf(f), frames: e.doc.frames.length, grid: frameGrid(e.doc, f) });
  }));

  server.registerTool("tt_undo", {
    title: "Undo",
    description: "Undo (or redo) the last batches.",
    inputSchema: { doc: docArg, steps: z.number().int().min(1).optional(), redo: z.boolean().optional() },
  }, run(async (a: { doc?: string; steps?: number; redo?: boolean }) => {
    const e = get(a.doc);
    const n = a.redo ? e.redo(a.steps ?? 1) : e.undo(a.steps ?? 1);
    return ok({ [a.redo ? "redone" : "undone"]: n, grid: frameGrid(e.doc, e.doc.frames[0]) });
  }));

  server.registerTool("tt_render", {
    title: "Render",
    description: "A frame as a text grid, or every frame as one zoomed PNG image (view: png) to judge the look.",
    inputSchema: { doc: docArg, frame: z.number().int().min(0).optional(), view: z.enum(["text", "png"]).optional(), scale: z.number().int().min(1).max(32).optional().describe("png zoom, default 8") },
  }, run(async (a: { doc?: string; frame?: number; view?: "text" | "png"; scale?: number }) => {
    const e = get(a.doc);
    if (a.view === "png") {
      const png = a.frame === undefined ? previewPng(e.doc, a.scale ?? 8) : framePng(e.doc, e.doc.frames[a.frame], a.scale ?? 8);
      return ok({ frames: e.doc.frames.length, scale: a.scale ?? 8 }, [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }]);
    }
    const frames = a.frame === undefined ? e.doc.frames : [e.doc.frames[a.frame]];
    return ok({ grids: frames.map((f) => frameGrid(e.doc, f)) });
  }));

  server.registerTool("tt_export", {
    title: "Export",
    description: "Write <name>.png (a sheet) and <name>.json (Aseprite-style, loads in Phaser and Pixi) to a directory; optionally one PNG per frame and a debuff name@WxH.png grid.",
    inputSchema: { doc: docArg, dir: z.string(), layout: z.enum(["horizontal", "vertical", "grid"]).optional(), scale: z.number().int().min(1).max(16).optional(), padding: z.number().int().min(0).optional(), frames: z.boolean().optional().describe("also write one PNG per frame"), debuff: z.boolean().optional().describe("also write name@WxH.png, the horizontal strip debuff's asset compiler reads") },
  }, run(async (a: { doc?: string; dir: string; layout?: SheetLayout; scale?: number; padding?: number; frames?: boolean; debuff?: boolean }) => {
    const e = get(a.doc), d = e.doc;
    await mkdir(a.dir, { recursive: true });
    const s = sheet(d, a.layout ?? "horizontal", a.scale ?? 1, a.padding ?? 0);
    const written: string[] = [];
    const put = async (name: string, data: Uint8Array | string) => { const p = join(a.dir, name); await writeFile(p, data); written.push(p); };
    await put(`${d.name}.png`, s.png);
    await put(`${d.name}.json`, JSON.stringify(asepriteJson(d, s, `${d.name}.png`, a.scale ?? 1), null, 2));
    if (a.frames) for (const [i, f] of d.frames.entries()) await put(`${d.name}-${i}.png`, framePng(d, f, a.scale ?? 1));
    if (a.debuff) await put(`${d.name}@${d.width * (a.scale ?? 1)}x${d.height * (a.scale ?? 1)}.png`, sheet(d, "horizontal", a.scale ?? 1, 0).png);
    return ok({ written, sheet: { width: s.width, height: s.height, columns: s.columns, frames: s.frames.length } });
  }));

  server.registerTool("tt_palettes", {
    title: "Palettes and ramps",
    description: "List the built-in palettes, or make a shading ramp from a base colour to append with the colour op.",
    inputSchema: { ramp: z.object({ base: z.string(), steps: z.number().int().min(2).max(9) }).optional() },
  }, run(async (a: { ramp?: { base: string; steps: number } }) => {
    if (a.ramp) return ok({ ramp: ramp(hexToRgba(a.ramp.base), a.ramp.steps).map(rgbaToHex) });
    return ok({ palettes: Object.fromEntries(Object.entries(PALETTES).map(([k, v]) => [k, v])) });
  }));

  return { server, docs, open: (path: string) => load(path).then((d) => adopt(new Editor(d, resolve(path)))), nameOf: (p: string) => basename(p, ".tt") };
}
