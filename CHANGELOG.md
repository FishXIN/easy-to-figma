# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-08

### Added

- Determinate progress for PDF-compatible Illustrator rendering
- Memory-safe 4096px tiling for oversized 2x artboards
- Blob-backed loading for Illustrator files up to 1.5 GB
- Stable source and page metadata on imported Figma frames

### Changed

- Binary image assets now cross the plugin bridge as `Uint8Array` instead of base64
- New imports are placed below existing canvas content instead of overlapping it
- PPTX and PSD limits increased to 500 MB

## [0.1.0] - 2026-10-08

### Added

- Figma plugin UI with drag-and-drop import, settings, progress, and conversion reports
- Versioned unified intermediate representation
- PPTX parsing for slides, editable text, basic shapes, pictures, and simple tables
- PSD parsing for groups, editable text, visibility, opacity, blend modes, and per-layer image fallback
- Editable SVG and SVG-compatible Illustrator import
- PDF-compatible Illustrator artboard fallback through bundled PDF.js
- Figma renderer for frames, groups, text, geometry, vectors, and image fills
- Font resolution and substitution reporting
- Unit tests, type checking, production build, and dependency security checks
- Bilingual project documentation and community health files

[Unreleased]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/FishXIN/easy-to-figma/releases/tag/v0.1.0
