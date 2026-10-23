import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "fast-png";
import { Editor, asepriteJson, deserialize, diffPixels, flatten, framePng, frameGrid, previewPng, serialize, sheet } from "../src/index.ts";

const make = () => {
  const e = Editor.create("dot", 4, 3);
  e.batch([{ op: "palette", colours: ["#ff0000", "#00ff00"] }, { op: "grid", rows: ["0..1", ".00.", "1..0"] }, { op: "addFrame" }, { op: "flip", axis: "x", frame: 1 }, { op: "tag", name: "spin", from: 0, to: 1 }, { op: "slice", name: "hit", x: 1, y: 1, w: 2, h: 1, kind: "hitbox", pivot: [2, 1] }]);
  return e;
};

test("frame png has the palette colours and transparency", () => {
  const e = make();
  const img = decode(framePng(e.doc, e.doc.frames[0]));
  assert.equal(img.width, 4);
  assert.deepEqual([...img.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...img.data.subarray(4, 8)], [0, 0, 0, 0]);
  assert.deepEqual([...img.data.subarray(12, 16)], [0, 255, 0, 255]);
});

test("horizontal sheet places frame 1 after frame 0 and the json describes it", () => {
  const e = make();
  const s = sheet(e.doc, "horizontal");
  assert.equal(s.width, 8);
  const img = decode(s.png);
  assert.deepEqual([...img.data.subarray(4 * 4, 4 * 4 + 4)], [0, 255, 0, 255]);
  const j = asepriteJson(e.doc, s, "dot.png") as { frames: Record<string, { frame: { x: number } }>; meta: { frameTags: unknown[]; slices: { keys: { pivot?: unknown }[] }[] } };
  assert.equal(j.frames["dot 1.ase"].frame.x, 4);
  assert.deepEqual(j.meta.frameTags, [{ name: "spin", from: 0, to: 1, direction: "forward" }]);
  assert.deepEqual(j.meta.slices[0].keys[0].pivot, { x: 2, y: 1 });
});

test("grid sheet is square-ish", () => {
  const e = make();
  e.batch([{ op: "addFrame" }, { op: "addFrame" }, { op: "addFrame" }]);
  const s = sheet(e.doc, "grid", 2, 1);
  assert.equal(s.columns, 3);
  assert.equal(s.width, 3 * 8 + 2);
  assert.equal(s.height, 2 * 6 + 1);
});

test(".tt round-trips and reads as text grids", () => {
  const e = make();
  const text = serialize(e.doc);
  assert.match(text, /"rows": \["0\.\.1", "\.00\.", "1\.\.0"\]/);
  const back = deserialize(text);
  assert.equal(frameGrid(back, back.frames[1]), frameGrid(e.doc, e.doc.frames[1]));
  assert.deepEqual(back.palette, e.doc.palette);
  assert.deepEqual(back.tags, e.doc.tags);
  assert.deepEqual(back.slices, e.doc.slices);
  assert.equal(serialize(back), text);
});

test("preview png labels each frame with its index under the sheet", () => {
  const e = make();
  const img = decode(previewPng(e.doc, 8));
  assert.equal(img.width, 2 * 4 * 8 + 8);
  assert.equal(img.height, 3 * 8 + 7 * 2, "sheet plus a 5-row digit at zoom 2 with a gap above and below");
  const at = (x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
  assert.deepEqual(at(0, 24 + 2), [128, 128, 128, 255], "top-left of the 0 glyph under frame 0");
  assert.deepEqual(at(2, 24 + 4), [0, 0, 0, 0], "the 0 glyph is hollow");
  assert.deepEqual(at(40 + 2, 24 + 2), [128, 128, 128, 255], "the 1 glyph under frame 1");
  assert.deepEqual(at(40, 24 + 2), [0, 0, 0, 0]);
});

test("diffPixels lists changed cells and marks them in a grid", () => {
  const e = make();
  const before = flatten(e.doc, e.doc.frames[0]);
  e.batch([{ op: "pixel", x: 1, y: 0, c: 2 }, { op: "pixel", x: 0, y: 0, c: 0 }]);
  const d = diffPixels(before, flatten(e.doc, e.doc.frames[0]), 4, 3);
  assert.equal(d.changed, 2);
  assert.deepEqual(d.cells, [{ x: 0, y: 0, from: 1, to: 0 }, { x: 1, y: 0, from: 0, to: 2 }]);
  assert.equal(d.grid, ".1--\n----\n----");
  assert.equal(diffPixels(before, before, 4, 3, 1).cells.length, 0);
});
