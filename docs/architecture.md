# Architecture

## Overview

Easy to Figma separates format parsing from Figma rendering through a versioned intermediate representation (IR).

```mermaid
flowchart TD
  UI[React plugin UI] --> Router{Format router}
  Router --> PPTX[PPTX parser]
  Router --> PSD[PSD parser]
  Router --> AI[AI / SVG parser]
  PPTX --> IR[Unified IR document]
  PSD --> IR
  AI --> IR
  IR --> Bridge[Figma message bridge]
  Bridge --> Renderer[Figma renderer]
  Renderer --> Nodes[Native Figma nodes]
  IR --> Report[Import report]
```

## Runtime Boundaries

### Plugin UI iframe

The UI receives source files and runs format parsers. Browser APIs are available here, including ZIP handling, XML parsing, canvas rendering, and PDF.js.

Large binary work stays outside the Figma main-thread sandbox. The resulting serializable IR document is sent through `postMessage`.

### Figma main thread

The main thread owns document mutation:

- Loads available fonts
- Creates frames, text, geometry, vectors, and image fills
- Restores hierarchy and common visual properties
- Selects and reveals imported pages
- Returns missing-font and node-count results to the UI

## Package Boundaries

| Package | Responsibility |
| --- | --- |
| `ir-schema` | Shared node, asset, paint, effect, and report contracts |
| `parser-pptx` | Open XML package parsing and slide conversion |
| `parser-psd` | PSD layer-tree parsing and per-layer fallback |
| `parser-ai` | Editable SVG conversion and PDF-compatible AI hierarchy reconstruction |
| `figma-renderer` | IR-to-Figma node creation |
| `figma-plugin` | User interface and UI/main-thread messaging |

Parsers do not call the Figma API. The renderer does not understand source-format XML or PSD structures.

## Import Sequence

```mermaid
sequenceDiagram
  participant U as User
  participant UI as Plugin UI
  participant P as Parser
  participant M as Figma main
  participant C as Canvas

  U->>UI: Drop source file
  UI->>P: ArrayBuffer + options
  P-->>UI: IR document + report
  UI->>M: import-document
  M->>M: Resolve fonts and assets
  M->>C: Create native nodes
  M-->>UI: Result + missing fonts
  UI-->>U: Completion summary
```

## Asset Transport

Embedded source images are represented as `Uint8Array` assets. The plugin bridge transports those bytes directly, and the renderer converts them into Figma image hashes without base64 expansion.

## Failure Model

- Invalid container or XML: stop parsing and show a user-facing error.
- Unsupported local object: rasterize or skip according to import settings.
- Missing image relationship: skip the object and add a report warning.
- Missing font: use an available fallback and return the original family/style in the result.
- Renderer failure: remove every root node created by the current import, preserve the parser report, and surface the source-node path with the Figma API error.

## Security and Privacy

- No source content is uploaded.
- The plugin manifest allows no network domains.
- File handling occurs in memory.
- PDF.js is kept on a patched release and initialized with a bundled worker.
- PDF drawing operators are converted by a bounded local SVG backend; no legacy PDF parser or script evaluator is shipped.
- CI runs tests, type checks, production builds, and dependency review.
