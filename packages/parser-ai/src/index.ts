import { DOMParser } from "@xmldom/xmldom";
import {
  IR_VERSION,
  countNodes,
  createId,
  createReport,
  hexToColor,
  type Asset,
  type Color,
  type ContainerNode,
  type IRDocument,
  type IRNode,
  type Paint,
  type ParseOptions,
  type Stroke,
} from "@easy-to-figma/ir-schema";

interface SvgContext {
  width: number;
  height: number;
  assets: Asset[];
  report: ReturnType<typeof createReport>;
}

function numberAttribute(element: Element, name: string, fallback = 0): number {
  const value = Number.parseFloat(element.getAttribute(name) ?? "");
  return Number.isFinite(value) ? value : fallback;
}

function parseLength(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseColor(value: string | null): Color | undefined {
  if (!value || value === "none" || value === "transparent") return undefined;
  if (value.startsWith("#")) return hexToColor(value);
  const rgb = value.match(/rgba?\(([^)]+)\)/i);
  if (rgb?.[1]) {
    const channels = rgb[1].split(",").map((part) => Number.parseFloat(part.trim()));
    return {
      r: (channels[0] ?? 0) / 255,
      g: (channels[1] ?? 0) / 255,
      b: (channels[2] ?? 0) / 255,
      a: channels[3] ?? 1,
    };
  }
  const named: Record<string, string> = {
    black: "000000",
    white: "FFFFFF",
    red: "FF0000",
    green: "008000",
    blue: "0000FF",
    gray: "808080",
    grey: "808080",
  };
  return named[value.toLowerCase()] ? hexToColor(named[value.toLowerCase()] ?? "000000") : undefined;
}

function styleMap(element: Element): Record<string, string> {
  const style = element.getAttribute("style") ?? "";
  return Object.fromEntries(
    style
      .split(";")
      .map((entry) => entry.split(":").map((part) => part.trim()))
      .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])),
  );
}

function readPaint(element: Element): Paint[] {
  const style = styleMap(element);
  const fill = parseColor(element.getAttribute("fill") ?? style.fill ?? "#000000");
  const opacity = Number.parseFloat(element.getAttribute("fill-opacity") ?? style["fill-opacity"] ?? "1");
  return fill ? [{ type: "solid", color: fill, opacity: Number.isFinite(opacity) ? opacity : 1 }] : [];
}

function readStroke(element: Element): Stroke[] {
  const style = styleMap(element);
  const color = parseColor(element.getAttribute("stroke") ?? style.stroke ?? null);
  if (!color) return [];
  return [
    {
      color,
      width: parseLength(element.getAttribute("stroke-width") ?? style["stroke-width"] ?? null, 1),
      opacity: parseLength(element.getAttribute("stroke-opacity") ?? style["stroke-opacity"] ?? null, 1),
    },
  ];
}

function translate(element: Element): { x: number; y: number } {
  const transform = element.getAttribute("transform") ?? "";
  const translation = transform.match(/translate\(\s*([-\d.]+)(?:[,\s]+([-\d.]+))?/);
  const matrix = transform.match(/matrix\(\s*[-\d.]+[,\s]+[-\d.]+[,\s]+[-\d.]+[,\s]+[-\d.]+[,\s]+([-\d.]+)[,\s]+([-\d.]+)/);
  if (translation) {
    return {
      x: Number.parseFloat(translation[1] ?? "0"),
      y: Number.parseFloat(translation[2] ?? "0"),
    };
  }
  if (matrix) {
    return {
      x: Number.parseFloat(matrix[1] ?? "0"),
      y: Number.parseFloat(matrix[2] ?? "0"),
    };
  }
  return { x: 0, y: 0 };
}

function childElements(element: Element): Element[] {
  const result: Element[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const node = element.childNodes.item(index);
    if (node?.nodeType === 1) result.push(node as Element);
  }
  return result;
}

function elementName(element: Element, fallback: string): string {
  return element.getAttribute("id") || element.getAttribute("inkscape:label") || fallback;
}

function parseSvgElement(element: Element, context: SvgContext, parentOffset = { x: 0, y: 0 }): IRNode[] {
  const tag = element.tagName.toLowerCase().replace(/^.*:/, "");
  const ownOffset = translate(element);
  const offset = { x: parentOffset.x + ownOffset.x, y: parentOffset.y + ownOffset.y };
  const opacity = parseLength(element.getAttribute("opacity"), 1);
  const visible = element.getAttribute("display") !== "none" && element.getAttribute("visibility") !== "hidden";

  if (tag === "g" || tag === "svg" || tag === "a") {
    const children = childElements(element).flatMap((child) => parseSvgElement(child, context, offset));
    if (tag === "svg") return children;
    return [
      {
        id: createId("svg-group"),
        name: elementName(element, "Group"),
        type: "group",
        x: 0,
        y: 0,
        width: context.width,
        height: context.height,
        opacity,
        visible,
        children,
      },
    ];
  }

  if (tag === "rect") {
    const x = numberAttribute(element, "x") + offset.x;
    const y = numberAttribute(element, "y") + offset.y;
    const width = Math.max(1, numberAttribute(element, "width", 1));
    const height = Math.max(1, numberAttribute(element, "height", 1));
    context.report.editableNodes += 1;
    return [
      {
        id: createId("rect"),
        name: elementName(element, "Rectangle"),
        type: "rectangle",
        x,
        y,
        width,
        height,
        opacity,
        visible,
        fills: readPaint(element),
        strokes: readStroke(element),
        cornerRadius: Math.max(numberAttribute(element, "rx"), numberAttribute(element, "ry")),
      },
    ];
  }

  if (tag === "circle" || tag === "ellipse") {
    const rx =
      tag === "circle" ? numberAttribute(element, "r", 1) : Math.max(1, numberAttribute(element, "rx", 1));
    const ry =
      tag === "circle" ? numberAttribute(element, "r", 1) : Math.max(1, numberAttribute(element, "ry", 1));
    const cx = numberAttribute(element, "cx") + offset.x;
    const cy = numberAttribute(element, "cy") + offset.y;
    context.report.editableNodes += 1;
    return [
      {
        id: createId("ellipse"),
        name: elementName(element, "Ellipse"),
        type: "ellipse",
        x: cx - rx,
        y: cy - ry,
        width: rx * 2,
        height: ry * 2,
        opacity,
        visible,
        fills: readPaint(element),
        strokes: readStroke(element),
      },
    ];
  }

  if (tag === "line") {
    const x1 = numberAttribute(element, "x1") + offset.x;
    const y1 = numberAttribute(element, "y1") + offset.y;
    const x2 = numberAttribute(element, "x2") + offset.x;
    const y2 = numberAttribute(element, "y2") + offset.y;
    context.report.editableNodes += 1;
    return [
      {
        id: createId("line"),
        name: elementName(element, "Line"),
        type: "line",
        x: x1,
        y: y1,
        width: Math.max(1, x2 - x1),
        height: Math.max(1, y2 - y1),
        opacity,
        visible,
        fills: [],
        strokes: readStroke(element),
      },
    ];
  }

  if (tag === "path") {
    const data = element.getAttribute("d") ?? "";
    if (!data) return [];
    context.report.editableNodes += 1;
    return [
      {
        id: createId("path"),
        name: elementName(element, "Path"),
        type: "vector",
        x: offset.x,
        y: offset.y,
        width: context.width,
        height: context.height,
        opacity,
        visible,
        fills: readPaint(element),
        strokes: readStroke(element),
        vectorPaths: [
          {
            data,
            windingRule: element.getAttribute("fill-rule") === "evenodd" ? "evenodd" : "nonzero",
          },
        ],
      },
    ];
  }

  if (tag === "text") {
    const characters = element.textContent?.trim() ?? "";
    if (!characters) return [];
    const style = styleMap(element);
    const fontSize = parseLength(element.getAttribute("font-size") ?? style["font-size"] ?? null, 16);
    const anchor = element.getAttribute("text-anchor") ?? style["text-anchor"];
    context.report.editableNodes += 1;
    return [
      {
        id: createId("text"),
        name: elementName(element, "Text"),
        type: "text",
        x: numberAttribute(element, "x") + offset.x,
        y: numberAttribute(element, "y") + offset.y - fontSize,
        width: Math.max(fontSize, context.width - numberAttribute(element, "x")),
        height: Math.max(fontSize * 1.4, numberAttribute(element, "height", fontSize * 1.4)),
        opacity,
        visible,
        characters,
        fontFamily: element.getAttribute("font-family") ?? style["font-family"] ?? "Arial",
        fontStyle:
          (element.getAttribute("font-weight") ?? style["font-weight"]) === "bold" ? "Bold" : "Regular",
        fontSize,
        textAlignHorizontal: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
        textAlignVertical: "top",
        fills: readPaint(element),
      },
    ];
  }

  if (tag === "image") {
    const href = element.getAttribute("href") ?? element.getAttribute("xlink:href") ?? "";
    if (!href.startsWith("data:image/")) {
      context.report.skippedNodes += 1;
      context.report.items.push({
        level: "warning",
        code: "SVG_EXTERNAL_IMAGE",
        message: "An externally linked SVG image was skipped. Embed the image before importing.",
        nodeName: elementName(element, "Image"),
      });
      return [];
    }
    const assetId = createId("asset");
    const mimeType = href.slice(5, href.indexOf(";"));
    context.assets.push({ id: assetId, name: elementName(element, "Embedded image"), mimeType, data: href });
    context.report.editableNodes += 1;
    return [
      {
        id: createId("image"),
        name: elementName(element, "Image"),
        type: "image",
        x: numberAttribute(element, "x") + offset.x,
        y: numberAttribute(element, "y") + offset.y,
        width: Math.max(1, numberAttribute(element, "width", 1)),
        height: Math.max(1, numberAttribute(element, "height", 1)),
        opacity,
        visible,
        assetRef: assetId,
        scaleMode: "fill",
      },
    ];
  }

  context.report.skippedNodes += 1;
  context.report.items.push({
    level: "warning",
    code: "SVG_UNSUPPORTED_ELEMENT",
    message: `The SVG <${tag}> element is not supported yet and was skipped.`,
    nodeName: elementName(element, tag),
  });
  return [];
}

function parseSvg(bytes: Uint8Array, sourceName: string): IRDocument {
  const xml = new TextDecoder().decode(bytes);
  const document = new DOMParser().parseFromString(xml, "image/svg+xml");
  const svg = document.documentElement as unknown as Element;
  if (!svg || svg.tagName.toLowerCase().replace(/^.*:/, "") !== "svg") {
    throw new Error("The Illustrator file is not an SVG-compatible document.");
  }
  const viewBox = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map((value) => Number.parseFloat(value));
  const width = parseLength(svg.getAttribute("width"), viewBox[2] ?? 1000);
  const height = parseLength(svg.getAttribute("height"), viewBox[3] ?? 1000);
  const report = createReport(sourceName.toLowerCase().endsWith(".ai") ? "ai" : "svg", sourceName);
  const assets: Asset[] = [];
  const context: SvgContext = { width, height, assets, report };
  const children = childElements(svg).flatMap((element) => parseSvgElement(element, context));
  const page: ContainerNode = {
    id: createId("artboard"),
    name: sourceName.replace(/\.(ai|svg)$/i, "") || "Artboard 1",
    type: "frame",
    x: 0,
    y: 0,
    width,
    height,
    fills: [],
    children,
    clipsContent: true,
  };
  report.parsedNodes = countNodes([page]);
  report.items.unshift({
    level: "info",
    code: "SVG_VECTOR_IMPORT",
    message: "SVG-compatible Illustrator content was converted to editable Figma layers.",
  });

  return {
    version: IR_VERSION,
    source: {
      name: sourceName,
      format: sourceName.toLowerCase().endsWith(".ai") ? "ai" : "svg",
      byteSize: bytes.byteLength,
    },
    pages: [page],
    assets,
    report,
  };
}

async function parsePdfFallback(bytes: Uint8Array, sourceName: string, options: ParseOptions): Promise<IRDocument> {
  if (options.unsupportedStrategy === "skip") {
    throw new Error("PDF-compatible Illustrator content requires raster fallback. Enable rasterize to continue.");
  }
  if (typeof document === "undefined") {
    throw new Error("PDF-compatible Illustrator files can only be rendered in the Figma plugin UI.");
  }

  const [{ GlobalWorkerOptions, getDocument }, { default: pdfWorkerSource }] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw"),
  ]);
  GlobalWorkerOptions.workerSrc = URL.createObjectURL(
    new Blob([pdfWorkerSource], { type: "text/javascript" }),
  );
  const loadingTask = getDocument({ data: bytes.slice() });
  const pdf = await loadingTask.promise;
  const report = createReport(sourceName.toLowerCase().endsWith(".ai") ? "ai" : "pdf", sourceName);
  const assets: Asset[] = [];
  const pages: ContainerNode[] = [];

  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    const pdfPage = await pdf.getPage(pageIndex);
    const viewport = pdfPage.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) throw new Error("Canvas rendering is unavailable.");
    await pdfPage.render({ canvas, canvasContext, viewport }).promise;

    const assetId = createId("asset");
    assets.push({
      id: assetId,
      name: `${sourceName} - Artboard ${pageIndex}.png`,
      mimeType: "image/png",
      data: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
    });
    pages.push({
      id: createId("artboard"),
      name: `Artboard ${pageIndex}`,
      type: "frame",
      x: 0,
      y: 0,
      width: viewport.width / 2,
      height: viewport.height / 2,
      fills: [],
      children: [
        {
          id: createId("image"),
          name: "PDF-compatible artwork",
          type: "image",
          x: 0,
          y: 0,
          width: viewport.width / 2,
          height: viewport.height / 2,
          assetRef: assetId,
          scaleMode: "fill",
        },
      ],
      clipsContent: true,
    });
  }

  report.parsedNodes = countNodes(pages);
  report.rasterizedNodes = pages.length;
  report.items.push({
    level: "fallback",
    code: "AI_PDF_FALLBACK",
    message:
      "PDF-compatible Illustrator artwork was preserved visually per artboard. Save as SVG to retain editable paths.",
  });
  await loadingTask.destroy();

  return {
    version: IR_VERSION,
    source: {
      name: sourceName,
      format: sourceName.toLowerCase().endsWith(".ai") ? "ai" : "pdf",
      byteSize: bytes.byteLength,
    },
    pages,
    assets,
    report,
  };
}

export async function parseIllustrator(
  input: ArrayBuffer | Uint8Array,
  sourceName: string,
  options: ParseOptions,
): Promise<IRDocument> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (header.startsWith("<svg") || header.startsWith("<?xml")) {
    return parseSvg(bytes, sourceName);
  }
  if (header.startsWith("%PDF-")) {
    return parsePdfFallback(bytes, sourceName, options);
  }
  throw new Error(
    "This .ai file is neither SVG-compatible nor saved with PDF compatibility. Re-save it with Create PDF Compatible File enabled.",
  );
}
