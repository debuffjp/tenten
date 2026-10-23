import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "fast-png";
import { Editor, asepriteJson, deserialize, framePng, frameGrid, serialize, sheet } from "../src/index.ts";

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
