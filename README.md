# tenten

A headless pixel-art and animation tool for coding agents. Sprites are indexed (a palette, index 0 transparent) with layers, frames, tags and slices. An MCP server and a CLI are the only interfaces; there is no editing GUI. Every edit returns the frame as a text grid so the model sees what it drew.

Inspired by Aseprite, not a clone of it. The `.tt` file is JSON with cels stored as text grids, so it reads with `cat` and diffs in git. Exports write PNG sheets and Aseprite-style JSON that Phaser's `load.aseprite` and Pixi's spritesheet parser accept, and the `name@WxH.png` strips debuff's asset compiler reads.

## Use it from an agent

```json
{ "mcpServers": { "tenten": { "command": "npx", "args": ["-y", "tenten", "tenten-mcp"] } } }
```

Or from a checkout: `node bin/tenten-mcp.js`. Nine tools: `tt_new`, `tt_open`, `tt_save`, `tt_describe`, `tt_draw`, `tt_undo`, `tt_render`, `tt_export`, `tt_palettes`. A sprite is usually one `tt_draw` call with a `grid` op:

```json
{ "ops": [
  { "op": "grid", "rows": ["..0000..", ".011110.", "01122110", "01111110", ".011110.", "..3..3.."] },
  { "op": "outline", "c": 4 },
  { "op": "addFrame" }, { "op": "shift", "dx": 0, "dy": 1, "frame": 1 },
  { "op": "tag", "name": "idle", "from": 0, "to": 1 }
] }
```

In a grid `.` is transparent and `0-9a-zA-Z` are palette indices 1 to 61.

## CLI

```
tenten show <file.tt> [--frame n]
tenten info <file.tt>
tenten export <file.tt> [--out dir] [--layout horizontal|vertical|grid] [--scale n] [--padding n] [--frames] [--debuff]
tenten preview <file.tt> [--out file.png] [--scale n]
```

## Library

```ts
import { Editor, save, sheet } from "tenten";
const e = Editor.create("coin", 8, 8);
e.batch([{ op: "palette", colours: ["#ffd700", "#b8860b"] }, { op: "ellipse", x: 0, y: 0, w: 8, h: 8, c: 1, fill: true }]);
await save(e.doc, "coin.tt");
```

Ops: `grid`, `pixel`, `line`, `rect`, `ellipse`, `diamond` (a 2:1 isometric footprint), `flood`, `outline`, `shift`, `flip`, `replace`, `copy`, `clear`, `addLayer`, `removeLayer`, `addFrame`, `removeFrame`, `duration`, `tag`, `untag`, `slice`, `unslice`, `colour`, `palette`. A batch is one undo step and rolls back whole if an op fails.

## Not yet

`.aseprite` import and export, a preview window, hot reload into a running game, tilemap layers, brushes. Node 24 runs the TypeScript source directly; `npm run check` typechecks and runs the tests.
