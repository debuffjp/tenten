// tenten <command>: show a sprite as text, export sheets, convert between .tt and .aseprite. The MCP server is `tenten-mcp`.
import { writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { frameGrid, indexToChar } from "./grid.ts";
import { rgbaToHex } from "./palette.ts";
import { previewPng, type SheetLayout } from "./render.ts";
import { exportDoc, loadAny, saveAny } from "./server.ts";

const USAGE = `tenten show <file> [--frame n]           print a frame as a text grid (all frames by default)
tenten info <file>                       palette, layers, frames, tags, slices
tenten export <file> [--out dir] [--layout horizontal|vertical|grid] [--scale n] [--padding n] [--frames] [--debuff] [--aseprite]
tenten preview <file> [--out file.png] [--scale n]   one zoomed PNG of every frame
tenten convert <file> <out>              between .tt and .aseprite, by extension
<file> is .tt or .aseprite`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { frame: { type: "string" }, out: { type: "string" }, layout: { type: "string" }, scale: { type: "string" }, padding: { type: "string" }, frames: { type: "boolean" }, debuff: { type: "boolean" }, aseprite: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
const [cmd, file, target] = positionals;
if (values.help || !cmd || !file) { console.log(USAGE); process.exit(cmd ? 0 : 1); }

const d = await loadAny(file);
const scale = Number(values.scale ?? 1);
switch (cmd) {
  case "show": {
    const frames = values.frame === undefined ? d.frames : [d.frames[Number(values.frame)]];
    console.log(frames.map((f) => frameGrid(d, f)).join("\n\n"));
    break;
  }
  case "info": {
    console.log(JSON.stringify({ name: d.name, size: [d.width, d.height], palette: d.palette.map((c, i) => `${i}=${i ? rgbaToHex(c) : "transparent"}${i < 62 ? ` (${indexToChar(i)})` : ""}`), layers: d.layers.map((l) => l.name), frames: d.frames.map((f) => f.durationMs), tags: d.tags, slices: d.slices }, null, 2));
    break;
  }
  case "export": {
    const r = await exportDoc(d, { dir: values.out ?? ".", layout: values.layout as SheetLayout | undefined, scale, padding: Number(values.padding ?? 0), frames: values.frames, debuff: values.debuff, aseprite: values.aseprite });
    console.log(`wrote ${r.written.map((p) => basename(p)).join(", ")} (${r.sheet.width}x${r.sheet.height}, ${r.sheet.frames} frames) to ${values.out ?? "."}`);
    break;
  }
  case "preview": {
    const out = values.out ?? `${basename(file, extname(file))}-preview.png`;
    await writeFile(out, previewPng(d, Number(values.scale ?? 8)));
    console.log(`wrote ${out}`);
    break;
  }
  case "convert": {
    if (!target) { console.log(USAGE); process.exit(1); }
    await saveAny(d, target);
    console.log(`wrote ${target}`);
    break;
  }
  default: console.log(USAGE); process.exit(1);
}
