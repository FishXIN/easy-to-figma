import { describe, expect, it } from "vitest";
import { DEFAULT_PARSE_OPTIONS, createReport } from "@easy-to-figma/ir-schema";
import {
  calculateImageTiles,
  convertPdfJs6ConstructPath,
  extractPdfGradientFill,
  pdfImageCompositingPlacement,
  extractPdfImageSegmentStyle,
  gradientPaintsWithFallback,
  normalOverlayFromCompositedPixels,
  normalizePdfSvgMarkup,
  parseIllustrator,
  pdfImageSegments,
  pdfImageOpacityStrategy,
  pdfTextAlignment,
  pdfTextNodes,
  pdfLayerNode,
  pdfLayerRanges,
  restoreUniformOpacity,
  shouldMergePdfText,
  transparentOverlayFromCompositedPixels,
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

  it("keeps the initial visibility of PDF optional-content layers", () => {
    const groups = new Map([
      ["visible", { name: "Artwork", visible: true }],
      ["hidden", { name: "Reference", visible: false }],
    ]);
    const ranges = pdfLayerRanges(
      {
        fnArray: [70, 71, 70, 71],
        argsArray: [
          ["OC", { id: "visible" }],
          null,
          ["OC", { id: "hidden" }],
          null,
        ],
      },
      { getGroup: (id) => groups.get(id) },
      {
        beginMarkedContentProps: 70,
        beginMarkedContent: 69,
        endMarkedContent: 71,
      },
    );

    expect(ranges).toEqual([
      {
        id: "visible",
        name: "Artwork",
        start: 1,
        end: 1,
        visible: true,
      },
      {
        id: "hidden",
        name: "Reference",
        start: 3,
        end: 3,
        visible: false,
      },
    ]);
  });

  it("drops a visible empty OCG placeholder when a hidden source layer has the same name", () => {
    const groups = new Map([
      ["placeholder", { name: "Reference", visible: true }],
      ["source", { name: "Reference", visible: false }],
    ]);
    const ranges = pdfLayerRanges(
      {
        fnArray: [70, 71, 70, 71],
        argsArray: [
          ["OC", { id: "placeholder" }],
          null,
          ["OC", { id: "source" }],
          null,
        ],
      },
      { getGroup: (id) => groups.get(id) },
      {
        beginMarkedContentProps: 70,
        beginMarkedContent: 69,
        endMarkedContent: 71,
      },
    );

    expect(ranges).toEqual([
      {
        id: "source",
        name: "Reference",
        start: 3,
        end: 3,
        visible: false,
      },
    ]);
  });

  it("preserves an empty hidden Illustrator layer as an editable Figma frame", () => {
    const layer = pdfLayerNode(
      {
        id: "hidden",
        name: "Reference",
        start: 10,
        end: 10,
        visible: false,
      },
      1500,
      3000,
      [],
    );

    expect(layer).toMatchObject({
      name: "Reference",
      type: "frame",
      width: 1500,
      height: 3000,
      visible: false,
      clipsContent: false,
      children: [],
    });
  });

  it("locks full-artboard background effect layers without hiding them", () => {
    for (const name of ["BG_Color", "BG_Mask", "Effect", "Picture", "Sub_BG", "Sub_BG_p2"]) {
      const layer = pdfLayerNode(
        { id: name, name, start: 0, end: 1, visible: true },
        1500,
        3000,
        [
          {
            id: `${name}-image`,
            name: "Content",
            type: "image",
            x: 0,
            y: 0,
            width: 1500,
            height: 3000,
            assetRef: "asset",
          },
        ],
      );

      expect(layer.locked).toBe(true);
      expect(layer.visible).toBe(true);
    }
    expect(
      pdfLayerNode(
        { id: "logo", name: "Logo", start: 0, end: 1, visible: true },
        1500,
        3000,
        [],
      ).locked,
    ).toBe(false);
  });

  it("merges wrapped PDF lines by left, center or right paragraph alignment", () => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      hasEOL = true,
    ) => ({
      str,
      width,
      height,
      transform: [1, 0, 0, 1, x, y],
      fontName: "font",
      hasEOL,
    });
    const rightAligned = [
      item("体验&观看链接", 1178.24, 284.36, 204.15, 30),
      item("通过网盘分享的文件：视频", 1190.37, 233.56, 192, 16),
      item("https://pan.baidu.com/example", 1010.9, 214.36, 371.49, 16),
    ];
    const centered = [
      item("Long centered line", 100, 200, 200, 20),
      item("Short line", 125, 170, 150, 20),
    ];

    expect(shouldMergePdfText(rightAligned[0]!, rightAligned[1]!)).toBe(true);
    expect(pdfTextAlignment(rightAligned)).toBe("right");
    expect(shouldMergePdfText(centered[0]!, centered[1]!)).toBe(true);
    expect(pdfTextAlignment(centered)).toBe("center");
    expect(
      shouldMergePdfText(
        item("Separate", 100, 200, 200, 20),
        item("Block", 100, 100, 200, 20),
      ),
    ).toBe(false);
  });

  it("creates one editable text node for a wrapped right-aligned paragraph", () => {
    const items = [
      {
        str: "体验&观看链接",
        width: 204.15,
        height: 30,
        transform: [1, 0, 0, 1, 1178.24, 284.36],
        fontName: "font",
        hasEOL: true,
      },
      {
        str: "通过网盘分享的文件：视频",
        width: 192,
        height: 16,
        transform: [1, 0, 0, 1, 1190.37, 233.56],
        fontName: "font",
        hasEOL: true,
      },
      {
        str: "https://pan.baidu.com/example",
        width: 371.49,
        height: 16,
        transform: [1, 0, 0, 1, 1010.9, 214.36],
        fontName: "font",
        hasEOL: false,
      },
    ];
    const nodes = pdfTextNodes(
      {
        view: [0, 0, 1500, 3000],
        commonObjs: { get: () => ({ name: "Arial" }) },
      },
      items,
      items.map(() => ({
        fill: { r: 0, g: 0, b: 0, a: 1 },
        opacity: 1,
      })),
      createReport("ai", "paragraph.ai"),
    );
    const text = nodes[0];

    expect(nodes).toHaveLength(1);
    expect(text?.type).toBe("text");
    expect(text?.type === "text" ? text.characters : "").toBe(
      "体验&观看链接\n通过网盘分享的文件：视频\nhttps://pan.baidu.com/example",
    );
    expect(text?.type === "text" ? text.textAlignHorizontal : "").toBe("right");
    const lineHeights =
      text?.type === "text" ? text.runs?.map((run) => run.lineHeight) ?? [] : [];
    expect(lineHeights).toHaveLength(3);
    expect(lineHeights[0]).toBeCloseTo(50.8);
    expect(lineHeights[1]).toBeCloseTo(19.2);
    expect(lineHeights[2]).toBeCloseTo(19.2);
  });

  it("extracts a PDF axial shading as an editable native gradient", () => {
    const ops = {
      save: 10,
      restore: 11,
      transform: 12,
      shadingFill: 62,
      fill: 22,
    };
    const fill = extractPdfGradientFill(
      {
        fnArray: [10, 12, 62, 11],
        argsArray: [
          null,
          [0, 3000, 3000, 0, 750, 0],
          ["pattern_p0_1"],
          null,
        ],
      },
      { start: 0, end: 4 },
      ops,
      (id) =>
        id === "pattern_p0_1"
          ? [
              "RadialAxial",
              "axial",
              null,
              [
                [0, "#030e0f"],
                [0.5154761904761904, "#081d1f"],
                [1, "#000808"],
              ],
              [0, 0],
              [1, 0],
            ]
          : undefined,
      3000,
      3000,
    );

    expect(fill).toMatchObject({
      type: "gradient",
      gradientType: "linear",
      start: { x: 0.25, y: 1 },
      end: { x: 0.25, y: 0 },
    });
    expect(fill?.type === "gradient" ? fill.stops : []).toEqual([
      {
        position: 0,
        color: { r: 3 / 255, g: 14 / 255, b: 15 / 255, a: 1 },
      },
      {
        position: 0.5154761904761904,
        color: { r: 8 / 255, g: 29 / 255, b: 31 / 255, a: 1 },
      },
      {
        position: 1,
        color: { r: 0, g: 8 / 255, b: 8 / 255, a: 1 },
      },
    ]);
    expect(fill ? gradientPaintsWithFallback(fill) : []).toEqual([
      fill,
      {
        type: "solid",
        color: { r: 3 / 255, g: 14 / 255, b: 15 / 255, a: 1 },
        opacity: undefined,
      },
    ]);
  });

  it("leaves mixed vector paint to the existing SVG converter", () => {
    const ops = {
      shadingFill: 62,
      fill: 22,
    };
    const fill = extractPdfGradientFill(
      {
        fnArray: [62, 22],
        argsArray: [["pattern"], null],
      },
      { start: 0, end: 2 },
      ops,
      () => ["RadialAxial", "axial", null, [], [0, 0], [1, 0]],
      100,
      100,
    );

    expect(fill).toBeUndefined();
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
      opacityBaked: true,
    });
  });

  it("inherits image compositing set before the isolated render segment", () => {
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
        fnArray: [9, 10, 85, 11],
        argsArray: [[[["BM", "multiply"], ["ca", 0.2], ["SMask", true]]], null, ["image"], null],
      },
      1,
      3,
      ops,
    );

    expect(style).toEqual({
      blendMode: "multiply",
      opacity: 0.2,
      hasSoftMask: true,
      opacityBaked: false,
    });
  });

  it("keeps an outer image-group blend when the image itself resets to source-over", () => {
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
        fnArray: [9, 76, 10, 9, 85, 11, 77],
        argsArray: [
          [[["BM", "multiply"], ["ca", 1]]],
          [{ hasSoftMask: false }],
          null,
          [[["BM", "source-over"], ["ca", 1]]],
          ["image"],
          null,
          [{ hasSoftMask: false }],
        ],
      },
      2,
      5,
      ops,
    );

    expect(style).toEqual({
      blendMode: "multiply",
      opacity: 1,
      hasSoftMask: false,
      opacityBaked: false,
    });
  });

  it("renders a paired PDF soft-mask group as one composited image segment", () => {
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
    const segments = pdfImageSegments(
      {
        fnArray: [
          11,
          10,
          9,
          76,
          100,
          76,
          10,
          9,
          85,
          11,
          77,
          9,
          10,
          9,
          85,
          11,
          77,
          11,
          10,
          9,
          85,
          11,
        ],
        argsArray: [
          null,
          null,
          [[["BM", "hard-light"], ["ca", 0.2], ["SMask", false]]],
          [{ hasSoftMask: true }],
          null,
          [{ hasSoftMask: true }],
          null,
          [[["BM", "source-over"], ["ca", 1], ["SMask", false]]],
          ["mask-image"],
          null,
          null,
          [[["SMask", true]]],
          null,
          [[["SMask", false]]],
          ["content-image"],
          null,
          null,
          null,
          null,
          [[["BM", "multiply"], ["ca", 0.4]]],
          ["direct-image"],
          null,
        ],
      },
      { id: "layer", name: "BG_Mask", start: 0, end: 22 },
      ops,
    );

    expect(segments).toEqual([
      {
        start: 3,
        end: 16,
        blendMode: "hard-light",
        opacity: 0.2,
        hasSoftMask: true,
        opacityBaked: false,
      },
      {
        start: 18,
        end: 21,
        blendMode: "multiply",
        opacity: 0.4,
        hasSoftMask: false,
        opacityBaked: true,
      },
    ]);
  });

  it("removes uniform source opacity from rendered alpha without changing color", () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 64, 40, 50, 60, 128]);

    restoreUniformOpacity(pixels, 0.5);

    expect([...pixels]).toEqual([10, 20, 30, 128, 40, 50, 60, 255]);
  });

  it("converts a composited blend result into an equivalent normal overlay", () => {
    const backdrop = new Uint8ClampedArray([32, 64, 96, 255]);
    const composited = new Uint8ClampedArray([60, 84, 108, 255]);
    const source = new Uint8ClampedArray([240, 220, 200, 128]);
    const overlay = normalOverlayFromCompositedPixels(
      backdrop,
      composited,
      source,
      0.5,
    );
    const alpha = (overlay[3] ?? 0) / 255;
    const recomposited = [0, 1, 2].map((channel) =>
      Math.round(
        (overlay[channel] ?? 0) * alpha +
          (backdrop[channel] ?? 0) * (1 - alpha),
      ),
    );

    expect(overlay[3]).toBe(64);
    expect(recomposited[0]).toBeCloseTo(composited[0] ?? 0, 0);
    expect(recomposited[1]).toBeCloseTo(composited[1] ?? 0, 0);
    expect(recomposited[2]).toBeCloseTo(composited[2] ?? 0, 0);
  });

  it("derives the minimum transparent overlay needed for an exact composite", () => {
    const backdrop = new Uint8ClampedArray([32, 64, 96, 255]);
    const composited = new Uint8ClampedArray([180, 24, 140, 255]);
    const overlay = transparentOverlayFromCompositedPixels(
      backdrop,
      composited,
    );
    const alpha = (overlay[3] ?? 0) / 255;
    const recomposited = [0, 1, 2].map((channel) =>
      Math.round(
        (overlay[channel] ?? 0) * alpha +
          (backdrop[channel] ?? 0) * (1 - alpha),
      ),
    );

    expect(overlay[3]).toBeGreaterThan(0);
    expect(overlay[3]).toBeLessThan(255);
    expect(recomposited[0]).toBeCloseTo(composited[0] ?? 0, 0);
    expect(recomposited[1]).toBeCloseTo(composited[1] ?? 0, 0);
    expect(recomposited[2]).toBeCloseTo(composited[2] ?? 0, 0);
  });

  it("keeps soft-mask alpha and only reapplies opacity omitted from the segment", () => {
    expect(
      pdfImageOpacityStrategy({ opacity: 0.3, hasSoftMask: true, opacityBaked: true }),
    ).toEqual({
      normalizeAlpha: false,
      nodeOpacity: 1,
    });
    expect(
      pdfImageOpacityStrategy({ opacity: 0.3, hasSoftMask: true, opacityBaked: false }),
    ).toEqual({
      normalizeAlpha: false,
      nodeOpacity: 0.3,
    });
    expect(
      pdfImageOpacityStrategy({ opacity: 0.3, hasSoftMask: false, opacityBaked: true }),
    ).toEqual({
      normalizeAlpha: true,
      nodeOpacity: 0.3,
    });
    expect(
      pdfImageOpacityStrategy({ opacity: 0.3, hasSoftMask: false, opacityBaked: false }),
    ).toEqual({
      normalizeAlpha: false,
      nodeOpacity: 0.3,
    });
  });

  it("places soft-mask compositing on a native group instead of the image leaf", () => {
    expect(
      pdfImageCompositingPlacement({
        blendMode: "hard-light",
        opacity: 0.2,
        hasSoftMask: true,
        opacityBaked: false,
      }),
    ).toEqual({
      imageBlendMode: "normal",
      imageOpacity: 0.2,
      groupBlendMode: "hard-light",
      groupOpacity: 1,
    });
    expect(
      pdfImageCompositingPlacement({
        blendMode: "multiply",
        opacity: 0.4,
        hasSoftMask: false,
        opacityBaked: true,
      }),
    ).toEqual({
      imageBlendMode: "multiply",
      imageOpacity: 0.4,
    });
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
