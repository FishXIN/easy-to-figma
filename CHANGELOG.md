# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] - 2026-10-11

### Fixed / 修复

- Preserved hidden Illustrator PDF layers as hidden editable Figma layers, including named empty layers / 将 Illustrator PDF 隐藏图层保留为 Figma 中默认隐藏的可编辑图层，包含具名空图层
- Removed duplicate visible empty OCG placeholders, grouped SVG implementation nodes under their source layer, and locked full-artboard visual background layers so canvas clicks reach editable foreground groups such as `Logo` / 移除重复的可见空 OCG 占位层，将 SVG 实现节点收纳到源图层下，并默认锁定整画板视觉背景层，使画布点击可直接命中 `Logo` 等前景可编辑组
- Merged wrapped PDF lines from the same paragraph into one editable text node while preserving line breaks, alignment, and line height / 将同一段落的 PDF 换行内容合并为一个可编辑文本框，并保留换行、对齐与行距
- Restored editable AI background gradients, outer image-group blend modes such as Multiply, and soft-mask Hard Light output without merging `BG_Color` and `BG_Mask` into one image / 恢复 AI 可编辑背景渐变、正片叠底等外层图像组混合模式，并以独立透明增量层还原柔光蒙版，未将 `BG_Color` 与 `BG_Mask` 合并为整图
- Automatically resolved installed fonts when the source PostScript family maps to a localized family name, or when the installed face uses a non-standard style label, while keeping the manual replacement panel for genuinely unavailable fonts / 当源 PostScript 字体族对应本地化家族名，或已安装字体使用非标准 style 名时自动匹配；真正缺失的字体仍保留手动替换面板
- Added verified aliases for `BiaoXiaoZhiLongZhuTi-J` / `标小智龙珠体 简` and `SXSGYS` / `苏新诗古印宋简` / 新增 `BiaoXiaoZhiLongZhuTi-J` / `标小智龙珠体 简` 与 `SXSGYS` / `苏新诗古印宋简` 的已验证别名映射

### Verified / 验证

- Re-imported the 909 MB `傩灵启示录_Display_BG.ai`: pages 1–2 retain their dark composited backgrounds, pages 3–6 remain transparent, hidden Reference layers stay hidden without duplicate placeholders, the multi-line link paragraph is one text layer, and clicking the emblem selects `Logo` / 重新导入 909 MB `傩灵启示录_Display_BG.ai`：第 1–2 页保持深色合成背景，第 3–6 页保持透明，隐藏 Reference 图层默认隐藏且无重复占位，多行链接段落为单一文本层，点击徽标可直接选中 `Logo`
- Added regressions for optional-content visibility, wrapped paragraphs, gradients, inherited group blend modes, soft masks, and installed font aliases / 新增可选内容可见性、换行段落、渐变、外层组混合模式、软蒙版与已安装字体别名的回归测试
- Full typecheck, unit-test suite, production build, and dependency audit pass with zero known vulnerabilities / 全量类型检查、单元测试、生产构建与依赖审计通过，已知漏洞为零

## [0.1.4] - 2026-10-09

### Added / 新增

- Added exact pre-import font analysis for base text and rich-text runs, with one required replacement selector per missing family/style pair / 新增导入前精确字体分析，覆盖基础文字与富文本样式段，并为每个缺失的字体族/样式提供必选替换项
- Added native Figma image adjustments for PSD exposure, contrast, saturation, temperature, tint, highlights, and shadows / 新增 PSD 到 Figma 原生图片调整参数的映射，覆盖曝光、对比度、饱和度、色温、色调、高光和阴影
- Added native Figma luminance-mask reconstruction for Photoshop pixel and vector masks, including density and feather / 新增 Photoshop 像素蒙版与矢量蒙版到 Figma 原生亮度蒙版的重建，包含密度和羽化
- Added masked PSD adjustment overlays so compatible filters apply only inside the source adjustment mask / 新增带蒙版 PSD 调整层的遮罩叠加结构，使兼容滤镜仅作用于源蒙版区域

### Changed / 变更

- PDF image-layer blend modes and uniform opacity are now native Figma properties; baked alpha is normalized first to prevent double transparency / PDF 图像层混合模式与统一透明度改为 Figma 原生属性，并先还原像素 Alpha 以避免双重透明
- Complex PDF soft masks and blur remain visually preserved in their independent image layers and are explicitly reported / 复杂 PDF 软蒙版和模糊保留在对应独立图像层内，并明确写入转换报告
- Font substitutions now use only the user's explicit pre-import choice and return detailed source-to-replacement mappings / 字体替换仅使用用户在导入前的明确选择，并返回完整的源字体到替代字体映射

### Verified / 验证

- Regressed the 243 MB Poster AI and 909 MB BG AI: 11 artboards, zero whole-layer raster fallback, and 27 independent soft-mask/blur effect layers preserved / 回归 243 MB Poster AI 与 909 MB BG AI：共 11 个画板、零整层栅格回退，并保留 27 个独立软蒙版/模糊效果层
- Regressed a real 58.77 MB Windows PSD with six adjustment layers; brightness/contrast, saturation, and color balance map to native image filters, while the one unsupported master-hue value is reported / 回归 Windows 端 58.77 MB 真实 PSD 的 6 个调整层；亮度/对比度、饱和度与色彩平衡均映射为原生图片调整，仅 1 个无等价项的主色相值被报告
- Verified a generated PSD fixture containing both a masked adjustment layer and a masked pixel layer / 验证同时包含带蒙版调整层与带蒙版像素层的 PSD 测试样本

### Known limitations / 已知限制

- Figma has no native equivalent for Photoshop hue rotation, per-color/per-channel corrections, LUTs, gradient maps, threshold, or posterize; these remain explicit report items / Figma 没有 Photoshop 色相旋转、分色/分通道校正、LUT、渐变映射、阈值或色调分离的原生等价项，这些内容会保留为明确报告项

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

[Unreleased]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/FishXIN/easy-to-figma/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/FishXIN/easy-to-figma/releases/tag/v0.1.0
