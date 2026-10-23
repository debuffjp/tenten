// A document plus its undo stack. A batch of ops is one undo step.
import { type Doc, type Rgba, cloneDoc, newDoc } from "./doc.ts";
import { type Op, apply } from "./ops.ts";

const MAX_UNDO = 200;

export class Editor {
  past: Doc[] = [];
  future: Doc[] = [];
  log: Op[][] = [];
  doc: Doc;
  path?: string;
  constructor(doc: Doc, path?: string) { this.doc = doc; this.path = path; }

  static create(name: string, width: number, height: number, palette: Rgba[] = []) { return new Editor(newDoc(name, width, height, palette)); }

  batch(ops: Op[]) {
    const before = cloneDoc(this.doc);
    try { for (const o of ops) apply(this.doc, o); }
    catch (e) { this.doc = before; throw e; }
    this.past.push(before);
    if (this.past.length > MAX_UNDO) this.past.shift();
    this.future = [];
    this.log.push(ops);
  }

  undo(steps = 1) {
    let n = 0;
    while (n < steps && this.past.length) { this.future.push(this.doc); this.doc = this.past.pop()!; n++; }
    return n;
  }

  redo(steps = 1) {
    let n = 0;
    while (n < steps && this.future.length) { this.past.push(this.doc); this.doc = this.future.pop()!; n++; }
    return n;
  }
}
