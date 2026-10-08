import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
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
  type ShapeNode,
  type Stroke,
  type TextNode,
} from "@easy-to-figma/ir-schema";

type XmlNode = Record<string, unknown>;
type RelationshipMap = Map<string, string>;

const EMU_PER_PX = 9525;
const DEFAULT_SLIDE_WIDTH = 1280;
const DEFAULT_SLIDE_HEIGHT = 720;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: false,
});

const orderedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  preserveOrder: true,
  trimValues: false,
});

function object(value: unknown): XmlNode {
  return value && typeof value === "object" ? (value as XmlNode) : {};
}

function array<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function emu(value: unknown): number {
  return numberValue(value) / EMU_PER_PX;
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function child(node: unknown, key: string): unknown {
  return object(node)[key];
}

function parseXml(xml: string): XmlNode {
  return object(xmlParser.parse(xml));
}

function findOrderedChildren(value: unknown, key: string): XmlNode[] | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findOrderedChildren(entry, key);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as XmlNode;
  const direct = record[key];
  if (Array.isArray(direct)) return direct.map(object);
  for (const nested of Object.values(record)) {
    const result = findOrderedChildren(nested, key);
    if (result) return result;
  }
  return undefined;
}

function normalizeZipPath(basePath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = `${basePath.slice(0, basePath.lastIndexOf("/") + 1)}${target}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

function extensionMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function readRelationships(zip: JSZip, sourcePath: string): Promise<RelationshipMap> {
  const slash = sourcePath.lastIndexOf("/");
  const relsPath = `${sourcePath.slice(0, slash + 1)}_rels/${sourcePath.slice(slash + 1)}.rels`;
  const xml = await zip.file(relsPath)?.async("string");
  const result = new Map<string, string>();
  if (!xml) return result;

  const parsed = parseXml(xml);
  const relationships = array(child(child(parsed, "Relationships"), "Relationship"));
  for (const rawRelationship of relationships) {
    const relationship = object(rawRelationship);
    const id = textValue(relationship.Id);
    const target = textValue(relationship.Target);
    if (id && target) result.set(id, normalizeZipPath(sourcePath, target));
  }
  return result;
}

function readTransform(node: unknown): { x: number; y: number; width: number; height: number; rotation: number } {
  const transform = object(node);
  const offset = object(transform.off);
  const extent = object(transform.ext);
  return {
    x: emu(offset.x),
    y: emu(offset.y),
    width: Math.max(1, emu(extent.cx)),
    height: Math.max(1, emu(extent.cy)),
    rotation: numberValue(transform.rot) / 60000,
  };
}

function readGroupTransform(node: unknown): {
  frame: { x: number; y: number; width: number; height: number; rotation: number };
  childOrigin: { x: number; y: number };
  childScale: { x: number; y: number };
} {
  const transform = object(node);
  const frame = readTransform(transform);
  const childOffset = object(transform.chOff);
  const childExtent = object(transform.chExt);
  const childWidth = Math.max(1, emu(childExtent.cx) || frame.width);
  const childHeight = Math.max(1, emu(childExtent.cy) || frame.height);
  return {
    frame,
    childOrigin: { x: emu(childOffset.x), y: emu(childOffset.y) },
    childScale: {
      x: frame.width / childWidth,
      y: frame.height / childHeight,
    },
  };
}

function resolveColor(fill: unknown, theme: Record<string, string>): Color | undefined {
  const value = object(fill);
  const srgb = object(value.srgbClr);
  const scheme = object(value.schemeClr);
  const preset = object(value.prstClr);
  const hex =
    textValue(srgb.val) ||
    theme[textValue(scheme.val)] ||
    ({ white: "FFFFFF", black: "000000", transparent: "FFFFFF" }[textValue(preset.val)] ?? "");

  if (!hex) return undefined;
  const alphaNode = object(srgb.alpha ?? scheme.alpha);
  const alpha = alphaNode.val ? numberValue(alphaNode.val, 100000) / 100000 : 1;
  return hexToColor(hex, alpha);
}

function readPaint(shapeProperties: unknown, theme: Record<string, string>): Paint[] {
  const properties = object(shapeProperties);
  if (properties.noFill !== undefined) return [];
  const color = resolveColor(properties.solidFill, theme);
  return color ? [{ type: "solid", color }] : [];
}

function readStroke(shapeProperties: unknown, theme: Record<string, string>): Stroke[] {
  const line = object(child(shapeProperties, "ln"));
  if (!Object.keys(line).length || line.noFill !== undefined) return [];
  const color = resolveColor(line.solidFill, theme) ?? hexToColor("000000");
  return [
    {
      color,
      width: Math.max(0.5, emu(line.w)),
    },
  ];
}

function collectText(textBody: unknown): string {
  const paragraphs = array(child(textBody, "p"));
  return paragraphs
    .map((rawParagraph) => {
      const paragraph = object(rawParagraph);
      const runs = array(paragraph.r);
      const runText = runs.map((run) => textValue(child(run, "t"))).join("");
      const fields = array(paragraph.fld).map((field) => textValue(child(field, "t"))).join("");
      return runText || fields || textValue(paragraph.t);
    })
    .join("\n");
}

function readTextStyle(textBody: unknown, theme: Record<string, string>): Partial<TextNode> {
  const firstParagraph = object(array(child(textBody, "p"))[0]);
  const firstRun = object(array(firstParagraph.r)[0]);
  const runProperties = object(firstRun.rPr ?? child(firstParagraph, "endParaRPr"));
  const paragraphProperties = object(firstParagraph.pPr);
  const alignments: Record<string, TextNode["textAlignHorizontal"]> = {
    ctr: "center",
    r: "right",
    just: "justified",
    l: "left",
  };
  const result: Partial<TextNode> = {
    fontFamily:
      textValue(child(runProperties.latin, "typeface")) ||
      textValue(child(runProperties.ea, "typeface")) ||
      "Arial",
    fontStyle: runProperties.b === "1" || runProperties.b === 1 ? "Bold" : "Regular",
    fontSize: Math.max(1, numberValue(runProperties.sz, 1800) / 100),
    textAlignHorizontal: alignments[textValue(paragraphProperties.algn)] ?? "left",
    textAlignVertical: "top",
  };
  const color = resolveColor(runProperties.solidFill, theme);
  if (color) result.fills = [{ type: "solid", color }];
  return result;
}

function shapeType(preset: string): ShapeNode["type"] {
  if (preset === "ellipse") return "ellipse";
  if (preset === "line" || preset.endsWith("Arrow")) return "line";
  if (preset.includes("triangle") || preset.includes("pentagon") || preset.includes("hexagon")) {
    return "polygon";
  }
  return "rectangle";
}

function parseShape(rawShape: unknown, theme: Record<string, string>): IRNode[] {
  const shape = object(rawShape);
  const properties = object(shape.spPr);
  const transform = readTransform(properties.xfrm);
  const nonVisual = object(child(shape.nvSpPr, "cNvPr"));
  const name = textValue(nonVisual.name) || "Shape";
  const preset = textValue(child(properties.prstGeom, "prst")) || "rect";
  const textBody = shape.txBody;
  const text = collectText(textBody);
  const hasVisualShape = properties.noFill === undefined || Object.keys(object(properties.ln)).length > 0;
  const children: IRNode[] = [];

  if (hasVisualShape) {
    children.push({
      id: createId("shape"),
      name,
      type: shapeType(preset),
      x: 0,
      y: 0,
      width: transform.width,
      height: transform.height,
      rotation: transform.rotation,
      fills: readPaint(properties, theme),
      strokes: readStroke(properties, theme),
      cornerRadius: preset === "roundRect" ? Math.min(transform.width, transform.height) * 0.12 : undefined,
      pointCount: preset.includes("hexagon") ? 6 : preset.includes("pentagon") ? 5 : 3,
    });
  }

  if (text) {
    children.push({
      id: createId("text"),
      name: `${name} Text`,
      type: "text",
      x: 0,
      y: 0,
      width: transform.width,
      height: transform.height,
      rotation: transform.rotation,
      characters: text,
      ...readTextStyle(textBody, theme),
      fills: readTextStyle(textBody, theme).fills ?? [{ type: "solid", color: hexToColor("111111") }],
    });
  }

  if (children.length === 1) {
    const onlyChild = children[0];
    if (!onlyChild) return [];
    onlyChild.x = transform.x;
    onlyChild.y = transform.y;
    return [onlyChild];
  }

  if (!children.length) return [];
  return [
    {
      id: createId("group"),
      name,
      type: "group",
      x: transform.x,
      y: transform.y,
      width: transform.width,
      height: transform.height,
      rotation: transform.rotation,
      children,
    },
  ];
}

async function parsePicture(
  zip: JSZip,
  rawPicture: unknown,
  relationships: RelationshipMap,
  assets: Asset[],
): Promise<IRNode | undefined> {
  const picture = object(rawPicture);
  const properties = object(picture.spPr);
  const transform = readTransform(properties.xfrm);
  const nonVisual = object(child(picture.nvPicPr, "cNvPr"));
  const name = textValue(nonVisual.name) || "Image";
  const embedId = textValue(child(child(picture.blipFill, "blip"), "embed"));
  const target = relationships.get(embedId);
  if (!target) return undefined;
  const file = zip.file(target);
  if (!file) return undefined;

  const mimeType = extensionMimeType(target);
  const assetId = createId("asset");
  const bytes = await file.async("uint8array");
  assets.push({
    id: assetId,
    name: target.split("/").pop() ?? name,
    mimeType,
    data: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
  });

  return {
    id: createId("image"),
    name,
    type: "image",
    x: transform.x,
    y: transform.y,
    width: transform.width,
    height: transform.height,
    rotation: transform.rotation,
    assetRef: assetId,
    scaleMode: "fill",
  };
}

function parseTable(rawFrame: unknown, theme: Record<string, string>): IRNode | undefined {
  const frame = object(rawFrame);
  const transform = readTransform(child(frame.xfrm, "off") ? frame.xfrm : child(frame, "xfrm"));
  const table = object(child(child(frame.graphic, "graphicData"), "tbl"));
  const rows = array(table.tr);
  if (!rows.length) return undefined;
  const rowHeight = transform.height / rows.length;
  const columnCount = Math.max(1, ...rows.map((row) => array(child(row, "tc")).length));
  const columnWidth = transform.width / columnCount;
  const children: IRNode[] = [];

  rows.forEach((rawRow, rowIndex) => {
    array(child(rawRow, "tc")).forEach((rawCell, columnIndex) => {
      const cell = object(rawCell);
      const x = columnIndex * columnWidth;
      const y = rowIndex * rowHeight;
      children.push({
        id: createId("cell"),
        name: `Cell ${rowIndex + 1}.${columnIndex + 1}`,
        type: "rectangle",
        x,
        y,
        width: columnWidth,
        height: rowHeight,
        fills: [{ type: "solid", color: hexToColor("FFFFFF") }],
        strokes: [{ color: hexToColor("D9D9D9"), width: 1 }],
      });
      const text = collectText(cell.txBody);
      if (text) {
        children.push({
          id: createId("cell-text"),
          name: `Cell ${rowIndex + 1}.${columnIndex + 1} Text`,
          type: "text",
          x: x + 6,
          y: y + 4,
          width: Math.max(1, columnWidth - 12),
          height: Math.max(1, rowHeight - 8),
          characters: text,
          ...readTextStyle(cell.txBody, theme),
          fills: [{ type: "solid", color: hexToColor("222222") }],
        });
      }
    });
  });

  return {
    id: createId("table"),
    name: "Table",
    type: "group",
    x: transform.x,
    y: transform.y,
    width: transform.width,
    height: transform.height,
    children,
  };
}

function scaleGroupChild(
  node: IRNode,
  origin: { x: number; y: number },
  scale: { x: number; y: number },
): IRNode {
  return {
    ...node,
    x: (node.x - origin.x) * scale.x,
    y: (node.y - origin.y) * scale.y,
    width: node.width * scale.x,
    height: node.height * scale.y,
  };
}

async function parseGroup(
  zip: JSZip,
  rawGroup: unknown,
  relationships: RelationshipMap,
  theme: Record<string, string>,
  assets: Asset[],
): Promise<IRNode> {
  const group = object(rawGroup);
  const nonVisual = object(child(group.nvGrpSpPr, "cNvPr"));
  const transform = readGroupTransform(child(group.grpSpPr, "xfrm"));
  const children: IRNode[] = [];

  for (const rawShape of array(group.sp)) {
    children.push(...parseShape(rawShape, theme));
  }
  for (const rawPicture of array(group.pic)) {
    const picture = await parsePicture(zip, rawPicture, relationships, assets);
    if (picture) children.push(picture);
  }
  for (const rawFrame of array(group.graphicFrame)) {
    const table = parseTable(rawFrame, theme);
    if (table) children.push(table);
  }
  for (const rawChildGroup of array(group.grpSp)) {
    children.push(await parseGroup(zip, rawChildGroup, relationships, theme, assets));
  }

  return {
    id: createId("group"),
    name: textValue(nonVisual.name) || "Group",
    type: "group",
    x: transform.frame.x,
    y: transform.frame.y,
    width: transform.frame.width,
    height: transform.frame.height,
    rotation: transform.frame.rotation,
    children: children.map((node) =>
      scaleGroupChild(node, transform.childOrigin, transform.childScale),
    ),
  };
}

async function readTheme(zip: JSZip): Promise<Record<string, string>> {
  const themeFile = zip.file("ppt/theme/theme1.xml");
  if (!themeFile) return {};
  const parsed = parseXml(await themeFile.async("string"));
  const scheme = object(child(child(child(parsed, "theme"), "themeElements"), "clrScheme"));
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(scheme)) {
    if (["name", "extLst"].includes(key)) continue;
    const value = object(rawValue);
    const colorNode = object(value.srgbClr ?? value.sysClr);
    const color = textValue(colorNode.val) || textValue(colorNode.lastClr);
    if (color) result[key] = color;
  }
  return result;
}

async function parseSlide(
  zip: JSZip,
  slidePath: string,
  index: number,
  size: { width: number; height: number },
  theme: Record<string, string>,
  assets: Asset[],
): Promise<ContainerNode> {
  const xml = await zip.file(slidePath)?.async("string");
  if (!xml) throw new Error(`Missing slide XML: ${slidePath}`);
  const relationships = await readRelationships(zip, slidePath);
  const parsed = parseXml(xml);
  const tree = object(child(child(child(parsed, "sld"), "cSld"), "spTree"));
  const children: IRNode[] = [];
  const orderedTree = orderedXmlParser.parse(xml);
  const orderedChildren = findOrderedChildren(orderedTree, "spTree") ?? [];
  const shapes = array(tree.sp);
  const pictures = array(tree.pic);
  const frames = array(tree.graphicFrame);
  const groups = array(tree.grpSp);
  const indexes = { sp: 0, pic: 0, graphicFrame: 0, grpSp: 0 };

  for (const entry of orderedChildren) {
    if ("sp" in entry) {
      children.push(...parseShape(shapes[indexes.sp], theme));
      indexes.sp += 1;
    } else if ("pic" in entry) {
      const picture = await parsePicture(zip, pictures[indexes.pic], relationships, assets);
      indexes.pic += 1;
      if (picture) children.push(picture);
    } else if ("graphicFrame" in entry) {
      const table = parseTable(frames[indexes.graphicFrame], theme);
      indexes.graphicFrame += 1;
      if (table) children.push(table);
    } else if ("grpSp" in entry) {
      children.push(
        await parseGroup(zip, groups[indexes.grpSp], relationships, theme, assets),
      );
      indexes.grpSp += 1;
    }
  }

  return {
    id: createId("slide"),
    name: `Slide ${index + 1}`,
    type: "frame",
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    fills: [{ type: "solid", color: hexToColor("FFFFFF") }],
    children,
    clipsContent: true,
  };
}

export async function parsePptx(
  input: ArrayBuffer | Uint8Array,
  sourceName: string,
  _options: ParseOptions,
): Promise<IRDocument> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const zip = await JSZip.loadAsync(bytes);
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  const presentation = presentationXml ? parseXml(presentationXml) : {};
  const slideSize = object(child(child(presentation, "presentation"), "sldSz"));
  const size = {
    width: slideSize.cx ? emu(slideSize.cx) : DEFAULT_SLIDE_WIDTH,
    height: slideSize.cy ? emu(slideSize.cy) : DEFAULT_SLIDE_HEIGHT,
  };
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((first, second) => {
      const firstNumber = numberValue(first.match(/slide(\d+)/)?.[1]);
      const secondNumber = numberValue(second.match(/slide(\d+)/)?.[1]);
      return firstNumber - secondNumber;
    });

  if (!slidePaths.length) throw new Error("This PPTX does not contain any slides.");

  const assets: Asset[] = [];
  const theme = await readTheme(zip);
  const pages: ContainerNode[] = [];
  for (const [index, slidePath] of slidePaths.entries()) {
    pages.push(await parseSlide(zip, slidePath, index, size, theme, assets));
  }

  const report = createReport("pptx", sourceName);
  report.parsedNodes = countNodes(pages);
  report.editableNodes = report.parsedNodes;
  report.items.push({
    level: "info",
    code: "PPTX_IMPORT",
    message: `${pages.length} slide${pages.length === 1 ? "" : "s"} parsed into editable Figma layers.`,
  });

  return {
    version: IR_VERSION,
    source: { name: sourceName, format: "pptx", byteSize: bytes.byteLength },
    pages,
    assets,
    report,
  };
}
