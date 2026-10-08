# Contributing

Thanks for helping improve Easy to Figma.

## Before You Start

- Search existing issues and pull requests.
- Use a minimal, anonymized fixture when reporting format compatibility.
- Do not commit proprietary source files without explicit redistribution rights.
- Keep parser behavior deterministic and record every fallback.

## Development

```bash
npm install
npm run check
```

Load `apps/figma-plugin/manifest.json` as a development plugin in Figma Desktop.

## Changes

1. Create a focused branch from `main`.
2. Add or update tests for parser and schema behavior.
3. Run `npm run check`.
4. Update user-facing documentation when support or fallback behavior changes.
5. Open a pull request using the repository template.

## Parser Requirements

- Emit only nodes defined by `@easy-to-figma/ir-schema`.
- Resolve source coordinates into parent-relative Figma pixels.
- Preserve source names and child order where possible.
- Prefer native editable nodes.
- Apply fallback to the smallest stable object.
- Add a report item for rasterized or skipped content.
- Avoid source-format logic in the Figma renderer.

## Commit Style

Use concise imperative subjects. Conventional Commit prefixes are encouraged:

```text
feat(pptx): preserve rounded rectangle radius
fix(renderer): load fallback font before setting text
docs: clarify PDF-compatible AI behavior
```

## Pull Request Quality

A pull request should:

- Explain the user-visible behavior
- Describe tested source cases
- Include screenshots for UI changes
- Avoid unrelated formatting or refactoring
- Pass CI

## Bug Reports

Include:

- Easy to Figma version or commit
- Figma Desktop version and operating system
- Source format and producing application version
- Expected and actual output
- Import report details
- A sanitized fixture when legally shareable

For security issues, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.
