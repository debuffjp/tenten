// Golden tests: Overbuffed's RGB .aseprite files render to the PNGs Aseprite exported from them, and a file tenten
// writes opens in the real Aseprite (when installed) and exports the same sheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "fast-png";
import { Editor, decodeAseprite, encodeAseprite, frameGrid, sheet } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures", "overbuffed");
const ASEPRITE = process.env.ASEPRITE ?? "C:/Program Files (x86)/Steam/steamapps/common/Aseprite/Aseprite.exe";

test("reads Overbuffed RGB files and renders Aseprite's own sheet export pixel for pixel", async () => {
  for (const [name, size] of [["buff", "22x22"], ["spiker", "16x16"]] as const) {
    const d = decodeAseprite(await readFile(join(fixtures, `${name}.aseprite`)));
    const expected = decode(await readFile(join(fixtures, `${name}@${size}.png`)));
    const got = decode(sheet(d, "horizontal").png);
    assert.equal(got.width, expected.width, name);
    assert.equal(got.height, expected.height, name);
    for (let i = 0; i < got.data.length; i += 4) {
      const ea = expected.data[i + 3], ga = got.data[i + 3];
      assert.equal(ga, ea, `${name} alpha at ${i / 4}`);
      if (ea) assert.deepEqual([...got.data.subarray(i, i + 3)], [...expected.data.subarray(i, i + 3)], `${name} rgb at ${i / 4}`);
    }
    assert.equal(d.frames.length, got.width / d.width);
    assert.ok(d.frames.every((f) => f.durationMs === 125), "boil frames are 125 ms");
  }
});

test("encode then decode round-trips pixels, palette, tags and slices", () => {
  const e = Editor.create("rt", 5, 4);
  e.batch([{ op: "palette", colours: ["#102030", "#405060", "#708090ff"] }, { op: "grid", rows: ["0.1.2", ".012.", "2.1.0"] }, { op: "addFrame" }, { op: "flip", axis: "x", frame: 1 }, { op: "addLayer", name: "fx" }, { op: "pixel", x: 4, y: 3, c: 3, layer: "fx" }, { op: "tag", name: "a", from: 0, to: 1, direction: "pingpong" }, { op: "slice", name: "hit", x: 1, y: 1, w: 2, h: 2, pivot: [2, 3] }]);
  const back = decodeAseprite(encodeAseprite(e.doc));
  assert.deepEqual(back.palette, e.doc.palette);
  assert.deepEqual(back.layers.map((l) => l.name), ["base", "fx"]);
  for (const i of [0, 1]) assert.equal(frameGrid(back, back.frames[i]), frameGrid(e.doc, e.doc.frames[i]));
  assert.deepEqual(back.tags, e.doc.tags);
  assert.deepEqual(back.slices.map((s) => ({ ...s, kind: "slice" })), e.doc.slices.map((s) => ({ ...s, kind: "slice" })));
});

test("a tenten-written file opens in Aseprite and exports the same sheet", { skip: !existsSync(ASEPRITE) && "Aseprite not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "tenten-ase-"));
  try {
    const e = Editor.create("gem", 8, 8);
    e.batch([{ op: "palette", colours: ["#cffb2d", "#7dffb3", "#11140d"] }, { op: "ellipse", x: 1, y: 1, w: 6, h: 6, c: 1, fill: true }, { op: "pixel", x: 3, y: 2, c: 2 }, { op: "outline", c: 3 }, { op: "addFrame" }, { op: "shift", dx: 0, dy: 1, frame: 1 }, { op: "tag", name: "bob", from: 0, to: 1 }]);
    const file = join(dir, "gem.aseprite");
    await writeFile(file, encodeAseprite(e.doc));
    const out = join(dir, "gem.png"), data = join(dir, "gem.json");
    execFileSync(ASEPRITE, ["-b", file, "--color-mode", "rgb", "--sheet", out, "--sheet-type", "horizontal", "--data", data, "--format", "json-hash", "--list-tags"], { stdio: "pipe" });
    const theirs = decode(await readFile(out));
    const ours = decode(sheet(e.doc, "horizontal").png);
    assert.equal(theirs.width, ours.width);
    assert.deepEqual([...theirs.data], [...ours.data]);
    const json = JSON.parse(await readFile(data, "utf8"));
    assert.equal(json.meta.frameTags[0].name, "bob");
    const resaved = join(dir, "resaved.aseprite");
    execFileSync(ASEPRITE, ["-b", file, "--save-as", resaved], { stdio: "pipe" });
    const back = decodeAseprite(await readFile(resaved));
    assert.equal(frameGrid(back, back.frames[1]), frameGrid(e.doc, e.doc.frames[1]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
