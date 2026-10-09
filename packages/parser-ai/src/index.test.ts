import { describe, expect, it } from "vitest";
import { DEFAULT_PARSE_OPTIONS } from "@easy-to-figma/ir-schema";
import {
  calculateImageTiles,
  convertPdfJs6ConstructPath,
  extractPdfImageSegmentStyle,
  normalizePdfSvgMarkup,
  parseIllustrator,
  restoreUniformOpacity,
} from "./index";

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

  it("keeps complex SVG effects native while rebuilding text as editable layers", async () => {
    const source = `
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
        <style>.title { font-family: Inter; font-size: 20px; fill: #123456; letter-spacing: 2px; }</style>
        <defs>
          <linearGradient id="fade"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
          <clipPath id="crop"><rect width="200" height="100"/></clipPath>
        </defs>
        <g id="Layer_A" transform="translate(10 5)" opacity="0.5">
          <rect width="200" height="100" fill="url(#fade)" clip-path="url(#crop)"/>
          <g id="Copy">
            <text id="Title" class="title" x="20" y="40"><tspan>Editable title</tspan></text>
          </g>
        </g>
      </svg>
    `;

    const document = await parseIllustrator(
      new TextEncoder().encode(source),
      "complex.svg",
      DEFAULT_PARSE_OPTIONS,
    );
    const layer = document.pages[0]?.children[0];
    const decoration = layer?.type === "group" ? layer.children[0] : undefined;
    const copy = layer?.type === "group" ? layer.children[1] : undefined;
    const text = copy?.type === "group" ? copy.children[0] : undefined;

    expect(document.pages[0]?.children.map((node) => [node.type, node.name])).toEqual([
      ["group", "Layer_A"],
    ]);
    expect(layer?.type === "group" ? layer.children.map((node) => [node.type, node.name]) : []).toEqual([
      ["svg", "rect"],
      ["group", "Copy"],
    ]);
    expect(copy?.type === "group" ? copy.children.map((node) => [node.type, node.name]) : []).toEqual([
      ["text", "Title"],
    ]);
    expect(decoration?.type === "svg" ? decoration.markup : "").toContain("linearGradient");
    expect(decoration?.type === "svg" ? decoration.markup : "").not.toContain("<text");
    expect(text?.type === "text" ? text.characters : "").toBe("Editable title");
    expect(text?.x).toBeCloseTo(30);
    expect(text?.y).toBeCloseTo(25);
    expect(layer?.opacity).toBeCloseTo(0.5);
    expect(text?.opacity).toBeCloseTo(1);
    expect(text?.type === "text" ? text.fontFamily : "").toBe("Inter");
    expect(text?.type === "text" ? text.fontSize : 0).toBeCloseTo(20);
    expect(document.report.rasterizedNodes).toBe(0);
  });

  it("keeps multiple tspans inside one source text layer", async () => {
    const source = `
      <svg xmlns="http://www.w3.org/2000/svg" width="120" height="160">
        <style>.copy { font-family: Arial; font-size: 20px; fill: #ffffff; }</style>
        <g id="Text">
          <text id="VerticalCopy" class="copy" x="20" y="30">
            <tspan x="20" y="30">甲</tspan>
            <tspan x="20" y="60" fill="#ff0000">乙</tspan>
            <tspan x="20" y="90">丙</tspan>
          </text>
        </g>
      </svg>
    `;

    const document = await parseIllustrator(
      new TextEncoder().encode(source),
      "text-runs.svg",
      DEFAULT_PARSE_OPTIONS,
    );
    const layer = document.pages[0]?.children[0];
    const text = layer?.type === "group" ? layer.children[0] : undefined;

    expect(document.pages[0]?.children).toHaveLength(1);
    expect(layer?.type).toBe("group");
    expect(text?.type).toBe("text");
    expect(text?.type === "text" ? text.characters : "").toBe("甲\n乙\n丙");
    expect(text?.type === "text" ? text.runs : []).toHaveLength(3);
  });

  it("reports named empty SVG groups without adding noise for anonymous containers", async () => {
    const source = `
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
        <style>.unused { fill: red; }</style>
        <g />
        <g id="Named_Empty" />
      </svg>
    `;

    const document = await parseIllustrator(
      new TextEncoder().encode(source),
      "empty-groups.svg",
      DEFAULT_PARSE_OPTIONS,
    );
    const warnings = document.report.items.filter(
      (item) => item.code === "SVG_EMPTY_GROUP_OMITTED",
    );

    expect(document.pages[0]?.children).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.nodeName).toBe("Named_Empty");
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

  it("adapts PDF.js 6 paths for the SVG converter", () => {
    const ops = {
      moveTo: 13,
      lineTo: 14,
      curveTo: 15,
      closePath: 18,
    };
    const converted = convertPdfJs6ConstructPath(
      [
        24,
        [new Float32Array([0, 2, 3, 1, 4, 5, 3, 10, 11, 14, 15, 4])],
        new Float32Array([2, 3, 14, 15]),
      ],
      ops,
    );

    expect(converted.paintOperator).toBe(24);
    expect(converted.pathOperators).toEqual([13, 14, 15, 18]);
    expect(converted.pathArguments).toEqual([
      2,
      3,
      4,
      5,
      8,
      9,
      11.333333333333334,
      12.333333333333334,
      14,
      15,
    ]);
    expect(converted.minMax).toEqual([2, 14, 3, 15]);
  });

  it("does not duplicate an existing SVG namespace", () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
    const normalized = normalizePdfSvgMarkup(markup);

    expect(normalized.match(/\sxmlns=/g)).toHaveLength(1);
  });

  it("extracts native image compositing before the PDF graphics state is restored", () => {
    const ops = {
      setGState: 9,
      save: 10,
      restore: 11,
      beginGroup: 76,
      endGroup: 77,
      paintImageMaskXObject: 83,
      paintImageXObject: 85,
      paintInlineImageXObject: 86,
    };
    const style = extractPdfImageSegmentStyle(
      {
        fnArray: [10, 9, 76, 9, 85, 77, 11],
        argsArray: [
          null,
          [[["BM", "multiply"], ["ca", 0.4], ["SMask", true]]],
          [{ hasSoftMask: true }],
          [[["BM", "source-over"], ["ca", 1], ["SMask", false]]],
          ["image"],
          null,
          null,
        ],
      },
      0,
      5,
      ops,
    );

    expect(style).toEqual({
      blendMode: "multiply",
      opacity: 0.4,
      hasSoftMask: true,
    });
  });

  it("removes uniform source opacity from rendered alpha without changing color", () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 64, 40, 50, 60, 128]);

    restoreUniformOpacity(pixels, 0.5);

    expect([...pixels]).toEqual([10, 20, 30, 128, 40, 50, 60, 255]);
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
