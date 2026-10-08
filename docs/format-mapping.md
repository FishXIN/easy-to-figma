# Format Mapping

## PowerPoint

| PPTX source | IR | Figma |
| --- | --- | --- |
| Slide | `frame` | Frame |
| Text box | `text` | Text |
| Rectangle / ellipse / polygon | shape node | Native shape |
| Picture | `image` + asset | Rectangle with image fill |
| Group | `group` | Non-clipping frame |
| Simple table | grouped cells and text | Shapes and text |

Coordinates are converted from English Metric Units at `9525 EMU = 1 px`. Direct RGB and basic theme colors are resolved during parsing.

Not imported in V0.1:

- Animations and transitions
- SmartArt semantics
- Editable chart datasets
- Notes and comments
- Full master-layout inheritance

## Photoshop

| PSD source | IR | Figma |
| --- | --- | --- |
| Layer group | `group` | Non-clipping frame |
| Text layer | `text` | Text |
| Pixel layer | `image` + asset | Rectangle with image fill |
| Visibility / opacity | common fields | Native properties |
| Blend mode | common field | Supported Figma blend mode |

Pixel layers are rasterized independently. This preserves the original hierarchy and avoids flattening the entire document because one layer is not editable.

Complex masks, Smart Objects, adjustment layers, filters, and layer styles are treated as fallback content until they have deterministic native mappings.

## Illustrator and SVG

| Source | IR | Figma |
| --- | --- | --- |
| Artboard | `frame` | Frame |
| Group | `group` | Non-clipping frame |
| Rect / ellipse | shape node | Native shape |
| Path | `vector` | Vector |
| Text | `text` | Text |
| Embedded image | `image` + asset | Rectangle with image fill |

SVG is the editable compatibility path. Basic translate transforms, fills, strokes, opacity, and visibility are retained.

Native `.ai` files are supported when either:

1. The payload is SVG-compatible.
2. The file was saved with PDF compatibility.

PDF-compatible files are rendered per artboard at 2x and listed as fallback content. Files are read through Blob URLs instead of being copied into one large buffer. Raster output larger than 4096px is split into lossless, aligned tiles so Figma can retain the original artboard dimensions without exceeding image limits.

The plugin reports loading, rendering, and PNG encoding progress for each artboard. This is intentional: reconstructing arbitrary PDF drawing operators into clean editable layers without the Illustrator object model would create unreliable output.

## Text Strategy

Editable mode creates Figma text nodes and maps family, style, size, alignment, line height, and letter spacing when available.

If the exact font is unavailable, the renderer tries:

1. Requested family and style
2. Requested family Regular
3. Inter Regular
4. Arial Regular
5. First available Figma font

Every substitution is returned to the UI.

## Unsupported Strategy

`rasterize` preserves appearance at the smallest practical scope. `skip` omits unsupported content and records a warning.

Parsers must not silently discard source objects.
