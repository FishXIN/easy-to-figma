import { beforeEach, describe, expect, it, vi } from "vitest";
import { IR_VERSION, createReport, type IRDocument } from "@easy-to-figma/ir-schema";
import { analyzeDocumentFonts, renderDocument } from "./index";

class MockNode {
  children: MockNode[] = [];
  parent?: MockNode;
  name = "";
  x = 0;
  y = 0;
  width = 1;
  height = 1;
  opacity = 1;
  visible = true;
  locked = false;
  rotation = 0;
  blendMode = "NORMAL";
  effects: unknown[] = [];
  fills: unknown[] = [];
  strokes: unknown[] = [];
  strokeWeight = 1;
  dashPattern: number[] = [];
  clipsContent = false;
  cornerRadius = 0;
  isMask = false;
  maskType = "ALPHA";

  constructor(readonly type: string) {}

  appendChild(child: MockNode) {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }

  setPluginData() {}
}

class MockTextNode extends MockNode {
  characters = "";
  fontName: FontName = { family: "Inter", style: "Regular" };
  fontSize = 16;
  textAutoResize = "NONE";
  textAlignHorizontal = "LEFT";
  textAlignVertical = "TOP";
  textCase = "ORIGINAL";
  textDecoration = "NONE";
  lineHeight: unknown = { unit: "AUTO" };
  letterSpacing: unknown = { unit: "PIXELS", value: 0 };

  constructor() {
    super("TEXT");
  }

  setRangeFontName() {}
  setRangeFontSize() {}
  setRangeLetterSpacing() {}
  setRangeTextDecoration() {}
  setRangeFills() {}
}

function createFigmaMock() {
  const page = new MockNode("PAGE");
  return {
    listAvailableFontsAsync: async () => [
      { fontName: { family: "Inter", style: "Regular" } },
    ],
    loadFontAsync: async () => undefined,
    createFrame: () => new MockNode("FRAME"),
    createText: () => new MockTextNode(),
    createVector: () => Object.assign(new MockNode("VECTOR"), { vectorPaths: [] }),
    createRectangle: () => new MockNode("RECTANGLE"),
    createEllipse: () => new MockNode("ELLIPSE"),
    createPolygon: () => Object.assign(new MockNode("POLYGON"), { pointCount: 3 }),
    createLine: () => new MockNode("LINE"),
    createImage: () => ({ hash: "image" }),
    base64Decode: () => new Uint8Array(),
    createNodeFromSvg: () => {
      const frame = new MockNode("FRAME");
      frame.appendChild(new MockNode("VECTOR"));
      return frame;
    },
    group: (nodes: MockNode[], parent: MockNode) => {
      const group = new MockNode("GROUP");
      parent.appendChild(group);
      for (const node of nodes) group.appendChild(node);
      return group;
    },
    currentPage: Object.assign(page, { selection: [] as MockNode[] }),
    viewport: {
      center: { x: 0, y: 0 },
      scrollAndZoomIntoView: () => undefined,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("figma", createFigmaMock());
});

describe("renderDocument hierarchy", () => {
  it("creates real groups and removes temporary SVG frames", async () => {
    const document: IRDocument = {
      version: IR_VERSION,
      source: { name: "source.svg", format: "svg", byteSize: 1 },
      assets: [],
      report: createReport("svg", "source.svg"),
      pages: [
        {
          id: "page",
          name: "Artboard",
          type: "frame",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          children: [
            {
              id: "layer",
              name: "Layer_A",
              type: "group",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              childCoordinateSpace: "page",
              children: [
                {
                  id: "vector",
                  name: "Path",
                  type: "svg",
                  x: 0,
                  y: 0,
                  width: 100,
                  height: 100,
                  markup: '<svg xmlns="http://www.w3.org/2000/svg"/>',
                },
                {
                  id: "text",
                  name: "Title",
                  type: "text",
                  x: 10,
                  y: 10,
                  width: 80,
                  height: 20,
                  characters: "Editable",
                  fontFamily: "Inter",
                },
              ],
            },
          ],
        },
      ],
    };

    const result = await renderDocument(document);
    const page = (figma.currentPage.children[0] as unknown) as MockNode;
    const layer = page.children[0]!;

    expect(figma.currentPage.children).toHaveLength(1);
    expect(page.type).toBe("FRAME");
    expect(page.name).toBe("Artboard");
    expect(page.children).toHaveLength(1);
    expect(layer.type).toBe("GROUP");
    expect(layer.name).toBe("Layer_A");
    expect(layer.children.map((node) => [node.type, node.name])).toEqual([
      ["VECTOR", "Path"],
      ["TEXT", "Title"],
    ]);
    expect([
      page.name,
      ...page.children.map((node) => node.name),
      ...layer.children.map((node) => node.name),
    ]).not.toContain("__easy_to_figma_staging__");
    expect(result.nodeCount).toBe(4);
  });

  it("rolls back every new root node when an SVG leaf fails", async () => {
    const existing = figma.createRectangle();
    existing.name = "Existing";
    figma.currentPage.appendChild(existing);
    (figma as unknown as { createNodeFromSvg: () => never }).createNodeFromSvg = () => {
      throw new Error("Failed to convert SVG file");
    };
    const document: IRDocument = {
      version: IR_VERSION,
      source: { name: "source.ai", format: "ai", byteSize: 1 },
      assets: [],
      report: createReport("ai", "source.ai"),
      pages: [
        {
          id: "page-1",
          name: "First",
          type: "frame",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          children: [
            {
              id: "rect",
              name: "Background",
              type: "rectangle",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
            },
          ],
        },
        {
          id: "page-2",
          name: "Second",
          type: "frame",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          children: [
            {
              id: "svg",
              name: "Effect",
              type: "svg",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              markup: '<svg xmlns="http://www.w3.org/2000/svg"/>',
            },
          ],
        },
      ],
    };

    await expect(renderDocument(document)).rejects.toThrow(
      'The source SVG node "Effect" could not be imported',
    );
    expect(figma.currentPage.children).toEqual([existing]);
  });

  it("maps image adjustments and mask semantics to native Figma properties", async () => {
    const document: IRDocument = {
      version: IR_VERSION,
      source: { name: "masked.psd", format: "psd", byteSize: 1 },
      assets: [
        {
          id: "image-asset",
          name: "mask.png",
          mimeType: "image/png",
          data: new Uint8Array([1]),
        },
      ],
      report: createReport("psd", "masked.psd"),
      pages: [
        {
          id: "page",
          name: "PSD",
          type: "frame",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          children: [
            {
              id: "mask",
              name: "Layer Mask",
              type: "image",
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              assetRef: "image-asset",
              isMask: true,
              maskType: "luminance",
              filters: {
                exposure: 0.25,
                contrast: -0.5,
                saturation: 2,
              },
            },
          ],
        },
      ],
    };

    await renderDocument(document);
    const page = figma.currentPage.children[0] as unknown as MockNode;
    const mask = page.children[0]!;

    expect(mask.isMask).toBe(true);
    expect(mask.maskType).toBe("LUMINANCE");
    expect(mask.fills).toEqual([
      expect.objectContaining({
        filters: {
          exposure: 0.25,
          contrast: -0.5,
          saturation: 1,
          temperature: undefined,
          tint: undefined,
          highlights: undefined,
          shadows: undefined,
        },
      }),
    ]);
  });
});

describe("font resolution", () => {
  const document: IRDocument = {
    version: IR_VERSION,
    source: { name: "fonts.ai", format: "ai", byteSize: 1 },
    assets: [],
    report: createReport("ai", "fonts.ai"),
    pages: [
      {
        id: "page",
        name: "Artboard",
        type: "frame",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        children: [
          {
            id: "text",
            name: "Title",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 30,
            characters: "Exact",
            fontFamily: "Missing Display",
            fontStyle: "Bold",
            runs: [
              {
                start: 0,
                end: 5,
                fontFamily: "Available Sans",
                fontStyle: "Regular",
              },
            ],
          },
        ],
      },
    ],
  };

  it("checks base text and styled runs as exact family/style pairs", async () => {
    const analysis = await analyzeDocumentFonts(document, [
      { family: "Inter", style: "Regular" },
      { family: "Available Sans", style: "Regular" },
    ]);

    expect(analysis.requestedFonts).toEqual([
      { family: "Available Sans", style: "Regular" },
      { family: "Missing Display", style: "Bold" },
    ]);
    expect(analysis.missingFonts).toEqual([
      {
        key: "missing display::bold",
        requested: { family: "Missing Display", style: "Bold" },
        suggested: { family: "Inter", style: "Regular" },
      },
    ]);
  });

  it("uses the explicit replacement and reports the source-to-target mapping", async () => {
    (figma as unknown as {
      listAvailableFontsAsync: () => Promise<Array<{ fontName: FontName }>>;
    }).listAvailableFontsAsync = async () => [
      { fontName: { family: "Inter", style: "Regular" } },
      { fontName: { family: "Available Sans", style: "Regular" } },
      { fontName: { family: "Replacement Serif", style: "Bold" } },
    ];

    const result = await renderDocument(document, {
      fontReplacements: {
        "missing display::bold": { family: "Replacement Serif", style: "Bold" },
      },
    });
    const page = figma.currentPage.children[0] as unknown as MockNode;
    const text = page.children[0] as MockTextNode;

    expect(text.fontName).toEqual({ family: "Replacement Serif", style: "Bold" });
    expect(result.missingFonts).toEqual(["Missing Display Bold"]);
    expect(result.fontSubstitutions).toEqual([
      {
        requested: { family: "Missing Display", style: "Bold" },
        replacement: { family: "Replacement Serif", style: "Bold" },
      },
    ]);
  });
});
