# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-08

### Fixed / 修复

- Fixed an unresolved Vite preload marker that broke PDF-compatible AI imports in the production Figma plugin / 修复生产版 Figma 插件中未解析的 Vite 预加载占位符，恢复 PDF-compatible AI 导入
- Added a build-time guard so invalid single-file plugin bundles fail before release / 新增构建期硬校验，阻止包含无效占位符的单文件插件进入发布

### Verified / 验证

- Imported and visually checked all 11 artboards from `傩灵启示录_Display_BG.ai` and `傩灵启示录_Display_Poster.ai` in Figma / 已在 Figma 中导入并逐一视觉检查两份文件的全部 11 个画板
- Confirmed source dimensions, lossless 2x tiling, invisible tile seams, stable ordering, and non-overlapping layout / 已确认源尺寸、2x 无损分片、无可见接缝、顺序稳定且画板不重叠

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

[Unreleased]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/FishXIN/easy-to-figma/releases/tag/v0.1.0
