import { describe, expect, it } from "vitest";
import { DEFAULT_PARSE_OPTIONS } from "@easy-to-figma/ir-schema";
import { calculateImageTiles, parseIllustrator } from "./index";

describe("parseIllustrator", () => {
  it("keeps basic SVG nodes editable", async () => {
    const source = `
      <svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
        <rect id="Background" x="0" y="0" width="320" height="180" fill="#ffffff"/>
        <path id="Mark" d="M 20 20 L 80 20 L 50 70 Z" fill="#0d67d8"/>
        <text id="Title" x="20" y="120" font-size="24" fill="#111111">Easy to Figma</text>
      </svg>
    `;

    const document = await parseIllustrator(
      new TextEncoder().encode(source),
      "sample.svg",
      DEFAULT_PARSE_OPTIONS,
    );

    expect(document.pages).toHaveLength(1);
    expect(document.pages[0]?.width).toBe(320);
    expect(document.pages[0]?.children.map((node) => node.type)).toEqual([
      "rectangle",
      "vector",
      "text",
    ]);
    expect(document.report.editableNodes).toBe(3);
    expect(document.report.rasterizedNodes).toBe(0);
  });

  it("reads SVG-compatible content from a Blob without preloading it in the caller", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>';
    const file = new Blob([source], { type: "image/svg+xml" });

    const document = await parseIllustrator(file, "blob.svg", DEFAULT_PARSE_OPTIONS);

    expect(document.source.byteSize).toBe(file.size);
    expect(document.pages[0]?.width).toBe(40);
  });

  it("tiles oversized 2x artboards without gaps or scaling", () => {
    expect(calculateImageTiles(3000, 6000)).toEqual([
      { x: 0, y: 0, width: 3000, height: 4096 },
      { x: 0, y: 4096, width: 3000, height: 1904 },
    ]);
    expect(calculateImageTiles(5000, 5000)).toEqual([
      { x: 0, y: 0, width: 4096, height: 4096 },
      { x: 4096, y: 0, width: 904, height: 4096 },
      { x: 0, y: 4096, width: 4096, height: 904 },
      { x: 4096, y: 4096, width: 904, height: 904 },
    ]);
  });

  it("rejects native AI files without a compatible payload", async () => {
    await expect(
      parseIllustrator(
        new TextEncoder().encode("Adobe Illustrator private data"),
        "native.ai",
        DEFAULT_PARSE_OPTIONS,
      ),
    ).rejects.toThrow("neither SVG-compatible nor saved with PDF compatibility");
  });
});
