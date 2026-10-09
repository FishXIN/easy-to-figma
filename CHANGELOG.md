# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-10-09

### Added / 新增

- Added pure-plugin PDF-compatible AI reconstruction for artboards, same-named Illustrator PDF layers, editable text runs, vectors, gradients, blend modes, and separate source-image layers / 新增纯插件 PDF-compatible AI 重建能力，支持画板、同名 Illustrator PDF 图层、可编辑文字样式段、矢量、渐变、混合模式和独立源图像层
- Added multi-file and ZIP bundle imports without uploading source files / 新增多文件与 ZIP 批量导入，源文件仍完全本地处理
- Added atomic renderer rollback so a failed import never leaves partial Frames or staging nodes / 新增渲染事务回滚，导入失败时不会遗留残缺 Frame 或临时节点

### Changed / 变更

- Figma Groups are now real `GroupNode` objects with source order and names; temporary SVG and staging Frames are removed before completion / Figma 分组改为真实 `GroupNode`，保留源顺序与命名，并在完成前移除 SVG 与 staging 临时 Frame
- Complex SVG imports now preserve nested groups and rebuild source text containers as editable text with styled `tspan` runs / 复杂 SVG 现在保留嵌套分组，并将源文字容器重建为带样式段的可编辑文字
- Replaced the legacy PDF.js SVG runtime with a local, bounded vector converter while keeping the patched PDF.js parser / 移除旧版 PDF.js SVG 运行时，改用本地受控矢量转换器，同时继续使用已修复的 PDF.js 解析器

### Fixed / 修复

- Adapted PDF.js 6 interleaved path operators, including exact quadratic-to-cubic conversion and paint-op splitting / 适配 PDF.js 6 交错路径指令，包括精确二次转三次贝塞尔和绘制操作拆分
- Prevented duplicate SVG namespaces that caused `figma.createNodeFromSvg` failures / 修复重复 SVG 命名空间导致的 `figma.createNodeFromSvg` 失败
- Preserved editable PDF text, layer blend modes, rich text runs, and meaningful vector layer names / 保留 PDF 可编辑文字、图层混合模式、富文本样式段和可识别的矢量层命名

### Verified / 验证

- Imported `傩灵启示录_Display_Poster.ai` directly in Figma as 5 Frames and 2,601 native layers / 已在 Figma 中将 `傩灵启示录_Display_Poster.ai` 直导为 5 个 Frame 和 2,601 个原生层
- Imported `傩灵启示录_Display_BG.ai` directly in Figma as 6 Frames and 26,068 native layers / 已在 Figma 中将 `傩灵启示录_Display_BG.ai` 直导为 6 个 Frame 和 26,068 个原生层
- Confirmed source-named Groups, editable text/vector/image content, original artboard ordering, zero rasterized fallback layers in both parser reports, and no temporary wrapper Frames / 已确认源命名 Group、可编辑文字/矢量/图像、原画板顺序、两份解析报告均为零栅格回退，且无临时包装 Frame
- Production dependency audit reports zero known vulnerabilities / 生产依赖审计为零已知漏洞

### Known limitations / 已知限制

- Figma cannot represent an empty Group; named empty Illustrator layers are omitted and listed in the conversion report / Figma 无法表示空 Group，具名空 Illustrator 图层会被省略并写入转换报告
- Missing source fonts are substituted with available Figma fonts and reported / 缺失源字体会替换为可用 Figma 字体并明确报告
- Illustrator private-only object semantics and advanced soft masks without an equivalent PDF/Figma representation cannot be guaranteed at 100% parity / 仅存在于 Illustrator 私有数据中的对象语义，以及无等价 PDF/Figma 表达的高级软蒙版，无法保证 100% 等价

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

[Unreleased]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/FishXIN/easy-to-figma/releases/tag/v0.1.0
