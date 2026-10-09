# Intermediate Representation

The IR is the stable contract between source parsers and the Figma renderer. It is defined in [`packages/ir-schema`](../packages/ir-schema/src/index.ts).

## Document

```ts
interface IRDocument {
  version: "0.1.0";
  source: {
    name: string;
    format: "pptx" | "psd" | "ai" | "svg" | "pdf";
    byteSize: number;
  };
  pages: ContainerNode[];
  assets: Asset[];
  report: ImportReport;
}
```

Every parser returns one or more page-level frames. Assets are stored once and referenced by id.

## Node Types

| IR type | Typical Figma output |
| --- | --- |
| `frame` | `FrameNode` |
| `group` | Non-clipping `FrameNode` |
| `text` | `TextNode` |
| `rectangle` | `RectangleNode` |
| `ellipse` | `EllipseNode` |
| `polygon` | `PolygonNode` |
| `vector` | `VectorNode` |
| `image` | `RectangleNode` with image fill |
| `line` | `LineNode` |
| `booleanGroup` | Non-clipping frame in V0.1 |

Common fields carry identity, bounds, rotation, opacity, visibility, blend mode, paints, strokes, effects, and optional Figma mask semantics. Container nodes add ordered children.

Image nodes and image paints may carry native Figma image filters:

```ts
interface ImageFilterValues {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
}
```

Every value is normalized to `-1...1`. Mask nodes use `isMask` plus `maskType` (`alpha`, `vector`, or `luminance`).

## Coordinate Rules

- Units are Figma pixels.
- Child `x` and `y` are relative to the parent.
- Page coordinates are assigned by the renderer at import time.
- Rotation is expressed in degrees.
- Colors use normalized `0...1` channels.
- Opacity uses `0...1`.

Parsers are responsible for resolving source transforms into these rules before returning a document.

## Assets

```ts
interface Asset {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  width?: number;
  height?: number;
}
```

`data` is a data URL in V0.1. Image nodes and image paints reference `assetRef`.

## Report

Reports are part of the conversion result, not logging:

- `editableNodes`
- `rasterizedNodes`
- `skippedNodes`
- `missingFonts`
- detailed `info`, `warning`, `fallback`, and `error` items

Each fallback should identify its source object where possible. Parser authors should prefer specific report codes that remain stable across wording changes.

## Versioning

The IR version changes when a renderer cannot safely consume a document emitted by an older parser without adaptation. New optional fields do not require a major schema change.
