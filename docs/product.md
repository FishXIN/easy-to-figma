# Product Scope

## Definition

Easy to Figma imports PSD, AI, and PPTX files into Figma while preserving editable content and source structure wherever the target model allows it.

The project is not a generic file-to-image converter. Its primary output is a Figma document made of native `Frame`, `Text`, shape, vector, group, and image-fill nodes.

## Users

- Designers moving historical Adobe assets into Figma
- Product and operations teams reusing PowerPoint pages
- Teams consolidating legacy design files into a collaborative workflow
- Developers extending import support through open-source parsers

## Product Rules

1. Prefer editable output over visual flattening.
2. Preserve hierarchy and names before reconstructing optional effects.
3. Apply fallback at the smallest stable scope.
4. Never fail an entire document because one effect is unsupported.
5. Explain every rasterized or skipped item in the import report.
6. Keep source files local to the plugin.

## V0.1 Scope

### PPTX

- Slide to frame
- Editable text boxes
- Editable basic shapes
- Image fills
- Simple table structure
- Source page dimensions

### AI and SVG

- SVG artboards and groups
- Paths and basic geometry
- Editable text
- Embedded images
- PDF-compatible AI visual fallback

### PSD

- Layer groups
- Editable text layers
- Pixel layers as independent image fills
- Visibility, opacity, names, and blend modes

## Explicit Non-goals

- Bidirectional synchronization
- Incremental source updates
- Full Smart Object reconstruction
- Photoshop adjustment-layer and filter equivalence
- PowerPoint animation or transition import
- SmartArt reconstruction
- Exact cross-engine text line breaking
- A promise of 100% visual or structural parity

## Success Criteria

- A supported source file reaches the Figma canvas without external services.
- Basic content remains editable after import.
- Unsupported content has a deterministic fallback.
- The report distinguishes editable, rasterized, skipped, and font-substituted content.
- The same build works in Figma Desktop on macOS and Windows.
