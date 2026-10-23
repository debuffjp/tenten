import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor, TentenError, frameGrid } from "../src/index.ts";

const pal = ["#000000", "#ff0000", "#00ff00"];
const fresh = () => { const e = Editor.create("t", 6, 4); e.batch([{ op: "palette", colours: pal }]); return e; };
const grid = (e: Editor, frame = 0) => frameGrid(e.doc, e.doc.frames[frame]);

test("grid in, grid out", () => {
  const e = fresh();
  e.batch([{ op: "grid", rows: ["..00..", ".0110.", "0.11.0"] }]);
  assert.equal(grid(e), "..00..\n.0110.\n0.11.0\n......");
});

test("primitives", () => {
  const e = fresh();
  e.batch([{ op: "rect", x: 0, y: 0, w: 6, h: 4, c: 1 }, { op: "line", x0: 1, y0: 1, x1: 4, y1: 1, c: 2 }, { op: "pixel", x: 2, y: 2, c: 3 }]);
  assert.equal(grid(e), "000000\n011110\n0.2..0\n000000");
  e.batch([{ op: "flood", x: 3, y: 2, c: 3 }]);
  assert.equal(grid(e), "000000\n011110\n0.2220\n000000");
});

test("ellipse outline and fill", () => {
  const e = Editor.create("t", 7, 5);
  e.batch([{ op: "colour", hex: "#ffffff" }, { op: "ellipse", x: 0, y: 0, w: 7, h: 5, c: 1 }]);
  assert.equal(grid(e), "..000..\n.0...0.\n0.....0\n.0...0.\n..000..");
  e.batch([{ op: "ellipse", x: 0, y: 0, w: 7, h: 5, c: 1, fill: true }]);
  assert.equal(grid(e), "..000..\n.00000.\n0000000\n.00000.\n..000..");
});

test("diamond is a 2:1 isometric footprint", () => {
  const e = Editor.create("t", 8, 4);
  e.batch([{ op: "colour", hex: "#ffffff" }, { op: "diamond", x: 0, y: 0, w: 8, c: 1 }]);
  assert.equal(grid(e), "...00...\n.00..00.\n.00..00.\n...00...");
  e.batch([{ op: "diamond", x: 0, y: 0, w: 8, c: 1, fill: true }]);
  assert.equal(grid(e), "...00...\n.000000.\n.000000.\n...00...");
  assert.throws(() => e.batch([{ op: "diamond", x: 0, y: 0, w: 6, c: 1 }]), (err: unknown) => err instanceof TentenError && err.code === "BAD_DIAMOND");
});

test("outline, flip, shift, replace", () => {
  const e = fresh();
  e.batch([{ op: "pixel", x: 2, y: 1, c: 2 }, { op: "outline", c: 1 }]);
  assert.equal(grid(e), "..0...\n.010..\n..0...\n......");
  e.batch([{ op: "flip", axis: "x" }]);
  assert.equal(grid(e), "...0..\n..010.\n...0..\n......");
  e.batch([{ op: "shift", dx: 0, dy: 1 }, { op: "replace", from: 2, to: 3 }]);
  assert.equal(grid(e), "......\n...0..\n..020.\n...0..");
});

test("frames, copy, tags, undo and redo", () => {
  const e = fresh();
  e.batch([{ op: "pixel", x: 0, y: 0, c: 1 }, { op: "addFrame" }, { op: "pixel", x: 1, y: 0, c: 2, frame: 1 }]);
  assert.equal(grid(e, 1), "01....\n......\n......\n......");
  assert.equal(grid(e, 0), "0.....\n......\n......\n......");
  e.batch([{ op: "addFrame", copy: false }, { op: "copy", fromFrame: 1, frame: 2 }, { op: "tag", name: "walk", from: 0, to: 2 }, { op: "duration", ms: 80 }]);
  assert.equal(grid(e, 2), grid(e, 1));
  assert.deepEqual(e.doc.tags, [{ name: "walk", from: 0, to: 2, direction: "forward" }]);
  assert.equal(e.doc.frames.every((f) => f.durationMs === 80), true);
  assert.equal(e.undo(), 1);
  assert.equal(e.doc.frames.length, 2);
  assert.equal(e.redo(), 1);
  assert.equal(e.doc.frames.length, 3);
});

test("a failed batch leaves the document untouched", () => {
  const e = fresh();
  assert.throws(() => e.batch([{ op: "pixel", x: 0, y: 0, c: 1 }, { op: "pixel", x: 0, y: 0, c: 9 }]), (err: unknown) => err instanceof TentenError && err.code === "NO_COLOUR");
  assert.equal(grid(e), "......\n......\n......\n......");
  assert.equal(e.past.length, 1);
});

test("layers composite top over bottom", () => {
  const e = fresh();
  e.batch([{ op: "rect", x: 0, y: 0, w: 6, h: 4, c: 1, fill: true, layer: "base" }, { op: "addLayer", name: "face" }, { op: "pixel", x: 1, y: 1, c: 2, layer: "face" }]);
  assert.equal(grid(e), "000000\n010000\n000000\n000000");
  e.doc.layers[1].visible = false;
  assert.equal(grid(e), "000000\n000000\n000000\n000000");
});
