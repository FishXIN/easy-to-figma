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
| Pixel mask | luminance-mask image node | Native Figma mask |
| Vector mask | locally rendered luminance-mask asset | Native Figma mask |
| Mask density / feather | opacity + layer blur | Native mask opacity and blur |
| Brightness / contrast | image filters | Exposure + contrast |
| Exposure | image filters | Exposure + shadow/highlight approximation |
| Vibrance / saturation | image filters | Saturation |
| RGB levels / curves | image filters | Shadows, highlights, exposure, contrast |
| Color balance / photo filter | image filters | Temperature + tint |
| Black & white | image filters | Saturation `-1` |

Pixel layers are rasterized independently. This preserves the original hierarchy and avoids flattening the entire document because one layer is not editable. Adjustment layers without masks propagate compatible filters to image layers below. Masked adjustment layers become a native Figma luminance-mask group containing filtered image overlays, so the unadjusted image remains visible outside the mask.

Figma exposes seven image-filter fields: exposure, contrast, saturation, temperature, tint, highlights, and shadows. Photoshop hue rotation, per-color/per-channel corrections, 3D LUTs, gradient maps, threshold, posterize, and other parameters without an equivalent field are retained as explicit conversion-report items instead of being silently discarded.

Smart Object internals and layer styles without deterministic native mappings remain controlled fallback content.

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

Vector operators are converted locally into bounded SVG leaves with transforms, clipping, fills, strokes, opacity, blend modes and axial/radial gradients. Image segments restore PDF blend mode and uniform alpha as native Figma layer properties. Uniform alpha is removed from the PNG before applying node opacity, preventing double transparency. Complex soft masks and blur remain baked into the smallest independent visual layer. Temporary SVG Frames and staging Frames are removed before the import completes. If a file exposes no usable layer hierarchy, the existing 2x visual fallback remains available and oversized output is split into aligned 4096px tiles.

Figma cannot create an empty Group. Named empty Illustrator layers are therefore omitted and recorded in the conversion report instead of being replaced with fake placeholder content.

## Text Strategy

Editable mode creates Figma text nodes and maps family, style, size, alignment, line height, and letter spacing when available.

Before import, the UI sends the deduplicated family/style pairs from base text and rich-text runs to the Figma main thread. Exact installed matches are used unchanged. Every missing pair is listed in a replacement panel with an available-font selector; import remains disabled until each missing pair has a replacement. The final source-to-replacement mappings are returned in the import result.

## Unsupported Strategy

`rasterize` preserves appearance at the smallest practical scope. `skip` omits unsupported content and records a warning.

Parsers must not silently discard source objects.
