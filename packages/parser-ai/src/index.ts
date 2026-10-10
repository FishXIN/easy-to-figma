import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
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
  type TextStyleRun,
} from "@easy-to-figma/ir-schema";
import {
  PdfSvgGraphics,
  type PdfObjectPool,
  type PdfViewport,
} from "./pdf-svg-graphics";

interface SvgContext {
  width: number;
  height: number;
  assets: Asset[];
  classStyles: Map<string, Record<string, string>>;
  report: ReturnType<typeof createReport>;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

export interface IllustratorParseProgress {
  phase: "loading" | "rendering" | "encoding";
  page: number;
  pageCount: number;
  progress: number;
}

export interface IllustratorParseCallbacks {
  onProgress?: (progress: IllustratorParseProgress) => void;
}

const PDF_RASTER_SCALE = 2;
const MAX_IMAGE_TILE_SIZE = 4096;
const ADOBE_SVG_NAMESPACES: Record<string, string> = {
  ns_adobe_xpath: "http://ns.adobe.com/XPath/1.0/",
  ns_ai: "http://ns.adobe.com/AdobeIllustrator/10.0/",
  ns_custom: "http://ns.adobe.com/GenericCustomNamespace/1.0/",
  ns_extend: "http://ns.adobe.com/Extensibility/1.0/",
  ns_graphs: "http://ns.adobe.com/Graphs/1.0/",
  ns_imrep: "http://ns.adobe.com/ImageReplacement/1.0/",
  ns_sfw: "http://ns.adobe.com/SaveForWeb/1.0/",
  ns_vars: "http://ns.adobe.com/Variables/1.0/",
};

export interface ImageTile {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizeSvgXml(input: string): { xml: string; removedNulls: number } {
  const removedNulls = (input.match(/\u0000/g) ?? []).length;
  let xml = input.replace(/\u0000/g, "");
  for (const [entity, namespace] of Object.entries(ADOBE_SVG_NAMESPACES)) {
    xml = xml.replace(new RegExp(`&${entity};`, "g"), namespace);
  }
  xml = xml.replace(/adobe-blending-mode\s*:\s*([a-zA-Z-]+)/g, (_match, value: string) => {
    const normalized = value
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace("source-over", "normal");
    return `mix-blend-mode:${normalized}`;
  });
  return { xml, removedNulls };
}

export function calculateImageTiles(
  width: number,
  height: number,
  maxSize = MAX_IMAGE_TILE_SIZE,
): ImageTile[] {
  const tiles: ImageTile[] = [];
  const columns = Math.ceil(width / maxSize);
  const rows = Math.ceil(height / maxSize);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * maxSize;
      const y = row * maxSize;
      tiles.push({
        x,
        y,
        width: Math.min(maxSize, width - x),
        height: Math.min(maxSize, height - y),
      });
    }
  }
  return tiles;
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
      .map((entry) => {
        const colon = entry.indexOf(":");
        return colon < 0
          ? []
          : [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()];
      })
      .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])),
  );
}

function tagName(element: Element): string {
  return element.tagName.toLowerCase().replace(/^.*:/, "");
}

function parentElement(element: Element): Element | undefined {
  return element.parentNode?.nodeType === 1 ? (element.parentNode as Element) : undefined;
}

function readClassStyles(root: Element): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  const styleElements = root.getElementsByTagName("style");
  for (let index = 0; index < styleElements.length; index += 1) {
    const css = styleElements.item(index)?.textContent ?? "";
    for (const match of css.matchAll(/\.([-\w]+)\s*\{([^}]+)\}/g)) {
      const className = match[1];
      const declarations = match[2];
      if (!className || !declarations) continue;
      const parsed = Object.fromEntries(
        declarations
          .split(";")
          .map((entry) => {
            const colon = entry.indexOf(":");
            return colon < 0
              ? []
              : [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()];
          })
          .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])),
      );
      result.set(className, { ...(result.get(className) ?? {}), ...parsed });
    }
  }
  return result;
}

function inheritedValue(
  element: Element,
  name: string,
  context: SvgContext,
  fallback?: string,
): string | undefined {
  let current: Element | undefined = element;
  while (current) {
    const inline = styleMap(current)[name];
    if (inline !== undefined) return inline;
    const classes = (current.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean);
    for (let index = classes.length - 1; index >= 0; index -= 1) {
      const fromClass = context.classStyles.get(classes[index] ?? "")?.[name];
      if (fromClass !== undefined) return fromClass;
    }
    const attribute = current.getAttribute(name);
    if (attribute !== null) return attribute;
    current = parentElement(current);
  }
  return fallback;
}

function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function parseTransform(value: string | null): Matrix {
  let result: Matrix = [...IDENTITY_MATRIX];
  for (const match of (value ?? "").matchAll(/([a-z]+)\s*\(([^)]*)\)/gi)) {
    const name = (match[1] ?? "").toLowerCase();
    const values = (match[2]?.match(/[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    let operation: Matrix = [...IDENTITY_MATRIX];
    if (name === "matrix" && values.length >= 6) {
      operation = values.slice(0, 6) as Matrix;
    } else if (name === "translate") {
      operation = [1, 0, 0, 1, values[0] ?? 0, values[1] ?? 0];
    } else if (name === "scale") {
      const x = values[0] ?? 1;
      operation = [x, 0, 0, values[1] ?? x, 0, 0];
    } else if (name === "rotate") {
      const radians = ((values[0] ?? 0) * Math.PI) / 180;
      const rotation: Matrix = [
        Math.cos(radians),
        Math.sin(radians),
        -Math.sin(radians),
        Math.cos(radians),
        0,
        0,
      ];
      const centerX = values[1] ?? 0;
      const centerY = values[2] ?? 0;
      operation = multiplyMatrix(
        multiplyMatrix([1, 0, 0, 1, centerX, centerY], rotation),
        [1, 0, 0, 1, -centerX, -centerY],
      );
    } else if (name === "skewx") {
      operation = [1, 0, Math.tan(((values[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    } else if (name === "skewy") {
      operation = [1, Math.tan(((values[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    result = multiplyMatrix(result, operation);
  }
  return result;
}

function elementMatrix(element: Element): Matrix {
  const chain: Element[] = [];
  let current: Element | undefined = element;
  while (current) {
    chain.push(current);
    current = parentElement(current);
  }
  return chain
    .reverse()
    .reduce(
      (matrix, item) => multiplyMatrix(matrix, parseTransform(item.getAttribute("transform"))),
      [...IDENTITY_MATRIX] as Matrix,
    );
}

function transformPoint(matrix: Matrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function cumulativeOpacity(element: Element, context: SvgContext): number {
  let opacity = 1;
  let current: Element | undefined = element;
  while (current) {
    opacity *= parseLength(current.getAttribute("opacity") ?? styleMap(current).opacity ?? null, 1);
    current = parentElement(current);
  }
  opacity *= parseLength(inheritedValue(element, "fill-opacity", context, "1") ?? null, 1);
  return Math.max(0, Math.min(1, opacity));
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

function allElements(root: Element): Element[] {
  const result: Element[] = [root];
  for (const child of childElements(root)) {
    result.push(...allElements(child));
  }
  return result;
}

const STRUCTURAL_SVG_TAGS = new Set([
  "clippath",
  "defs",
  "font",
  "lineargradient",
  "mask",
  "metadata",
  "pattern",
  "radialgradient",
  "style",
  "symbol",
]);

function hasStructuralAncestor(element: Element): boolean {
  let current = parentElement(element);
  while (current) {
    if (STRUCTURAL_SVG_TAGS.has(tagName(current))) return true;
    current = parentElement(current);
  }
  return false;
}

function estimatedTextWidth(characters: string, fontSize: number, letterSpacing: number): number {
  const glyphWidth = [...characters].reduce(
    (total, character) => total + (character.codePointAt(0)! > 0xff ? fontSize : fontSize * 0.56),
    0,
  );
  return Math.max(fontSize, glyphWidth + Math.max(0, characters.length - 1) * letterSpacing);
}

function ownStyleValue(element: Element, name: string): string | undefined {
  return styleMap(element)[name] ?? element.getAttribute(name) ?? undefined;
}

function ownOpacity(element: Element): number {
  return Math.max(0, Math.min(1, parseLength(ownStyleValue(element, "opacity") ?? null, 1)));
}

function ownVisibility(element: Element): boolean {
  return ownStyleValue(element, "display") !== "none" && ownStyleValue(element, "visibility") !== "hidden";
}

function normalizedElementName(element: Element, fallback: string): string {
  return elementName(element, fallback).replace(/_x5F_/gi, "_");
}

interface ComplexTextPart {
  characters: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  baselineY: number;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  letterSpacing: number;
  fill: Color;
  decoration: TextStyleRun["textDecoration"];
}

function parseComplexTextPart(
  element: Element,
  context: SvgContext,
): ComplexTextPart | undefined {
  const characters = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!characters) return undefined;

  const matrix = elementMatrix(element);
  const x = parseLength(inheritedValue(element, "x", context, "0") ?? null, 0);
  const y = parseLength(inheritedValue(element, "y", context, "0") ?? null, 0);
  const dx = numberAttribute(element, "dx");
  const dy = numberAttribute(element, "dy");
  const anchorPoint = transformPoint(matrix, x + dx, y + dy);
  const scaleX = Math.hypot(matrix[0], matrix[1]) || 1;
  const scaleY = Math.hypot(matrix[2], matrix[3]) || scaleX;
  const localFontSize = parseLength(inheritedValue(element, "font-size", context, "16") ?? null, 16);
  const fontSize = Math.max(1, localFontSize * scaleY);
  const letterSpacing =
    parseLength(inheritedValue(element, "letter-spacing", context, "0") ?? null, 0) * scaleX;
  const declaredLength = parseLength(element.getAttribute("textLength"), 0) * scaleX;
  const width =
    declaredLength > 0
      ? declaredLength
      : estimatedTextWidth(characters, fontSize, letterSpacing);
  const anchor = inheritedValue(element, "text-anchor", context, "start");
  const left = anchor === "middle" ? anchorPoint.x - width / 2 : anchor === "end" ? anchorPoint.x - width : anchorPoint.x;
  const fontWeight = inheritedValue(element, "font-weight", context, "normal") ?? "normal";
  const italic = (inheritedValue(element, "font-style", context, "normal") ?? "normal") !== "normal";
  const bold = fontWeight === "bold" || Number.parseInt(fontWeight, 10) >= 600;
  const fontFamily = (inheritedValue(element, "font-family", context, "Arial") ?? "Arial")
    .split(",")[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, "") || "Arial";
  const fill =
    parseColor(inheritedValue(element, "fill", context, "#000000") ?? null) ??
    hexToColor("#000000");
  const decoration = inheritedValue(element, "text-decoration", context, "none");

  return {
    characters,
    left,
    top: anchorPoint.y - fontSize,
    right: left + width,
    bottom: anchorPoint.y + fontSize * 0.25,
    baselineY: anchorPoint.y,
    fontFamily,
    fontStyle: bold && italic ? "Bold Italic" : bold ? "Bold" : italic ? "Italic" : "Regular",
    fontSize,
    letterSpacing,
    fill,
    decoration:
      decoration === "underline" ? "underline" : decoration === "line-through" ? "strikethrough" : "none",
  };
}

function parseComplexTextContainer(
  container: Element,
  context: SvgContext,
): IRNode | undefined {
  const spanElements = allElements(container).filter(
    (element) => element !== container && tagName(element) === "tspan",
  );
  const sourceParts = spanElements.length > 0 ? spanElements : [container];
  const parts = sourceParts
    .map((element) => parseComplexTextPart(element, context))
    .filter((part): part is ComplexTextPart => part !== undefined);
  if (parts.length === 0) return undefined;

  let characters = "";
  const runs: TextStyleRun[] = [];
  const lineGaps: number[] = [];
  let previous: ComplexTextPart | undefined;

  for (const part of parts) {
    if (previous) {
      const lineThreshold = Math.max(1, Math.min(previous.fontSize, part.fontSize) * 0.45);
      if (Math.abs(part.baselineY - previous.baselineY) > lineThreshold) {
        lineGaps.push(Math.abs(part.baselineY - previous.baselineY));
        characters += "\n";
      }
    }
    const start = characters.length;
    characters += part.characters;
    runs.push({
      start,
      end: characters.length,
      fontFamily: part.fontFamily,
      fontStyle: part.fontStyle,
      fontSize: part.fontSize,
      letterSpacing: part.letterSpacing,
      textDecoration: part.decoration,
      fills: [{ type: "solid", color: part.fill }],
    });
    previous = part;
  }

  const first = parts[0]!;
  const matrix = elementMatrix(container);
  const left = Math.min(...parts.map((part) => part.left));
  const top = Math.min(...parts.map((part) => part.top));
  const right = Math.max(...parts.map((part) => part.right));
  const bottom = Math.max(...parts.map((part) => part.bottom));
  const lineHeight =
    lineGaps.length > 0
      ? lineGaps.reduce((total, gap) => total + gap, 0) / lineGaps.length
      : first.fontSize * 1.2;
  const anchor = inheritedValue(container, "text-anchor", context, "start");
  const blendMode = inheritedValue(container, "mix-blend-mode", context);

  context.report.editableNodes += 1;
  return {
    id: createId("text"),
    name: normalizedElementName(container, characters.slice(0, 100) || "Text"),
    type: "text",
    x: left,
    y: top,
    width: Math.max(first.fontSize, right - left),
    height: Math.max(first.fontSize * 1.25, bottom - top),
    rotation: (-Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI,
    opacity: ownOpacity(container),
    visible: ownVisibility(container),
    blendMode,
    characters,
    fontFamily: first.fontFamily,
    fontStyle: first.fontStyle,
    fontSize: first.fontSize,
    letterSpacing: first.letterSpacing,
    lineHeight,
    textAlignHorizontal: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
    textAlignVertical: "top",
    textDecoration: first.decoration,
    fills: [{ type: "solid", color: first.fill }],
    runs,
  };
}

function requiresNativeSvg(root: Element): boolean {
  const complexTags = new Set([
    "clippath",
    "defs",
    "filter",
    "foreignobject",
    "lineargradient",
    "mask",
    "pattern",
    "radialgradient",
    "style",
    "symbol",
    "textpath",
    "tspan",
    "use",
  ]);
  return allElements(root).some((element) => {
    if (complexTags.has(tagName(element))) return true;
    const transform = element.getAttribute("transform") ?? "";
    if (transform && !/^\s*translate\(/i.test(transform)) return true;
    const style = styleMap(element);
    return Boolean(
      element.getAttribute("class") ||
        element.getAttribute("clip-path") ||
        element.getAttribute("mask") ||
        element.getAttribute("filter") ||
        style["clip-path"] ||
        style.mask ||
        style.filter ||
        style["mix-blend-mode"] ||
        style.fill?.startsWith("url(") ||
        style.stroke?.startsWith("url("),
    );
  });
}

function countNativeSvgDecorations(root: Element): number {
  const visibleTags = new Set([
    "circle",
    "ellipse",
    "g",
    "image",
    "line",
    "path",
    "polygon",
    "polyline",
    "rect",
    "use",
  ]);
  return allElements(root).filter(
    (element) => visibleTags.has(tagName(element)) && !hasStructuralAncestor(element),
  ).length;
}

function structuralRoots(root: Element): Element[] {
  return allElements(root).filter((element) => {
    if (!STRUCTURAL_SVG_TAGS.has(tagName(element))) return false;
    const parent = parentElement(element);
    return !parent || !STRUCTURAL_SVG_TAGS.has(tagName(parent));
  });
}

function stripContainerAppearance(element: Element): void {
  element.removeAttribute("opacity");
  element.removeAttribute("display");
  element.removeAttribute("visibility");
  const style = styleMap(element);
  delete style.opacity;
  delete style.display;
  delete style.visibility;
  delete style["mix-blend-mode"];
  const serialized = Object.entries(style)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  if (serialized) element.setAttribute("style", serialized);
  else element.removeAttribute("style");
}

function createSvgFragment(
  root: Element,
  element: Element,
  width: number,
  height: number,
): string {
  const document = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>`,
    "image/svg+xml",
  );
  const fragmentRoot = document.documentElement as unknown as Element;
  for (let index = 0; index < root.attributes.length; index += 1) {
    const attribute = root.attributes.item(index);
    if (attribute) fragmentRoot.setAttribute(attribute.name, attribute.value);
  }
  fragmentRoot.setAttribute("width", String(width));
  fragmentRoot.setAttribute("height", String(height));
  if (!fragmentRoot.getAttribute("viewBox")) {
    fragmentRoot.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  for (const structural of structuralRoots(root)) {
    fragmentRoot.appendChild(structural.cloneNode(true));
  }

  const ancestors: Element[] = [];
  let current = parentElement(element);
  while (current && current !== root) {
    if (!STRUCTURAL_SVG_TAGS.has(tagName(current))) ancestors.push(current);
    current = parentElement(current);
  }

  let parent: Element = fragmentRoot;
  for (const ancestor of ancestors.reverse()) {
    const clone = ancestor.cloneNode(false) as Element;
    stripContainerAppearance(clone);
    parent.appendChild(clone);
    parent = clone;
  }
  parent.appendChild(element.cloneNode(true));
  return new XMLSerializer().serializeToString(document);
}

function parseComplexHierarchyElement(
  element: Element,
  root: Element,
  context: SvgContext,
): IRNode[] {
  const tag = tagName(element);
  if (STRUCTURAL_SVG_TAGS.has(tag) || hasStructuralAncestor(element)) return [];

  if (tag === "text") {
    const text = parseComplexTextContainer(element, context);
    return text ? [text] : [];
  }

  if (tag === "g" || tag === "a") {
    const children = childElements(element).flatMap((child) =>
      parseComplexHierarchyElement(child, root, context),
    );
    if (children.length === 0) {
      const sourceName =
        element.getAttribute("id") || element.getAttribute("inkscape:label");
      if (sourceName) {
        context.report.items.push({
          level: "warning",
          code: "SVG_EMPTY_GROUP_OMITTED",
          message: "Figma does not support empty Group nodes, so this empty source group was omitted.",
          nodeName: sourceName.replace(/_x5F_/gi, "_"),
        });
      }
      return [];
    }
    context.report.editableNodes += 1;
    return [
      {
        id: createId("svg-group"),
        name: normalizedElementName(element, "Group"),
        type: "group",
        x: 0,
        y: 0,
        width: context.width,
        height: context.height,
        opacity: ownOpacity(element),
        visible: ownVisibility(element),
        blendMode: ownStyleValue(element, "mix-blend-mode"),
        childCoordinateSpace: "page",
        children,
      },
    ];
  }

  context.report.editableNodes += 1;
  return [
    {
      id: createId("svg"),
      name: normalizedElementName(element, tag),
      type: "svg",
      x: 0,
      y: 0,
      width: context.width,
      height: context.height,
      markup: createSvgFragment(root, element, context.width, context.height),
    },
  ];
}

function parseComplexSvg(
  xml: string,
  sourceName: string,
  width: number,
  height: number,
  sourceByteSize: number,
): IRDocument {
  const visualDocument = new DOMParser().parseFromString(xml, "image/svg+xml");
  const visualRoot = visualDocument.documentElement as unknown as Element;
  const report = createReport(sourceName.toLowerCase().endsWith(".ai") ? "ai" : "svg", sourceName);
  const context: SvgContext = {
    width,
    height,
    assets: [],
    classStyles: readClassStyles(visualRoot),
    report,
  };
  const children = childElements(visualRoot).flatMap((element) =>
    parseComplexHierarchyElement(element, visualRoot, context),
  );
  const decorationCount = countNativeSvgDecorations(visualRoot);
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
  report.editableNodes = Math.max(report.editableNodes, decorationCount);
  report.parsedNodes = countNodes([page]);
  report.items.push({
    level: "info",
    code: "SVG_HIERARCHY_IMPORT",
    message:
      "Source groups, child order and editable text were preserved. Temporary native SVG wrappers are removed during Figma rendering.",
  });

  return {
    version: IR_VERSION,
    source: {
      name: sourceName,
      format: sourceName.toLowerCase().endsWith(".ai") ? "ai" : "svg",
      byteSize: sourceByteSize,
    },
    pages: [page],
    assets: [],
    report,
  };
}

function parseSvgElement(element: Element, context: SvgContext, parentOffset = { x: 0, y: 0 }): IRNode[] {
  const tag = tagName(element);
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
  const normalized = normalizeSvgXml(new TextDecoder().decode(bytes));
  const xml = normalized.xml;
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
  if (requiresNativeSvg(svg)) {
    const parsed = parseComplexSvg(xml, sourceName, width, height, bytes.byteLength);
    if (normalized.removedNulls > 0) {
      parsed.report.items.push({
        level: "warning",
        code: "SVG_INVALID_NULL_REMOVED",
        message: `${normalized.removedNulls} invalid null character(s) emitted by Illustrator were removed from editable text.`,
      });
    }
    return parsed;
  }
  const report = createReport(sourceName.toLowerCase().endsWith(".ai") ? "ai" : "svg", sourceName);
  const assets: Asset[] = [];
  const context: SvgContext = {
    width,
    height,
    assets,
    classStyles: readClassStyles(svg),
    report,
  };
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
  if (normalized.removedNulls > 0) {
    report.items.push({
      level: "warning",
      code: "SVG_INVALID_NULL_REMOVED",
      message: `${normalized.removedNulls} invalid null character(s) emitted by Illustrator were removed from editable text.`,
    });
  }

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

function sourceBaseName(sourceName: string): string {
  return sourceName.replace(/\.(ai|pdf)$/i, "") || "Illustrator";
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("The rendered Illustrator artboard could not be encoded as PNG."));
    }, "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

interface PdfOperatorList {
  fnArray: number[];
  argsArray: unknown[];
  lastChunk?: boolean;
}

export interface PdfLayerRange {
  id: string;
  name: string;
  start: number;
  end: number;
  visible?: boolean;
}

export interface PdfImageSegment {
  start: number;
  end: number;
  blendMode: string;
  opacity: number;
  hasSoftMask: boolean;
  opacityBaked: boolean;
}

interface PdfTextItem {
  str: string;
  width: number;
  height: number;
  transform: number[];
  fontName: string;
  hasEOL?: boolean;
}

interface PdfTextStyle {
  fill: Color;
  opacity: number;
  blendMode?: string;
}

export function pdfLayerRanges(
  operatorList: PdfOperatorList,
  optionalContentConfig: {
    getGroup: (id: string) => { name?: string; visible?: boolean } | undefined;
  },
  ops: Record<string, number>,
): PdfLayerRange[] {
  const ranges: PdfLayerRange[] = [];
  const stack: Array<{ id?: string; start: number }> = [];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operator = operatorList.fnArray[index];
    if (operator === ops.beginMarkedContentProps) {
      const args = operatorList.argsArray[index];
      const values = Array.isArray(args) ? args : [];
      const properties = values[1] as { id?: string } | undefined;
      stack.push({ id: values[0] === "OC" ? properties?.id : undefined, start: index + 1 });
      continue;
    }
    if (operator === ops.beginMarkedContent) {
      stack.push({ start: index + 1 });
      continue;
    }
    if (operator !== ops.endMarkedContent) continue;
    const marked = stack.pop();
    if (!marked?.id) continue;
    const group = optionalContentConfig.getGroup(marked.id);
    ranges.push({
      id: marked.id,
      name: group?.name ?? marked.id,
      start: marked.start,
      end: index,
      visible: group?.visible ?? true,
    });
  }
  const sortedRanges = ranges.sort((left, right) => left.start - right.start);
  return sortedRanges.filter((range) => {
    if (!range.visible || range.start !== range.end) return true;
    const normalizedName = range.name.trim().toLowerCase();
    return !sortedRanges.some(
      (candidate) =>
        candidate !== range &&
        candidate.name.trim().toLowerCase() === normalizedName &&
        candidate.visible === false,
    );
  });
}

export function pdfLayerNode(
  range: PdfLayerRange,
  width: number,
  height: number,
  children: IRNode[],
): ContainerNode {
  const normalizedName = range.name.toLowerCase().replace(/[\s_-]+/g, "");
  const locked = new Set([
    "bgcolor",
    "bgmask",
    "effect",
    "picture",
    "subbg",
    "subbgp2",
  ]).has(normalizedName);
  return {
    id: createId("ai-layer"),
    name: range.name,
    type: children.length === 0 ? "frame" : "group",
    x: 0,
    y: 0,
    width,
    height,
    visible: range.visible,
    locked,
    childCoordinateSpace: "page",
    clipsContent: false,
    children,
  };
}

function pdfBlendMode(value: unknown): string {
  const normalized = String(value ?? "normal")
    .replace("source-over", "normal")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return normalized;
}

function pdfGStateEntries(args: unknown): Array<[string, unknown]> {
  if (!Array.isArray(args) || !Array.isArray(args[0])) return [];
  return (args[0] as unknown[]).filter(
    (entry): entry is [string, unknown] =>
      Array.isArray(entry) && typeof entry[0] === "string",
  );
}

export interface PdfImageSegmentStyle {
  blendMode: string;
  opacity: number;
  hasSoftMask: boolean;
  opacityBaked: boolean;
}

function pdfGroupOptions(args: unknown): {
  hasSoftMask?: boolean;
} {
  if (!Array.isArray(args) || !args[0] || typeof args[0] !== "object") return {};
  return args[0] as { hasSoftMask?: boolean };
}

function applyPdfImageGState(
  state: PdfImageSegmentStyle,
  args: unknown,
  opacityBaked: boolean,
): PdfImageSegmentStyle {
  let next = state;
  for (const [name, value] of pdfGStateEntries(args)) {
    if (name === "BM") next = { ...next, blendMode: pdfBlendMode(value) };
    if (name === "ca") {
      const opacity = Number(value);
      if (Number.isFinite(opacity)) {
        next = {
          ...next,
          opacity: Math.max(0, Math.min(1, opacity)),
          opacityBaked,
        };
      }
    }
    if (name === "SMask") next = { ...next, hasSoftMask: Boolean(value) };
  }
  return next;
}

function pdfImageStateBefore(
  operatorList: PdfOperatorList,
  end: number,
  ops: Record<string, number>,
): PdfImageSegmentStyle {
  let state: PdfImageSegmentStyle = {
    blendMode: "normal",
    opacity: 1,
    hasSoftMask: false,
    opacityBaked: false,
  };
  const stack: PdfImageSegmentStyle[] = [];
  for (let index = 0; index < end; index += 1) {
    const operator = operatorList.fnArray[index];
    if (operator === ops.save || operator === ops.beginGroup) {
      stack.push({ ...state });
      if (operator === ops.beginGroup && pdfGroupOptions(operatorList.argsArray[index]).hasSoftMask) {
        state = { ...state, hasSoftMask: true };
      }
      continue;
    }
    if (operator === ops.restore || operator === ops.endGroup) {
      state = stack.pop() ?? state;
      continue;
    }
    if (operator === ops.setGState) {
      state = applyPdfImageGState(state, operatorList.argsArray[index], false);
    }
  }
  return { ...state, opacityBaked: false };
}

export function extractPdfImageSegmentStyle(
  operatorList: PdfOperatorList,
  start: number,
  end: number,
  ops: Record<string, number>,
): PdfImageSegmentStyle {
  let state = pdfImageStateBefore(operatorList, start, ops);
  const inheritedStyle = { ...state };
  let imageStyle: PdfImageSegmentStyle | undefined;
  let groupOutputStyle: PdfImageSegmentStyle | undefined;
  let encounteredSoftMask = state.hasSoftMask;
  const stack: PdfImageSegmentStyle[] = [];
  const imageOperators = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  for (let index = start; index <= end; index += 1) {
    const operator = operatorList.fnArray[index];
    if (operator === ops.save || operator === ops.beginGroup) {
      stack.push({ ...state });
      if (operator === ops.beginGroup && pdfGroupOptions(operatorList.argsArray[index]).hasSoftMask) {
        groupOutputStyle ??= { ...state, hasSoftMask: true };
        encounteredSoftMask = true;
        state = { ...state, hasSoftMask: true };
      }
      continue;
    }
    if (operator === ops.restore || operator === ops.endGroup) {
      state = stack.pop() ?? state;
      continue;
    }
    if (operator === ops.setGState) {
      state = applyPdfImageGState(state, operatorList.argsArray[index], true);
      if (state.hasSoftMask) encounteredSoftMask = true;
    }
    if (imageOperators.has(operator)) imageStyle = { ...state };
  }
  const hasInheritedCompositing =
    inheritedStyle.blendMode !== "normal" ||
    inheritedStyle.opacity !== 1 ||
    inheritedStyle.hasSoftMask;
  const style =
    groupOutputStyle ??
    (hasInheritedCompositing
      ? {
          ...(imageStyle ?? state),
          blendMode: inheritedStyle.blendMode,
          opacity: inheritedStyle.opacity,
          hasSoftMask:
            inheritedStyle.hasSoftMask ||
            (imageStyle ?? state).hasSoftMask,
          opacityBaked: false,
        }
      : imageStyle ?? state);
  return {
    ...style,
    hasSoftMask: encounteredSoftMask || style.hasSoftMask,
  };
}

function pdfSoftMaskGroupRanges(
  operatorList: PdfOperatorList,
  range: PdfLayerRange,
  ops: Record<string, number>,
): Array<{ start: number; end: number }> {
  const imageOperators = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  const groups: Array<{
    start: number;
    hasSoftMask: boolean;
    nestedInSoftMask: boolean;
    hasImage: boolean;
  }> = [];
  const ranges: Array<{ start: number; end: number }> = [];

  for (let index = range.start; index < range.end; index += 1) {
    const operator = operatorList.fnArray[index];
    if (operator === ops.beginGroup) {
      const hasSoftMask = Boolean(
        pdfGroupOptions(operatorList.argsArray[index]).hasSoftMask,
      );
      groups.push({
        start: index,
        hasSoftMask,
        nestedInSoftMask: groups.some((group) => group.hasSoftMask),
        hasImage: false,
      });
      continue;
    }
    if (imageOperators.has(operator)) {
      for (const group of groups) group.hasImage = true;
      continue;
    }
    if (operator !== ops.endGroup) continue;
    const group = groups.pop();
    if (
      group?.hasSoftMask &&
      group.hasImage &&
      !group.nestedInSoftMask
    ) {
      ranges.push({ start: group.start, end: index });
    }
  }
  return ranges;
}

export function pdfImageSegments(
  operatorList: PdfOperatorList,
  range: PdfLayerRange,
  ops: Record<string, number>,
): PdfImageSegment[] {
  const imageOperators = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  const softMaskRanges = pdfSoftMaskGroupRanges(operatorList, range, ops);
  const isSoftMaskOperation = (index: number) =>
    softMaskRanges.some(
      (softMaskRange) =>
        index >= softMaskRange.start && index <= softMaskRange.end,
    );
  const overlapsSoftMask = (start: number, end: number) =>
    softMaskRanges.some(
      (softMaskRange) =>
        start <= softMaskRange.end && end >= softMaskRange.start,
    );
  const saveStack: number[] = [];
  const saveRanges: Array<{ start: number; end: number }> = [];

  for (let index = range.start; index < range.end; index += 1) {
    const operator = operatorList.fnArray[index];
    if (operator === ops.save) {
      saveStack.push(index);
      continue;
    }
    if (operator !== ops.restore) continue;
    const start = saveStack.pop();
    if (start !== undefined) saveRanges.push({ start, end: index });
  }

  const ranges = [...softMaskRanges];
  for (let index = range.start; index < range.end; index += 1) {
    if (
      !imageOperators.has(operatorList.fnArray[index]) ||
      isSoftMaskOperation(index)
    ) {
      continue;
    }
    const enclosingSave = saveRanges
      .filter(
        (saveRange) =>
          saveRange.start <= index &&
          saveRange.end >= index &&
          !overlapsSoftMask(saveRange.start, saveRange.end),
      )
      .sort((left, right) => right.start - left.start)[0];
    ranges.push(enclosingSave ?? { start: index, end: index });
  }

  return Array.from(
    new Map(
      ranges.map((segmentRange) => [
        `${segmentRange.start}:${segmentRange.end}`,
        segmentRange,
      ]),
    ).values(),
  )
    .sort((left, right) => left.start - right.start)
    .map((segmentRange) => ({
      ...segmentRange,
      ...extractPdfImageSegmentStyle(
        operatorList,
        segmentRange.start,
        segmentRange.end,
        ops,
      ),
    }));
}

export function restoreUniformOpacity(
  pixels: Uint8ClampedArray,
  opacity: number,
): Uint8ClampedArray {
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity >= 1) return pixels;
  for (let index = 3; index < pixels.length; index += 4) {
    pixels[index] = Math.min(255, Math.round((pixels[index] ?? 0) / opacity));
  }
  return pixels;
}

export function pdfImageOpacityStrategy(
  style: Pick<PdfImageSegmentStyle, "opacity" | "hasSoftMask" | "opacityBaked">,
): { normalizeAlpha: boolean; nodeOpacity: number } {
  if (style.hasSoftMask) {
    return {
      normalizeAlpha: false,
      nodeOpacity: style.opacityBaked ? 1 : style.opacity,
    };
  }
  return {
    normalizeAlpha: style.opacityBaked && style.opacity > 0 && style.opacity < 1,
    nodeOpacity: style.opacity,
  };
}

export interface PdfImageCompositingPlacement {
  imageBlendMode: string;
  imageOpacity: number;
  groupBlendMode?: string;
  groupOpacity?: number;
}

export function pdfImageCompositingPlacement(
  style: PdfImageSegmentStyle,
): PdfImageCompositingPlacement {
  const opacityStrategy = pdfImageOpacityStrategy(style);
  if (!style.hasSoftMask) {
    return {
      imageBlendMode: style.blendMode,
      imageOpacity: opacityStrategy.nodeOpacity,
    };
  }
  return {
    imageBlendMode: "normal",
    imageOpacity: opacityStrategy.nodeOpacity,
    groupBlendMode: style.blendMode,
    groupOpacity: 1,
  };
}

function restoreCanvasOpacity(canvas: HTMLCanvasElement, opacity: number): void {
  if (opacity <= 0 || opacity >= 1) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  restoreUniformOpacity(image.data, opacity);
  context.putImageData(image, 0, 0);
}

export function normalOverlayFromCompositedPixels(
  backdrop: Uint8ClampedArray,
  composited: Uint8ClampedArray,
  source: Uint8ClampedArray,
  opacity: number,
): Uint8ClampedArray {
  const overlay = new Uint8ClampedArray(source.length);
  const normalizedOpacity = Math.max(0, Math.min(1, opacity));
  for (let index = 0; index < source.length; index += 4) {
    const alpha = ((source[index + 3] ?? 0) / 255) * normalizedOpacity;
    if (alpha <= 1 / 255) continue;
    overlay[index + 3] = Math.round(alpha * 255);
    for (let channel = 0; channel < 3; channel += 1) {
      const before = (backdrop[index + channel] ?? 0) / 255;
      const after = (composited[index + channel] ?? 0) / 255;
      overlay[index + channel] = Math.round(
        Math.max(0, Math.min(1, (after - before * (1 - alpha)) / alpha)) * 255,
      );
    }
  }
  return overlay;
}

export function transparentOverlayFromCompositedPixels(
  backdrop: Uint8ClampedArray,
  composited: Uint8ClampedArray,
): Uint8ClampedArray {
  const overlay = new Uint8ClampedArray(composited.length);
  for (let index = 0; index < composited.length; index += 4) {
    let alpha = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const before = (backdrop[index + channel] ?? 0) / 255;
      const after = (composited[index + channel] ?? 0) / 255;
      if (after > before) {
        alpha = Math.max(
          alpha,
          before >= 1 ? 1 : (after - before) / (1 - before),
        );
      } else if (after < before) {
        alpha = Math.max(
          alpha,
          before <= 0 ? 1 : (before - after) / before,
        );
      }
    }
    if (alpha <= 1 / 255) continue;
    const quantizedAlpha = Math.min(1, Math.ceil(alpha * 255) / 255);
    overlay[index + 3] = Math.round(quantizedAlpha * 255);
    for (let channel = 0; channel < 3; channel += 1) {
      const before = (backdrop[index + channel] ?? 0) / 255;
      const after = (composited[index + channel] ?? 0) / 255;
      overlay[index + channel] = Math.round(
        Math.max(
          0,
          Math.min(
            1,
            (after - before * (1 - quantizedAlpha)) / quantizedAlpha,
          ),
        ) * 255,
      );
    }
  }
  return overlay;
}

function normalizeCanvasBlendToOverlay(
  canvas: HTMLCanvasElement,
  backdropCanvas: HTMLCanvasElement,
  blendMode: string,
  opacity: number,
): boolean {
  if (
    canvas.width !== backdropCanvas.width ||
    canvas.height !== backdropCanvas.height ||
    blendMode === "normal"
  ) {
    return false;
  }
  const sourceContext = canvas.getContext("2d");
  const backdropContext = backdropCanvas.getContext("2d");
  if (!sourceContext || !backdropContext) return false;
  const source = sourceContext.getImageData(0, 0, canvas.width, canvas.height);
  const backdrop = backdropContext.getImageData(
    0,
    0,
    backdropCanvas.width,
    backdropCanvas.height,
  );
  const previousComposite = backdropContext.globalCompositeOperation;
  const previousAlpha = backdropContext.globalAlpha;
  try {
    backdropContext.globalCompositeOperation = blendMode as GlobalCompositeOperation;
    if (backdropContext.globalCompositeOperation !== blendMode) return false;
    backdropContext.globalAlpha = opacity;
    backdropContext.drawImage(canvas, 0, 0);
  } finally {
    backdropContext.globalCompositeOperation = previousComposite;
    backdropContext.globalAlpha = previousAlpha;
  }
  const composited = backdropContext.getImageData(
    0,
    0,
    backdropCanvas.width,
    backdropCanvas.height,
  );
  source.data.set(
    normalOverlayFromCompositedPixels(
      backdrop.data,
      composited.data,
      source.data,
      opacity,
    ),
  );
  sourceContext.putImageData(source, 0, 0);
  return true;
}

function canvasHasVisiblePixels(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 0) > 0) return true;
  }
  return false;
}

function pdfImageLayerName(index: number, blendMode: string): string {
  const label =
    blendMode === "hard-light"
      ? "氛围叠影"
      : blendMode === "multiply"
        ? "纸张纹理"
        : "图像内容";
  return `${String(index + 1).padStart(2, "0")} ${label}`;
}

async function renderPdfRangeCanvas(
  pdfPage: {
    getViewport: (options: { scale: number }) => { width: number; height: number };
    render: (options: {
      canvas: HTMLCanvasElement;
      canvasContext: CanvasRenderingContext2D;
      viewport: unknown;
      background: string;
      operationsFilter: (index: number) => boolean;
      optionalContentConfigPromise?: Promise<unknown>;
    }) => { promise: Promise<void> };
  },
  ranges: Array<Pick<PdfLayerRange, "start" | "end">>,
  optionalContentConfigPromise?: Promise<unknown>,
): Promise<HTMLCanvasElement | undefined> {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  await pdfPage.render({
    canvas,
    canvasContext: context,
    viewport,
    background: "rgba(0,0,0,0)",
    operationsFilter: (index) =>
      ranges.some((range) => index >= range.start && index <= range.end),
    optionalContentConfigPromise,
  }).promise;
  if (!canvasHasVisiblePixels(canvas)) {
    canvas.width = 1;
    canvas.height = 1;
    return undefined;
  }
  return canvas;
}

function transparentOverlayCanvas(
  backdropCanvas: HTMLCanvasElement,
  compositedCanvas: HTMLCanvasElement,
): HTMLCanvasElement | undefined {
  if (
    backdropCanvas.width !== compositedCanvas.width ||
    backdropCanvas.height !== compositedCanvas.height
  ) {
    return undefined;
  }
  const backdropContext = backdropCanvas.getContext("2d");
  const compositedContext = compositedCanvas.getContext("2d");
  if (!backdropContext || !compositedContext) return undefined;
  const backdrop = backdropContext.getImageData(
    0,
    0,
    backdropCanvas.width,
    backdropCanvas.height,
  );
  const composited = compositedContext.getImageData(
    0,
    0,
    compositedCanvas.width,
    compositedCanvas.height,
  );
  composited.data.set(
    transparentOverlayFromCompositedPixels(backdrop.data, composited.data),
  );
  compositedContext.putImageData(composited, 0, 0);
  if (!canvasHasVisiblePixels(compositedCanvas)) return undefined;
  return compositedCanvas;
}

async function renderPdfImageLayers(
  pdfPage: {
    getViewport: (options: { scale: number }) => { width: number; height: number };
    render: (options: {
      canvas: HTMLCanvasElement;
      canvasContext: CanvasRenderingContext2D;
      viewport: unknown;
      background: string;
      operationsFilter: (index: number) => boolean;
      optionalContentConfigPromise?: Promise<unknown>;
    }) => { promise: Promise<void> };
  },
  operatorList: PdfOperatorList,
  range: PdfLayerRange,
  ops: Record<string, number>,
  assets: Asset[],
  context: SvgContext,
  optionalContentConfigPromise?: Promise<unknown>,
  compositingBackdrop?: HTMLCanvasElement,
  compositedOverlay?: HTMLCanvasElement,
): Promise<IRNode[]> {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const nodes: IRNode[] = [];
  if (compositedOverlay) {
    const assetId = createId("asset");
    const layerName = "01 氛围叠影";
    assets.push({
      id: assetId,
      name: `${range.name} ${layerName}.png`,
      mimeType: "image/png",
      data: await canvasToPngBytes(compositedOverlay),
      width: compositedOverlay.width,
      height: compositedOverlay.height,
    });
    nodes.push({
      id: createId("image"),
      name: layerName,
      type: "image",
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
      opacity: 1,
      blendMode: "normal",
      assetRef: assetId,
      scaleMode: "fill",
    });
    context.report.items.push({
      level: "fallback",
      code: "PDF_SOFT_MASK_EFFECT_PRESERVED",
      message:
        "The source soft-mask layer remains separate from its editable background gradient and was normalized to one transparent overlay.",
      nodeName: layerName,
      pageName: range.name,
    });
    context.report.editableNodes += 1;
    return nodes;
  }
  for (const segment of pdfImageSegments(operatorList, range, ops)) {
    const opacityStrategy = pdfImageOpacityStrategy(segment);
    let placement = pdfImageCompositingPlacement(segment);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) throw new Error("Canvas rendering is unavailable.");
    canvasContext.clearRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({
      canvas,
      canvasContext,
      viewport,
      background: "rgba(0,0,0,0)",
      operationsFilter: (index) => index >= segment.start && index <= segment.end,
      optionalContentConfigPromise,
    }).promise;
    if (opacityStrategy.normalizeAlpha) restoreCanvasOpacity(canvas, segment.opacity);
    const normalizedBlend =
      compositingBackdrop !== undefined &&
      normalizeCanvasBlendToOverlay(
        canvas,
        compositingBackdrop,
        segment.blendMode,
        opacityStrategy.nodeOpacity,
      );
    if (normalizedBlend) {
      placement = {
        imageBlendMode: "normal",
        imageOpacity: 1,
        groupBlendMode: "normal",
        groupOpacity: 1,
      };
    }
    if (!canvasHasVisiblePixels(canvas)) {
      canvas.width = 1;
      canvas.height = 1;
      continue;
    }

    const assetId = createId("asset");
    const layerName = pdfImageLayerName(nodes.length, segment.blendMode);
    assets.push({
      id: assetId,
      name: `${range.name} ${layerName}.png`,
      mimeType: "image/png",
      data: await canvasToPngBytes(canvas),
      width: canvas.width,
      height: canvas.height,
    });
    const imageNode: IRNode = {
      id: createId("image"),
      name: segment.hasSoftMask ? "蒙版内容" : layerName,
      type: "image",
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
      opacity: placement.imageOpacity,
      blendMode: placement.imageBlendMode,
      assetRef: assetId,
      scaleMode: "fill",
    };
    nodes.push(
      placement.groupBlendMode
        ? {
            id: createId("soft-mask-group"),
            name: layerName,
            type: "group",
            x: 0,
            y: 0,
            width: viewport.width,
            height: viewport.height,
            opacity: placement.groupOpacity,
            blendMode: placement.groupBlendMode,
            childCoordinateSpace: "page",
            children: [imageNode],
          }
        : imageNode,
    );
    if (segment.hasSoftMask) {
      context.report.items.push({
        level: "fallback",
        code: "PDF_SOFT_MASK_EFFECT_PRESERVED",
        message:
          normalizedBlend
            ? "The source soft mask remains an independent editable layer; its PDF blend result was normalized to a transparent overlay because Figma composites this group differently."
            : "The source soft mask and blur were preserved in an independent image leaf; its opacity and blend mode remain native properties on the matching Figma group.",
        nodeName: layerName,
        pageName: range.name,
      });
    } else if (segment.blendMode !== "normal" || segment.opacity < 1) {
      context.report.items.push({
        level: "info",
        code: "PDF_IMAGE_COMPOSITING_PRESERVED",
        message:
          "The source image blend mode and opacity were restored as native Figma layer properties.",
        nodeName: layerName,
        pageName: range.name,
      });
    }
    context.report.editableNodes += segment.hasSoftMask ? 2 : 1;
    canvas.width = 1;
    canvas.height = 1;
  }
  return nodes;
}

function pdfTextStyles(
  operatorList: PdfOperatorList,
  range: PdfLayerRange,
  ops: Record<string, number>,
): PdfTextStyle[] {
  let state: PdfTextStyle = { fill: hexToColor("#000000"), opacity: 1 };
  const stack: PdfTextStyle[] = [];
  const styles: PdfTextStyle[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const operator = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (operator === ops.save) {
      stack.push({ ...state, fill: { ...state.fill } });
    } else if (operator === ops.restore) {
      state = stack.pop() ?? state;
    } else if (operator === ops.setFillRGBColor) {
      const values = Array.isArray(args) ? args : [];
      const color =
        typeof values[0] === "string"
          ? parseColor(values[0])
          : values.length >= 3
            ? {
                r: Number(values[0] ?? 0),
                g: Number(values[1] ?? 0),
                b: Number(values[2] ?? 0),
                a: 1,
              }
            : undefined;
      if (color) state = { ...state, fill: color };
    } else if (operator === ops.setGState) {
      let opacity = state.opacity;
      let blendMode = state.blendMode;
      for (const [name, value] of pdfGStateEntries(args)) {
        if (name === "ca" || name === "CA") opacity = Number(value);
        if (name === "BM") blendMode = pdfBlendMode(value);
      }
      state = { ...state, opacity, blendMode };
    } else if (operator === ops.showText || operator === ops.showSpacedText) {
      styles.push({ ...state, fill: { ...state.fill } });
    }
  }
  return styles;
}

function isPdfTextItem(value: unknown): value is PdfTextItem {
  return Boolean(
    value &&
      typeof value === "object" &&
      "str" in value &&
      typeof (value as { str?: unknown }).str === "string",
  );
}

function pdfTextItemsByLayer(
  items: unknown[],
  ranges: PdfLayerRange[],
): Map<string, PdfTextItem[]> {
  const result = new Map<string, PdfTextItem[]>();
  let markedIndex = -1;
  let currentId: string | undefined;
  for (const item of items) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: string }).type === "beginMarkedContentProps" &&
      (item as { tag?: string }).tag === "OC"
    ) {
      markedIndex += 1;
      currentId = ranges[markedIndex]?.id;
      continue;
    }
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: string }).type === "endMarkedContent"
    ) {
      currentId = undefined;
      continue;
    }
    if (!currentId || !isPdfTextItem(item) || !item.str) continue;
    const layerItems = result.get(currentId) ?? [];
    layerItems.push(item);
    result.set(currentId, layerItems);
  }
  return result;
}

function pdfFontFamily(
  pdfPage: { commonObjs: { get: (id: string) => { name?: string } } },
  id: string,
): string {
  try {
    return (pdfPage.commonObjs.get(id).name ?? "Arial").replace(/^[A-Z]{6}\+/, "");
  } catch {
    return "Arial";
  }
}

function pdfTextItemEdges(item: PdfTextItem): {
  left: number;
  center: number;
  right: number;
} {
  const left = item.transform[4] ?? 0;
  const right = left + item.width;
  return { left, center: (left + right) / 2, right };
}

export function shouldMergePdfText(previous: PdfTextItem, next: PdfTextItem): boolean {
  const previousX = previous.transform[4] ?? 0;
  const previousY = previous.transform[5] ?? 0;
  const nextX = next.transform[4] ?? 0;
  const nextY = next.transform[5] ?? 0;
  const previousEdges = pdfTextItemEdges(previous);
  const nextEdges = pdfTextItemEdges(next);
  const alignmentTolerance = Math.max(previous.height, next.height) * 0.35 + 2;
  const sameParagraphAlignment =
    Math.abs(previousEdges.left - nextEdges.left) <= alignmentTolerance ||
    Math.abs(previousEdges.center - nextEdges.center) <= alignmentTolerance ||
    Math.abs(previousEdges.right - nextEdges.right) <= alignmentTolerance;
  const lineGap = Math.abs(previousY - nextY);
  const closeLine = lineGap <= Math.max(previous.height, next.height) * 2.25;
  const sameBaseline = lineGap <= 2;
  const adjacent = nextX <= previousX + previous.width + Math.max(previous.height, next.height);
  return Boolean(
    (previous.hasEOL && sameParagraphAlignment && closeLine) ||
      (sameBaseline && adjacent),
  );
}

export function pdfTextAlignment(
  items: PdfTextItem[],
): "left" | "center" | "right" {
  const lines: Array<{ y: number; left: number; right: number; height: number }> = [];
  for (const item of items) {
    const edges = pdfTextItemEdges(item);
    const line = lines.find((candidate) => Math.abs(candidate.y - (item.transform[5] ?? 0)) <= 2);
    if (line) {
      line.left = Math.min(line.left, edges.left);
      line.right = Math.max(line.right, edges.right);
      line.height = Math.max(line.height, item.height);
    } else {
      lines.push({
        y: item.transform[5] ?? 0,
        left: edges.left,
        right: edges.right,
        height: item.height,
      });
    }
  }
  if (lines.length < 2) return "left";
  const spreads = {
    left: Math.max(...lines.map((line) => line.left)) - Math.min(...lines.map((line) => line.left)),
    center:
      Math.max(...lines.map((line) => (line.left + line.right) / 2)) -
      Math.min(...lines.map((line) => (line.left + line.right) / 2)),
    right:
      Math.max(...lines.map((line) => line.right)) - Math.min(...lines.map((line) => line.right)),
  };
  const tolerance = Math.max(6, Math.max(...lines.map((line) => line.height)) * 0.35);
  const alignment = (Object.entries(spreads) as Array<
    ["left" | "center" | "right", number]
  >).sort((left, right) => left[1] - right[1])[0];
  return alignment && alignment[1] <= tolerance ? alignment[0] : "left";
}

export function pdfTextNodes(
  pdfPage: {
    view: number[];
    commonObjs: { get: (id: string) => { name?: string } };
  },
  items: PdfTextItem[],
  styles: PdfTextStyle[],
  report: ReturnType<typeof createReport>,
): IRNode[] {
  const clusters: Array<Array<{ item: PdfTextItem; style: PdfTextStyle }>> = [];
  for (const [index, item] of items.entries()) {
    const style = styles[Math.min(index, Math.max(0, styles.length - 1))] ?? {
      fill: hexToColor("#000000"),
      opacity: 1,
    };
    const current = clusters[clusters.length - 1];
    if (current && shouldMergePdfText(current[current.length - 1]!.item, item)) {
      current.push({ item, style });
    } else {
      clusters.push([{ item, style }]);
    }
  }

  const pageHeight = (pdfPage.view[3] ?? 0) - (pdfPage.view[1] ?? 0);
  return clusters.map((cluster) => {
    let characters = "";
    const runs: TextStyleRun[] = [];
    const baselines: number[] = [];
    const lineIndexes = new Map<PdfTextItem, number>();
    for (const { item } of cluster) {
      const baseline = item.transform[5] ?? 0;
      const lineIndex = baselines.findIndex((value) => Math.abs(value - baseline) <= 2);
      if (lineIndex >= 0) {
        lineIndexes.set(item, lineIndex);
      } else {
        lineIndexes.set(item, baselines.length);
        baselines.push(baseline);
      }
    }
    const lineHeights = baselines.map((baseline, index) => {
      const adjacentBaseline = baselines[index + 1] ?? baselines[index - 1];
      return adjacentBaseline === undefined
        ? undefined
        : Math.abs(baseline - adjacentBaseline);
    });
    const boxes = cluster.map(({ item }) => {
      const x = item.transform[4] ?? 0;
      const y = pageHeight - (item.transform[5] ?? 0) - item.height;
      return { x, y, right: x + item.width, bottom: y + item.height };
    });
    let previous: PdfTextItem | undefined;
    for (const { item, style } of cluster) {
      if (previous && Math.abs((previous.transform[5] ?? 0) - (item.transform[5] ?? 0)) > 2) {
        characters += "\n";
        const previousRun = runs[runs.length - 1];
        if (previousRun) previousRun.end = characters.length;
      }
      const start = characters.length;
      characters += item.str;
      const fontFamily = pdfFontFamily(pdfPage, item.fontName);
      const lineHeight = lineHeights[lineIndexes.get(item) ?? 0];
      runs.push({
        start,
        end: characters.length,
        fontFamily,
        fontStyle: /bold/i.test(fontFamily) ? "Bold" : "Regular",
        fontSize: item.height,
        lineHeight:
          lineHeight === undefined
            ? item.height * 1.2
            : Math.max(item.height, lineHeight),
        fills: [{ type: "solid", color: style.fill }],
      });
      previous = item;
    }
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    const first = cluster[0]!;
    const firstFont = pdfFontFamily(pdfPage, first.item.fontName);
    report.editableNodes += 1;
    return {
      id: createId("text"),
      name: characters.slice(0, 100) || "Text",
      type: "text",
      x: left,
      y: top,
      width: Math.max(first.item.height, right - left),
      height: Math.max(first.item.height, bottom - top),
      rotation: (-Math.atan2(first.item.transform[1] ?? 0, first.item.transform[0] ?? 1) * 180) / Math.PI,
      opacity: first.style.opacity,
      blendMode: first.style.blendMode,
      characters,
      fontFamily: firstFont,
      fontStyle: /bold/i.test(firstFont) ? "Bold" : "Regular",
      fontSize: first.item.height,
      lineHeight: "auto",
      textAlignHorizontal: pdfTextAlignment(cluster.map(({ item }) => item)),
      textAlignVertical: "top",
      fills: [{ type: "solid", color: first.style.fill }],
      runs,
    } satisfies IRNode;
  });
}

export interface ConvertedPdfPath {
  paintOperator: number;
  pathOperators: number[];
  pathArguments: number[];
  minMax: number[] | null;
}

function numericArray(value: unknown): number[] | undefined {
  if (Array.isArray(value)) return value.map(Number);
  if (
    ArrayBuffer.isView(value) &&
    "length" in value &&
    typeof value.length === "number"
  ) {
    return Array.from(value as unknown as ArrayLike<number>, Number);
  }
  return undefined;
}

export function convertPdfJs6ConstructPath(
  args: unknown,
  ops: Record<string, number>,
): ConvertedPdfPath {
  if (!Array.isArray(args) || typeof args[0] !== "number" || !Array.isArray(args[1])) {
    throw new Error("Unsupported PDF path data.");
  }

  const paintOperator = args[0];
  const pathOperators: number[] = [];
  const pathArguments: number[] = [];
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;

  const append = (name: string, coordinates: number[]): void => {
    const operator = ops[name];
    if (typeof operator !== "number") throw new Error(`Missing PDF operator: ${name}.`);
    pathOperators.push(operator);
    pathArguments.push(...coordinates);
  };

  for (const rawBuffer of args[1]) {
    if (rawBuffer === null) continue;
    const buffer = numericArray(rawBuffer);
    if (!buffer) throw new Error("Unsupported PDF path buffer.");
    let index = 0;
    const take = (count: number): number[] => {
      if (index + count > buffer.length) throw new Error("Truncated PDF path data.");
      const values = buffer.slice(index, index + count);
      index += count;
      return values;
    };

    while (index < buffer.length) {
      const drawOperator = buffer[index++];
      if (drawOperator === 0) {
        const [x = 0, y = 0] = take(2);
        append("moveTo", [x, y]);
        currentX = startX = x;
        currentY = startY = y;
      } else if (drawOperator === 1) {
        const [x = 0, y = 0] = take(2);
        append("lineTo", [x, y]);
        currentX = x;
        currentY = y;
      } else if (drawOperator === 2) {
        const coordinates = take(6);
        append("curveTo", coordinates);
        currentX = coordinates[4] ?? currentX;
        currentY = coordinates[5] ?? currentY;
      } else if (drawOperator === 3) {
        const [controlX = 0, controlY = 0, x = 0, y = 0] = take(4);
        append("curveTo", [
          currentX + (2 / 3) * (controlX - currentX),
          currentY + (2 / 3) * (controlY - currentY),
          x + (2 / 3) * (controlX - x),
          y + (2 / 3) * (controlY - y),
          x,
          y,
        ]);
        currentX = x;
        currentY = y;
      } else if (drawOperator === 4) {
        append("closePath", []);
        currentX = startX;
        currentY = startY;
      } else {
        throw new Error(`Unsupported PDF drawing operator: ${String(drawOperator)}.`);
      }
    }
  }

  const modernMinMax = numericArray(args[2]);
  const minMax = modernMinMax && modernMinMax.length >= 4
    ? [modernMinMax[0]!, modernMinMax[2]!, modernMinMax[1]!, modernMinMax[3]!]
    : null;
  return { paintOperator, pathOperators, pathArguments, minMax };
}

function vectorOperatorList(
  operatorList: PdfOperatorList,
  range: PdfLayerRange,
  ops: Record<string, number>,
): PdfOperatorList {
  const imageOperators = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  const filteredFunctions: number[] = [];
  const filteredArguments: unknown[] = [];
  let inText = false;
  for (let index = range.start; index < range.end; index += 1) {
    const operator = operatorList.fnArray[index]!;
    if (operator === ops.beginText) {
      inText = true;
      continue;
    }
    if (operator === ops.endText) {
      inText = false;
      continue;
    }
    if (inText || imageOperators.has(operator)) continue;
    if (operator === ops.dependency) {
      const dependencies = Array.isArray(operatorList.argsArray[index])
        ? operatorList.argsArray[index] as unknown[]
        : [];
      if (dependencies.every((dependency) => String(dependency).startsWith("img_"))) continue;
    }
    if (operator === ops.constructPath) {
      const converted = convertPdfJs6ConstructPath(operatorList.argsArray[index], ops);
      if (converted.pathOperators.length > 0) {
        filteredFunctions.push(operator);
        filteredArguments.push([
          converted.pathOperators,
          converted.pathArguments,
          converted.minMax,
        ]);
      }
      filteredFunctions.push(converted.paintOperator);
      filteredArguments.push(null);
      continue;
    }
    filteredFunctions.push(operator);
    filteredArguments.push(operatorList.argsArray[index]);
  }

  const fnArray: number[] = [];
  const argsArray: unknown[] = [];
  let depth = 0;
  for (const [index, operator] of filteredFunctions.entries()) {
    if (operator === ops.restore && depth === 0) continue;
    fnArray.push(operator);
    argsArray.push(filteredArguments[index]);
    if (operator === ops.save) depth += 1;
    if (operator === ops.restore) depth -= 1;
  }
  while (depth > 0) {
    fnArray.push(ops.restore!);
    argsArray.push(null);
    depth -= 1;
  }
  return { fnArray, argsArray, lastChunk: true };
}

function hasVectorPaint(operatorList: PdfOperatorList, ops: Record<string, number>): boolean {
  const visible = new Set([
    ops.stroke,
    ops.closeStroke,
    ops.fill,
    ops.eoFill,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
    ops.shadingFill,
  ]);
  return operatorList.fnArray.some((operator) => visible.has(operator));
}

export function normalizePdfSvgMarkup(markup: string): string {
  const normalized = markup
    .replace(/<(\/?)svg:/g, "<$1")
    .replace(/\sxmlns:svg="[^"]*"/g, "");
  if (/<svg\b[^>]*\sxmlns="[^"]*"/i.test(normalized)) return normalized;
  return normalized.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
}

export function extractPdfGradientFill(
  operatorList: PdfOperatorList,
  range: Pick<PdfLayerRange, "start" | "end">,
  ops: Record<string, number>,
  getPattern: (id: string) => unknown,
  width: number,
  height: number,
): Paint | undefined {
  const otherPaintOperators = new Set([
    ops.stroke,
    ops.closeStroke,
    ops.fill,
    ops.eoFill,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ]);
  let matrix: Matrix = [...IDENTITY_MATRIX];
  const matrixStack: Matrix[] = [];
  let gradient: Paint | undefined;
  let shadingCount = 0;

  for (let index = range.start; index < range.end; index += 1) {
    const operator = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (otherPaintOperators.has(operator)) return undefined;
    if (operator === ops.save) {
      matrixStack.push([...matrix]);
      continue;
    }
    if (operator === ops.restore) {
      matrix = matrixStack.pop() ?? [...IDENTITY_MATRIX];
      continue;
    }
    if (operator === ops.transform) {
      const values = numericArray(args);
      if (values && values.length >= 6) {
        matrix = multiplyMatrix(matrix, values.slice(0, 6) as Matrix);
      }
      continue;
    }
    if (operator !== ops.shadingFill) continue;
    shadingCount += 1;
    const values = Array.isArray(args) ? args : [];
    const patternId = values[0];
    const pattern =
      typeof patternId === "string" ? getPattern(patternId) : patternId;
    if (
      !Array.isArray(pattern) ||
      pattern[0] !== "RadialAxial" ||
      pattern[1] !== "axial"
    ) {
      return undefined;
    }
    const rawStops = Array.isArray(pattern[3]) ? pattern[3] : [];
    const start = numericArray(pattern[4]) ?? [0, 0];
    const end = numericArray(pattern[5]) ?? [1, 0];
    const startPoint = transformPoint(matrix, start[0] ?? 0, start[1] ?? 0);
    const endPoint = transformPoint(matrix, end[0] ?? 1, end[1] ?? 0);
    gradient = {
      type: "gradient",
      gradientType: "linear",
      stops: rawStops.flatMap((rawStop) => {
        if (!Array.isArray(rawStop)) return [];
        const color = parseColor(String(rawStop[1] ?? "#000000"));
        if (!color) return [];
        return [{
          position: Math.max(0, Math.min(1, Number(rawStop[0]) || 0)),
          color,
        }];
      }),
      start: {
        x: startPoint.x / Math.max(width, 1),
        y: 1 - startPoint.y / Math.max(height, 1),
      },
      end: {
        x: endPoint.x / Math.max(width, 1),
        y: 1 - endPoint.y / Math.max(height, 1),
      },
    };
  }

  return shadingCount === 1 ? gradient : undefined;
}

export function gradientPaintsWithFallback(fill: Paint): Paint[] {
  if (fill.type !== "gradient" || !fill.stops[0]) return [fill];
  return [
    fill,
    {
      type: "solid",
      color: fill.stops[0].color,
      opacity: fill.opacity,
    },
  ];
}

function pdfGradientNode(
  pdfPage: { objs: PdfObjectPool },
  operatorList: PdfOperatorList,
  range: PdfLayerRange,
  ops: Record<string, number>,
  width: number,
  height: number,
): IRNode | undefined {
  const fill = extractPdfGradientFill(
    operatorList,
    range,
    ops,
    (id) => pdfPage.objs.get(id),
    width,
    height,
  );
  if (!fill) return undefined;
  return {
    id: createId("gradient"),
    name: `${range.name} Gradient`,
    type: "rectangle",
    x: 0,
    y: 0,
    width,
    height,
    fills: gradientPaintsWithFallback(fill),
  };
}

async function pdfVectorNode(
  pdfPage: {
    commonObjs: PdfObjectPool;
    objs: PdfObjectPool;
    getViewport: (options: { scale: number }) => PdfViewport;
  },
  operatorList: PdfOperatorList,
  range: PdfLayerRange,
  ops: Record<string, number>,
  width: number,
  height: number,
): Promise<IRNode | undefined> {
  const vectorOps = vectorOperatorList(operatorList, range, ops);
  if (!hasVectorPaint(vectorOps, ops)) return undefined;
  const graphics = new PdfSvgGraphics(pdfPage.commonObjs, pdfPage.objs, ops);
  const svg = await graphics.getSVG(vectorOps, pdfPage.getViewport({ scale: 1 }));
  const markup = normalizePdfSvgMarkup(
    new XMLSerializer().serializeToString(
      svg as unknown as Parameters<XMLSerializer["serializeToString"]>[0],
    ),
  );
  return {
    id: createId("svg"),
    name: `${range.name} Vector`,
    type: "svg",
    x: 0,
    y: 0,
    width,
    height,
    markup,
  };
}

async function parsePdfRasterFallback(
  source: Uint8Array | Blob,
  sourceName: string,
  options: ParseOptions,
  callbacks: IllustratorParseCallbacks,
): Promise<IRDocument> {
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
  const sourceByteSize = source instanceof Blob ? source.size : source.byteLength;
  const workerUrl = URL.createObjectURL(new Blob([pdfWorkerSource], { type: "text/javascript" }));
  const sourceUrl = source instanceof Blob ? URL.createObjectURL(source) : undefined;
  GlobalWorkerOptions.workerSrc = workerUrl;
  const loadingTask = sourceUrl
    ? getDocument({ url: sourceUrl })
    : getDocument({ data: source as Uint8Array });
  const report = createReport(sourceName.toLowerCase().endsWith(".ai") ? "ai" : "pdf", sourceName);
  const assets: Asset[] = [];
  const pages: ContainerNode[] = [];
  const baseName = sourceBaseName(sourceName);

  callbacks.onProgress?.({ phase: "loading", page: 0, pageCount: 0, progress: 0 });
  try {
    const pdf = await loadingTask.promise;
    callbacks.onProgress?.({ phase: "loading", page: 0, pageCount: pdf.numPages, progress: 0 });

    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
      const pdfPage = await pdf.getPage(pageIndex);
      const viewport = pdfPage.getViewport({ scale: PDF_RASTER_SCALE });
      const rasterWidth = Math.ceil(viewport.width);
      const rasterHeight = Math.ceil(viewport.height);
      const tiles = calculateImageTiles(rasterWidth, rasterHeight);
      const children: IRNode[] = [];
      const pageLabel = String(pageIndex).padStart(2, "0");
      const tileCount = tiles.length;

      callbacks.onProgress?.({
        phase: "rendering",
        page: pageIndex,
        pageCount: pdf.numPages,
        progress: (pageIndex - 1) / pdf.numPages,
      });

      for (const [tileOffset, tile] of tiles.entries()) {
        const tileIndex = tileOffset + 1;
        const canvas = document.createElement("canvas");
        canvas.width = tile.width;
        canvas.height = tile.height;
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) throw new Error("Canvas rendering is unavailable.");

        await pdfPage.render({
          canvas,
          canvasContext,
          viewport,
          transform: [1, 0, 0, 1, -tile.x, -tile.y],
        }).promise;

        callbacks.onProgress?.({
          phase: "encoding",
          page: pageIndex,
          pageCount: pdf.numPages,
          progress: ((pageIndex - 1) + tileIndex / tileCount) / pdf.numPages,
        });
        const assetId = createId("asset");
        assets.push({
          id: assetId,
          name: `${pageLabel} ${baseName} ${String(tileIndex).padStart(2, "0")}.png`,
          mimeType: "image/png",
          data: await canvasToPngBytes(canvas),
          width: tile.width,
          height: tile.height,
        });
        children.push({
          id: createId("image"),
          name: tileCount === 1 ? "01 视觉层" : `${String(tileIndex).padStart(2, "0")} 视觉分片`,
          type: "image",
          x: tile.x / PDF_RASTER_SCALE,
          y: tile.y / PDF_RASTER_SCALE,
          width: tile.width / PDF_RASTER_SCALE,
          height: tile.height / PDF_RASTER_SCALE,
          assetRef: assetId,
          scaleMode: "fill",
        });
        canvas.width = 1;
        canvas.height = 1;
      }

      pages.push({
        id: createId("artboard"),
        name: `${pageLabel} ${baseName}`,
        type: "frame",
        x: 0,
        y: 0,
        width: viewport.width / PDF_RASTER_SCALE,
        height: viewport.height / PDF_RASTER_SCALE,
        fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
        children,
        clipsContent: true,
      });
      pdfPage.cleanup();
    }
  } finally {
    await loadingTask.destroy();
    URL.revokeObjectURL(workerUrl);
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }

  report.parsedNodes = countNodes(pages);
  report.rasterizedNodes = pages.length;
  report.items.push({
    level: "fallback",
    code: "AI_PDF_FALLBACK",
    message:
      "PDF-compatible Illustrator artwork was preserved visually at 2x per artboard. Oversized images were tiled without scaling. Save as SVG to retain editable paths.",
  });

  return {
    version: IR_VERSION,
    source: {
      name: sourceName,
      format: sourceName.toLowerCase().endsWith(".ai") ? "ai" : "pdf",
      byteSize: sourceByteSize,
    },
    pages,
    assets,
    report,
  };
}

async function parsePdfHierarchy(
  source: Uint8Array | Blob,
  sourceName: string,
  callbacks: IllustratorParseCallbacks,
): Promise<IRDocument | undefined> {
  if (typeof document === "undefined") {
    throw new Error("PDF-compatible Illustrator files can only be rendered in the Figma plugin UI.");
  }

  const [modernModule, { default: modernWorkerSource }] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw"),
  ]);
  const sourceByteSize = source instanceof Blob ? source.size : source.byteLength;
  const sourceUrl = source instanceof Blob ? URL.createObjectURL(source) : undefined;
  const modernWorkerUrl = URL.createObjectURL(
    new Blob([modernWorkerSource], { type: "text/javascript" }),
  );
  modernModule.GlobalWorkerOptions.workerSrc = modernWorkerUrl;
  const report = createReport(sourceName.toLowerCase().endsWith(".ai") ? "ai" : "pdf", sourceName);
  const assets: Asset[] = [];
  const pages: ContainerNode[] = [];
  const baseName = sourceBaseName(sourceName);

  callbacks.onProgress?.({ phase: "loading", page: 0, pageCount: 0, progress: 0 });
  try {
    const modernLoading = sourceUrl
      ? modernModule.getDocument({ url: sourceUrl, fontExtraProperties: true })
      : modernModule.getDocument({
          data: (source as Uint8Array).slice(),
          fontExtraProperties: true,
        });
    let hasLayerHierarchy = false;
    try {
      const pdf = await modernLoading.promise;
      const optionalContentConfig = await pdf.getOptionalContentConfig();
      const extractionOptionalContentConfig = await pdf.getOptionalContentConfig();
      for (const [id] of extractionOptionalContentConfig) {
        extractionOptionalContentConfig.setVisibility(id, true, false);
      }
      const extractionOptionalContentConfigPromise = Promise.resolve(
        extractionOptionalContentConfig,
      );
      const order = optionalContentConfig.getOrder();
      hasLayerHierarchy = Array.isArray(order) && order.length > 0;
      if (!hasLayerHierarchy) return undefined;
      callbacks.onProgress?.({ phase: "loading", page: 0, pageCount: pdf.numPages, progress: 0 });

      for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
        callbacks.onProgress?.({
          phase: "rendering",
          page: pageIndex,
          pageCount: pdf.numPages,
          progress: ((pageIndex - 1) / pdf.numPages) * 0.65,
        });
        const pdfPage = await pdf.getPage(pageIndex);
        const [operatorList, textContent] = await Promise.all([
          pdfPage.getOperatorList(),
          pdfPage.getTextContent({ includeMarkedContent: true }),
        ]);
        const modernOps = modernModule.OPS as unknown as Record<string, number>;
        const ranges = pdfLayerRanges(
          operatorList as unknown as PdfOperatorList,
          optionalContentConfig,
          modernOps,
        );
        const textByLayer = pdfTextItemsByLayer(textContent.items as unknown[], ranges);
        const width = (pdfPage.view[2] ?? 0) - (pdfPage.view[0] ?? 0);
        const height = (pdfPage.view[3] ?? 0) - (pdfPage.view[1] ?? 0);
        const context: SvgContext = {
          width,
          height,
          assets,
          classStyles: new Map(),
          report,
        };
        const groups: IRNode[] = [];
        const gradientsByRange = new Map<PdfLayerRange, IRNode>();
        for (const range of ranges) {
          const gradient = pdfGradientNode(
            pdfPage as unknown as Parameters<typeof pdfGradientNode>[0],
            operatorList as unknown as PdfOperatorList,
            range,
            modernOps,
            width,
            height,
          );
          if (gradient) gradientsByRange.set(range, gradient);
        }
        const backgroundRange = gradientsByRange.keys().next().value as
          | PdfLayerRange
          | undefined;
        const maskRange = ranges.find(
          (range) =>
            pdfImageSegments(
              operatorList as unknown as PdfOperatorList,
              range,
              modernOps,
            ).some(
              (segment) =>
                segment.hasSoftMask && segment.blendMode === "hard-light",
            ),
        );
        const maskBackdrop =
          backgroundRange && maskRange && backgroundRange.start < maskRange.start
            ? await renderPdfRangeCanvas(
                pdfPage as unknown as Parameters<typeof renderPdfRangeCanvas>[0],
                [backgroundRange],
                extractionOptionalContentConfigPromise,
              )
            : undefined;
        const maskComposite =
          backgroundRange && maskRange && maskBackdrop
            ? await renderPdfRangeCanvas(
                pdfPage as unknown as Parameters<typeof renderPdfRangeCanvas>[0],
                [backgroundRange, maskRange],
                extractionOptionalContentConfigPromise,
              )
            : undefined;
        const maskOverlay =
          maskBackdrop && maskComposite
            ? transparentOverlayCanvas(maskBackdrop, maskComposite)
            : undefined;

        for (const range of ranges) {
          const children: IRNode[] = [];
          const gradient = gradientsByRange.get(range);
          if (gradient) {
            children.push(gradient);
            report.editableNodes += 1;
          } else {
            try {
              const vector = await pdfVectorNode(
                pdfPage as unknown as Parameters<typeof pdfVectorNode>[0],
                operatorList as unknown as PdfOperatorList,
                range,
                modernOps,
                width,
                height,
              );
              if (vector) {
                children.push(vector);
                report.editableNodes += 1;
              }
            } catch (error) {
              report.items.push({
                level: "warning",
                code: "AI_PDF_VECTOR_LAYER_FAILED",
                message:
                  error instanceof Error
                    ? `The vector portion of this layer could not be converted: ${error.message}`
                    : "The vector portion of this layer could not be converted.",
                nodeName: range.name,
              });
            }
          }
          children.push(
            ...(await renderPdfImageLayers(
              pdfPage as unknown as Parameters<typeof renderPdfImageLayers>[0],
              operatorList as unknown as PdfOperatorList,
              range,
              modernOps,
              assets,
              context,
              extractionOptionalContentConfigPromise,
              range === maskRange ? maskBackdrop : undefined,
              range === maskRange ? maskOverlay : undefined,
            )),
          );
          children.push(
            ...pdfTextNodes(
              pdfPage,
              textByLayer.get(range.id) ?? [],
              pdfTextStyles(operatorList as unknown as PdfOperatorList, range, modernOps),
              report,
            ),
          );
          if (children.length === 0) {
            report.items.push({
              level: "info",
              code: "AI_EMPTY_LAYER_PRESERVED",
              message:
                "This source layer has no visible PDF objects and was preserved as an editable empty Figma frame.",
              nodeName: range.name,
            });
          }
          report.editableNodes += 1;
          groups.push(pdfLayerNode(range, width, height, children));
        }
        if (maskBackdrop) {
          maskBackdrop.width = 1;
          maskBackdrop.height = 1;
        }
        if (maskComposite) {
          maskComposite.width = 1;
          maskComposite.height = 1;
        }

        pages.push({
          id: createId("artboard"),
          name: `${String(pageIndex).padStart(2, "0")} ${baseName}`,
          type: "frame",
          x: 0,
          y: 0,
          width,
          height,
          fills: [],
          children: groups,
          clipsContent: true,
        });
        pdfPage.cleanup();
      }
    } finally {
      await modernLoading.destroy();
    }

    if (!hasLayerHierarchy) return undefined;
  } finally {
    URL.revokeObjectURL(modernWorkerUrl);
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }

  report.parsedNodes = countNodes(pages);
  report.items.unshift({
    level: "info",
    code: "AI_PDF_HIERARCHY_IMPORT",
    message:
      "Illustrator PDF layers were preserved as same-named Figma Groups. Vector artwork, source images and editable text remain separated without wrapper Frames.",
  });
  return {
    version: IR_VERSION,
    source: {
      name: sourceName,
      format: sourceName.toLowerCase().endsWith(".ai") ? "ai" : "pdf",
      byteSize: sourceByteSize,
    },
    pages,
    assets,
    report,
  };
}

async function parsePdfFallback(
  source: Uint8Array | Blob,
  sourceName: string,
  options: ParseOptions,
  callbacks: IllustratorParseCallbacks,
): Promise<IRDocument> {
  if (options.textMode === "visual") {
    return parsePdfRasterFallback(source, sourceName, options, callbacks);
  }
  const hierarchy = await parsePdfHierarchy(source, sourceName, callbacks);
  if (hierarchy) return hierarchy;
  return parsePdfRasterFallback(source, sourceName, options, callbacks);
}

export async function parseIllustrator(
  input: ArrayBuffer | Uint8Array | Blob,
  sourceName: string,
  options: ParseOptions,
  callbacks: IllustratorParseCallbacks = {},
): Promise<IRDocument> {
  const blob = typeof Blob !== "undefined" && input instanceof Blob ? input : undefined;
  const bytes = blob
    ? new Uint8Array(await blob.slice(0, 512).arrayBuffer())
    : input instanceof Uint8Array
      ? input
      : new Uint8Array(input as ArrayBuffer);
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (header.startsWith("<svg") || header.startsWith("<?xml")) {
    const svgBytes = blob ? new Uint8Array(await blob.arrayBuffer()) : bytes;
    return parseSvg(svgBytes, sourceName);
  }
  if (header.startsWith("%PDF-")) {
    return parsePdfFallback(blob ?? bytes, sourceName, options, callbacks);
  }
  throw new Error(
    "This .ai file is neither SVG-compatible nor saved with PDF compatibility. Re-save it with Create PDF Compatible File enabled.",
  );
}
