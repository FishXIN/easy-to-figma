export const IR_VERSION = "0.1.0" as const;

export type SourceFormat = "pptx" | "psd" | "ai" | "svg" | "pdf";
export type NodeType =
  | "frame"
  | "group"
  | "text"
  | "rectangle"
  | "ellipse"
  | "polygon"
  | "vector"
  | "image"
  | "line"
  | "booleanGroup";

export interface Color {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface SolidPaint {
  type: "solid";
  color: Color;
  opacity?: number;
}

export interface ImagePaint {
  type: "image";
  assetRef: string;
  scaleMode?: "fill" | "fit" | "crop" | "tile";
  opacity?: number;
}

export type Paint = SolidPaint | ImagePaint;

export interface Stroke {
  color: Color;
  width: number;
  opacity?: number;
  dashPattern?: number[];
}

export interface DropShadowEffect {
  type: "dropShadow";
  color: Color;
  offset: { x: number; y: number };
  radius: number;
  spread?: number;
  visible?: boolean;
}

export interface BlurEffect {
  type: "layerBlur";
  radius: number;
  visible?: boolean;
}

export type Effect = DropShadowEffect | BlurEffect;

export interface BaseNode {
  id: string;
  name: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
  fills?: Paint[];
  strokes?: Stroke[];
  effects?: Effect[];
  locked?: boolean;
}

export interface ContainerNode extends BaseNode {
  type: "frame" | "group" | "booleanGroup";
  children: IRNode[];
  clipsContent?: boolean;
  cornerRadius?: number;
}

export interface TextNode extends BaseNode {
  type: "text";
  characters: string;
  fontFamily?: string;
  fontStyle?: string;
  fontSize?: number;
  lineHeight?: number | "auto";
  letterSpacing?: number;
  textAlignHorizontal?: "left" | "center" | "right" | "justified";
  textAlignVertical?: "top" | "center" | "bottom";
  textCase?: "original" | "upper" | "lower" | "title";
  textDecoration?: "none" | "underline" | "strikethrough";
}

export interface ShapeNode extends BaseNode {
  type: "rectangle" | "ellipse" | "polygon" | "line";
  cornerRadius?: number;
  pointCount?: number;
}

export interface VectorPath {
  data: string;
  windingRule?: "nonzero" | "evenodd";
}

export interface VectorNode extends BaseNode {
  type: "vector";
  vectorPaths: VectorPath[];
}

export interface ImageNode extends BaseNode {
  type: "image";
  assetRef: string;
  scaleMode?: "fill" | "fit" | "crop" | "tile";
}

export type IRNode = ContainerNode | TextNode | ShapeNode | VectorNode | ImageNode;

export interface Asset {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  width?: number;
  height?: number;
}

export type ReportLevel = "info" | "warning" | "fallback" | "error";

export interface ReportItem {
  level: ReportLevel;
  code: string;
  message: string;
  nodeName?: string;
  pageName?: string;
}

export interface ImportReport {
  sourceFormat: SourceFormat;
  sourceName: string;
  parsedNodes: number;
  editableNodes: number;
  rasterizedNodes: number;
  skippedNodes: number;
  missingFonts: string[];
  items: ReportItem[];
}

export interface IRDocument {
  version: typeof IR_VERSION;
  source: {
    name: string;
    format: SourceFormat;
    byteSize: number;
  };
  pages: ContainerNode[];
  assets: Asset[];
  report: ImportReport;
}

export interface ParseOptions {
  textMode: "editable" | "visual";
  unsupportedStrategy: "rasterize" | "skip";
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  textMode: "editable",
  unsupportedStrategy: "rasterize",
};

let idCounter = 0;

export function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function createReport(format: SourceFormat, sourceName: string): ImportReport {
  return {
    sourceFormat: format,
    sourceName,
    parsedNodes: 0,
    editableNodes: 0,
    rasterizedNodes: 0,
    skippedNodes: 0,
    missingFonts: [],
    items: [],
  };
}

export function countNodes(nodes: IRNode[]): number {
  return nodes.reduce((total, node) => {
    if ("children" in node) {
      return total + 1 + countNodes(node.children);
    }
    return total + 1;
  }, 0);
}

export function hexToColor(input: string, alpha = 1): Color {
  const normalized = input.replace(/^#/, "").trim();
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => character + character)
          .join("")
      : normalized.padEnd(6, "0").slice(0, 6);

  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
    a: alpha,
  };
}
