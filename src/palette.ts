import type { Rgba } from "./doc.ts";
import { TentenError } from "./doc.ts";

export function hexToRgba(hex: string): Rgba {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) throw new TentenError("BAD_COLOUR", `not a hex colour: ${hex}`, "use #rrggbb or #rrggbbaa");
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255];
}

export function rgbaToHex([r, g, b, a]: Rgba) {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${a === 255 ? "" : h(a)}`;
}

// Named palettes pixel artists reach for. Index 0 is always transparent and is added by the document.
export const PALETTES: Record<string, string[]> = {
  pico8: ["#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8", "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa"],
  endesga16: ["#e4a672", "#b86f50", "#743f39", "#3f2832", "#9e2835", "#e53b44", "#fb922b", "#ffe762", "#63c64d", "#327345", "#193d3f", "#4f6781", "#afbfd2", "#ffffff", "#2ce8f4", "#0484d1"],
  squish: ["#11140d", "#1c2117", "#6b7560", "#d3dcc2", "#cffb2d", "#5ee6ff", "#ff5d73", "#ff9f43", "#b06cff", "#7dffb3"],
};

// Shade a base colour towards black or white; `steps` entries, the base in the middle. Simple ramps that look right at pixel scale.
export function ramp(base: Rgba, steps: number): Rgba[] {
  const out: Rgba[] = [];
  const half = Math.floor(steps / 2);
  for (let i = 0; i < steps; i++) {
    const t = (i - half) / (half + 1);
    const target = t < 0 ? [12, 8, 20] : [255, 250, 230];
    const k = Math.abs(t);
    out.push([Math.round(base[0] + (target[0] - base[0]) * k), Math.round(base[1] + (target[1] - base[1]) * k), Math.round(base[2] + (target[2] - base[2]) * k), 255]);
  }
  return out;
}
