# Format Mapping

## PowerPoint

| PPTX source | IR | Figma |
| --- | --- | --- |
| Slide | `frame` | Frame |
| Text box | `text` | Text |
| Rectangle / ellipse / polygon | shape node | Native shape |
| Picture | `image` + asset | Rectangle with image fill |
| Group | `group` | Real Figma Group |
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

SVG keeps source groups, child order, editable text containers and styled `tspan` runs. Complex vector leaves remain native SVG fragments during parsing and are unwrapped after Figma converts them.

Native `.ai` files are supported when either:

1. The payload is SVG-compatible.
2. The file was saved with PDF compatibility.

PDF-compatible files use PDF Optional Content Groups to recover same-named Illustrator layers. Modern PDF.js provides one operator list per artboard; the plugin separates editable text, source images and vector drawing operators, then rebuilds each non-empty source layer as a real Figma Group in the original order.

Vector operators are converted locally into bounded SVG leaves with transforms, clipping, fills, strokes, opacity, blend modes and axial/radial gradients. Temporary SVG Frames and staging Frames are removed before the import completes. If a file exposes no usable layer hierarchy, the existing 2x visual fallback remains available and oversized output is split into aligned 4096px tiles.

Figma cannot create an empty Group. Named empty Illustrator layers are therefore omitted and recorded in the conversion report instead of being replaced with fake placeholder content.

## Text Strategy

Editable mode creates Figma text nodes and maps family, style, size, alignment, line height, and letter spacing when available.

If the exact font is unavailable, the renderer tries:

1. Requested family and style
2. Requested family Regular
3. Known compatible system substitutions
4. Inter Regular
5. Arial Regular
6. First available Figma font

Every substitution is returned to the UI.

## Unsupported Strategy

`rasterize` preserves appearance at the smallest practical scope. `skip` omits unsupported content and records a warning.

Parsers must not silently discard source objects.
