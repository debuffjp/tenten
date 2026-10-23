# The .tt format

A `.tt` file is one JSON document. Pixels are stored as rows of text, so the file reads in a terminal, diffs line by line in git, and can be written by hand or by a script without tenten. This page is the whole format; `src/format.ts` is the reference implementation.

## Example

```json
{
 "format": "tenten/1",
 "name": "slime",
 "size": [8, 6],
 "palette": ["#2d6a4f", "#52b788", "#b7e4c7", "#081c15"],
 "layers": [{ "name": "base" }],
 "frames": [100, 100],
 "tags": [{ "name": "idle", "from": 0, "to": 1, "direction": "forward" }],
 "slices": [],
 "cels": [
  { "layer": "base", "frame": 0, "rows": [".300003.", "30111103", "01122110", "01111110", "30111103", ".333333."] },
  { "layer": "base", "frame": 1, "rows": ["........", ".300003.", "30111103", "01122110", "01111110", "30111103"] }
 ]
}
```

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | string | Always `tenten/1`. A reader rejects any other value. |
| `name` | string | The sprite's name; exports use it for file names and frame keys. |
| `size` | `[width, height]` | Pixels. Every cel is this size. |
| `palette` | string[] | Hex colours `#rrggbb` or `#rrggbbaa` for indices 1 onward. Index 0 is always transparent and is not listed. At most 255 entries. |
| `layers` | object[] | In draw order, bottom first. `name` is required and unique. `visible: false` and `opacity: 0-255` are written only when they differ from the defaults (visible, 255). |
| `frames` | number[] | One duration in milliseconds per frame, in order. Frames are addressed by index everywhere else. |
| `tags` | object[] | `name`, `from`, `to` (frame indices, inclusive), `direction`: `forward`, `reverse` or `pingpong`. |
| `slices` | object[] | `name`, `x`, `y`, `w`, `h` in pixels, optional `pivot: [x, y]`, and `kind`: `slice` or `hitbox`. |
| `cels` | object[] | One per layer and frame that has any pixels. `layer` is a layer name, `frame` a frame index. Pixels are in `rows` or `base64`. |

## Pixels

`rows` is an array of `height` strings of `width` characters, one character per pixel, top row first. `.` is transparent (index 0). Indices 1 to 61 are `0-9`, then `a-z`, then `A-Z`, in that order, so index 1 is `0`, index 11 is `a` and index 37 is `A`. A space also reads as transparent, so grids can be hand-written with spaces for alignment.

When a palette has more than 61 colours the grid alphabet runs out, and a writer stores the cel as `base64` instead: the `width * height` palette indices as bytes, row by row, encoded in base64. A reader accepts either form on any cel.

A cel whose pixels are all transparent is not written. A layer and frame with no cel is transparent.

## Rendering

To draw a frame, start from a transparent canvas and, for each layer in order that is visible, copy every non-zero pixel of its cel for that frame. Layer `opacity` is stored for round trips with `.aseprite` and is not applied by tenten's own renderer today.

## Differences from .aseprite

`.tt` stores only what tenten edits: no colour profiles, blend modes, tilemaps, user data or per-cel offsets, and all cels are full-canvas. Converting from `.aseprite` keeps pixels, palette, layers, frame durations, tags and slices, and maps any RGBA or grayscale colours onto a palette by exact value; more than 255 distinct colours is an error. Converting to `.aseprite` writes an indexed file that Aseprite 1.3 opens.
