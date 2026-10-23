// tenten <command>: show a .tt as text, export sheets, or describe. The MCP server is `tenten-mcp`.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { load } from "./format.ts";
import { frameGrid } from "./grid.ts";
import { rgbaToHex } from "./palette.ts";
import { asepriteJson, framePng, previewPng, sheet, type SheetLayout } from "./render.ts";

const USAGE = `tenten show <file.tt> [--frame n]        print a frame as a text grid (all frames by default)
tenten export <file.tt> [--out dir] [--layout horizontal|vertical|grid] [--scale n] [--padding n] [--frames] [--debuff]
tenten preview <file.tt> [--out file.png] [--scale n]   one zoomed PNG of every frame
tenten info <file.tt>                    palette, layers, frames, tags, slices`;

const { values, positionals } = parseArgs({ allowPositionals: true, options: { frame: { type: "string" }, out: { type: "string" }, layout: { type: "string" }, scale: { type: "string" }, padding: { type: "string" }, frames: { type: "boolean" }, debuff: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
const [cmd, file] = positionals;
if (values.help || !cmd || !file) { console.log(USAGE); process.exit(cmd ? 0 : 1); }

const d = await load(file);
const scale = Number(values.scale ?? 1);
switch (cmd) {
  case "show": {
    const frames = values.frame === undefined ? d.frames : [d.frames[Number(values.frame)]];
    console.log(frames.map((f) => frameGrid(d, f)).join("\n\n"));
    break;
  }
  case "info": {
    console.log(JSON.stringify({ name: d.name, size: [d.width, d.height], palette: d.palette.map((c, i) => `${i}=${i ? rgbaToHex(c) : "transparent"}`), layers: d.layers.map((l) => l.name), frames: d.frames.map((f) => f.durationMs), tags: d.tags, slices: d.slices }, null, 2));
    break;
  }
  case "export": {
    const dir = values.out ?? ".";
    await mkdir(dir, { recursive: true });
    const s = sheet(d, (values.layout as SheetLayout) ?? "horizontal", scale, Number(values.padding ?? 0));
    await writeFile(join(dir, `${d.name}.png`), s.png);
    await writeFile(join(dir, `${d.name}.json`), JSON.stringify(asepriteJson(d, s, `${d.name}.png`, scale), null, 2));
    if (values.frames) for (const [i, f] of d.frames.entries()) await writeFile(join(dir, `${d.name}-${i}.png`), framePng(d, f, scale));
    if (values.debuff) await writeFile(join(dir, `${d.name}@${d.width * scale}x${d.height * scale}.png`), sheet(d, "horizontal", scale, 0).png);
    console.log(`wrote ${d.name}.png (${s.width}x${s.height}, ${s.frames.length} frames) and ${d.name}.json to ${dir}`);
    break;
  }
  case "preview": {
    const out = values.out ?? `${basename(file, ".tt")}-preview.png`;
    await writeFile(out, previewPng(d, Number(values.scale ?? 8)));
    console.log(`wrote ${out}`);
    break;
  }
  default: console.log(USAGE); process.exit(1);
}
