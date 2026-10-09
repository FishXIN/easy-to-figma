# Easy to Figma

English | [简体中文](./README.md)

[![CI](https://github.com/FishXIN/easy-to-figma/actions/workflows/ci.yml/badge.svg)](https://github.com/FishXIN/easy-to-figma/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-202328.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6.svg)](https://www.typescriptlang.org/)
[![Figma Plugin](https://img.shields.io/badge/Figma-plugin-f24e1e.svg)](https://www.figma.com/plugin-docs/)

**Bring PSD, Illustrator, and PowerPoint files into Figma while preserving as much editability as possible.**

Easy to Figma is a free, open-source, cross-platform Figma import tool. Source files are converted into a unified intermediate representation, rebuilt with native Figma nodes, and accompanied by a clear report whenever unsupported content needs a controlled fallback.

![Easy to Figma plugin interface](./docs/images/plugin-ui.png)

## Format Support

| Format | Editable output | Controlled fallback |
| --- | --- | --- |
| PPTX | Slides, text, basic shapes, images, simple tables, groups | Advanced charts, SmartArt, animation |
| PSD | Layer groups, text, visibility, opacity, blend modes, pixel/vector masks, compatible image adjustments | Pixel layers and complex effects without a Figma equivalent |
| AI / SVG | Artboards, same-named groups, paths, text, gradients, blend modes, embedded images | Empty source groups and private effects without an equivalent are reported |

> PDF-compatible AI files are read directly for artboards and Illustrator PDF layers. The plugin rebuilds same-named real Figma Groups, editable text and vectors, and separate image layers. Image blend modes and uniform opacity are restored as native Figma properties, while complex soft masks and blur stay inside the corresponding independent visual layer. Figma cannot create empty Group nodes, so named empty source layers are omitted and reported. Private AI files without PDF-compatible data must still be saved as SVG.

Before import, every text layer and rich-text run is checked by exact font family and style. Missing fonts are listed individually and require an explicit replacement instead of being substituted silently.

File limits are 500 MB for PPTX / PSD and 1.5 GB for AI / SVG / PDF-compatible AI. Multiple files and ZIP bundles can be imported together. When no usable PDF layer hierarchy exists, visual fallback remains losslessly tiled at 4096px without scaling or exceeding Figma image limits.

## Principles

- **Editability first**: native Figma nodes are preferred over flattened output.
- **Structure first**: page, group, name, and hierarchy information is retained where possible.
- **Fallback without failure**: unsupported content is rasterized or skipped and listed in the report.
- **Local processing**: source files stay on the device.
- **Cross-platform**: the TypeScript implementation works on macOS and Windows.

## Quick Start

Node.js 20 or newer is required.

```bash
git clone https://github.com/FishXIN/easy-to-figma.git
cd easy-to-figma
npm install
npm run check
```

In Figma Desktop:

1. Open `Plugins` → `Development` → `Import plugin from manifest...`
2. Select `apps/figma-plugin/manifest.json`
3. Run `Easy to Figma`
4. Drop a `.pptx`, `.psd`, `.ai`, `.svg`, or PDF-compatible AI file

Build the plugin:

```bash
npm run build
```

The production output is written to `apps/figma-plugin/dist/`.

## Architecture

```mermaid
flowchart LR
  A[PSD / AI / PPTX] --> B[Format parser]
  B --> C[Unified IR]
  C --> D[Figma renderer]
  D --> E[Editable Figma nodes]
  B --> F[Import report]
  D --> F
```

Read the [architecture](./docs/architecture.md), [IR schema](./docs/ir-schema.md), and [format mapping](./docs/format-mapping.md) documents for implementation details.

## Project Status

Version `v0.1.4` adds exact pre-import font checks and explicit replacements, native blend mode and opacity restoration for AI image layers, and PSD pixel masks, vector masks, and Figma's seven native image adjustment fields. The existing 11-artboard Illustrator regression suite still covers source files up to 909 MB, and a real 58.77 MB PSD now covers adjustment-layer import. Hue, per-channel curves, LUTs, and other settings without a Figma equivalent remain explicit report items.

## Contributing

Parser improvements, format fixtures, compatibility fixes, and documentation updates are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md) before opening a pull request.

Do not report security vulnerabilities in a public issue. Follow [SECURITY.md](./SECURITY.md) instead.

## License

[MIT](./LICENSE) © 2026 FishXIN
