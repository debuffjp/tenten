// Drives the real server over stdio the way an agent would: new, draw a two-frame sprite, render, export, save, reopen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "fast-png";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string; data?: string }[] };

test("an agent session over stdio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tenten-"));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["bin/tenten-mcp.js"], stderr: "pipe" }));
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["tt_describe", "tt_diff", "tt_draw", "tt_export", "tt_new", "tt_open", "tt_palettes", "tt_preview", "tt_render", "tt_save", "tt_undo", "tt_watch"]);

    const made = await call("tt_new", { name: "coin", width: 6, height: 6, palette: ["#ffd700", "#b8860b", "#000000"] });
    assert.equal(made.isError, undefined, JSON.stringify(made.content));
    assert.deepEqual(made.structuredContent?.palette, ["0=transparent (.)", "1=#ffd700 (0)", "2=#b8860b (1)", "3=#000000 (2)"]);

    const drawn = await call("tt_draw", { ops: [
      { op: "grid", rows: [".0000.", "000010", "000010", "000010", "000010", ".0000."] },
      { op: "outline", c: 3 },
      { op: "addFrame" },
      { op: "shift", dx: 1, dy: 0, frame: 1 },
      { op: "tag", name: "spin", from: 0, to: 1 },
      { op: "duration", ms: 120 },
    ] });
    assert.equal(drawn.isError, undefined, JSON.stringify(drawn.content));
    assert.equal(drawn.structuredContent?.frames, 2);
    assert.equal(drawn.structuredContent?.frame, 1);
    assert.equal(drawn.structuredContent?.grid, ".20000\n.00001\n.00001\n.00001\n.00001\n.20000");

    const bad = await call("tt_draw", { ops: [{ op: "pixel", x: 0, y: 0, c: 9 }] });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text ?? "", /NO_COLOUR/);

    const png = await call("tt_render", { view: "png", scale: 4 });
    const image = png.content.find((c) => c.type === "image");
    assert.ok(image?.data);
    const decoded = decode(Buffer.from(image!.data!, "base64"));
    assert.equal(decoded.width, 2 * 6 * 4 + 4);

    const exported = await call("tt_export", { dir, debuff: true });
    assert.equal(exported.isError, undefined, JSON.stringify(exported.content));
    const json = JSON.parse(await readFile(join(dir, "coin.json"), "utf8"));
    assert.equal(json.meta.frameTags[0].name, "spin");
    assert.equal(json.frames["coin 1.ase"].duration, 120);
    const strip = decode(await readFile(join(dir, "coin@6x6.png")));
    assert.equal(strip.width, 12);

    const saved = await call("tt_save", { path: join(dir, "coin.tt") });
    assert.equal(saved.isError, undefined);
    const text = await readFile(join(dir, "coin.tt"), "utf8");
    assert.match(text, /"format": "tenten\/1"/);

    const undone = await call("tt_undo", {});
    assert.match(String(undone.structuredContent?.grid), /^\.{6}$/m);

    const reopened = await call("tt_open", { path: join(dir, "coin.tt") });
    assert.equal(reopened.structuredContent?.frames && (reopened.structuredContent.frames as number[]).length, 2);

    const watchDir = join(dir, "watch");
    const watching = await call("tt_watch", { dir: watchDir, aseprite: true });
    assert.equal(watching.structuredContent?.watching, true);
    await call("tt_draw", { ops: [{ op: "pixel", x: 0, y: 0, c: 1 }] });
    const watched = decode(await readFile(join(watchDir, "coin.png")));
    assert.deepEqual([...watched.data.subarray(0, 4)], [255, 215, 0, 255], "the watch export reflects the last draw");
    const ase = await call("tt_open", { path: join(watchDir, "coin.aseprite") });
    assert.equal(ase.isError, undefined, JSON.stringify(ase.content));
    assert.equal(ase.structuredContent?.grid, "000002\n000010\n000010\n000010\n000010\n200002");

    const same = await call("tt_diff", { a: { doc: "coin" }, b: { doc: "coin" } });
    assert.equal(same.structuredContent?.same, true, JSON.stringify(same.content));
    const diff = await call("tt_diff", { a: { frame: 0 }, b: { frame: 1 } });
    const f0 = (diff.structuredContent?.frames as { changed: number; grid: string }[])[0];
    assert.equal(diff.structuredContent?.same, false);
    const [g0, g1] = (await call("tt_render", {})).structuredContent?.grids as string[];
    const expected = [...g0].filter((ch, i) => ch !== g1[i]).length;
    assert.equal(f0.changed, expected);
    assert.equal(f0.grid.replace(/[-\n]/g, "").length, expected, "the grid marks exactly the changed cells");
    const mismatch = await call("tt_diff", { a: { frame: 0 }, b: { frame: 5 } });
    assert.equal((mismatch.structuredContent?.frames as { missing?: string }[])[0].missing, "coin");

    const pv = await call("tt_preview", { open: false });
    const url = String(pv.structuredContent?.url);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await (await fetch(url)).text();
    assert.match(page, /<title>tenten<\/title>/);
    const events = await fetch(`${url}events`);
    const chunk = new TextDecoder().decode((await events.body!.getReader().read()).value);
    assert.match(chunk, /"name":"coin"/);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
