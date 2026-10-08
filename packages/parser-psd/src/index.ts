import { readPsd } from "ag-psd";
import {
  IR_VERSION,
  countNodes,
  createId,
  createReport,
  hexToColor,
  type Asset,
  type ContainerNode,
  type IRDocument,
  type IRNode,
  type ParseOptions,
} from "@easy-to-figma/ir-schema";

interface PsdTextStyle {
  fontSize?: number;
  font?: { name?: string };
  fillColor?: { r?: number; g?: number; b?: number; a?: number };
  justification?: string;
}

interface PsdLayerLike {
  name?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  opacity?: number;
  hidden?: boolean;
  blendMode?: string;
  children?: PsdLayerLike[];
  canvas?: HTMLCanvasElement;
  imageData?: ImageData;
  text?: {
    text?: string;
    style?: PsdTextStyle;
    styleRuns?: Array<{ style?: PsdTextStyle }>;
  };
}

interface PsdLike {
  width: number;
  height: number;
  children?: PsdLayerLike[];
}

interface ParseContext {
  assets: Asset[];
  report: ReturnType<typeof createReport>;
  options: ParseOptions;
}

function bounds(layer: PsdLayerLike): { left: number; top: number; width: number; height: number } {
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  return {
    left,
    top,
    width: Math.max(1, (layer.right ?? left + 1) - left),
    height: Math.max(1, (layer.bottom ?? top + 1) - top),
  };
}

function groupBounds(children: PsdLayerLike[]): { left: number; top: number; width: number; height: number } {
  const visible = children.filter((layer) => layer.hidden !== true);
  if (!visible.length) return { left: 0, top: 0, width: 1, height: 1 };
  const childBounds = visible.map(bounds);
  const left = Math.min(...childBounds.map((value) => value.left));
  const top = Math.min(...childBounds.map((value) => value.top));
  const right = Math.max(...childBounds.map((value) => value.left + value.width));
  const bottom = Math.max(...childBounds.map((value) => value.top + value.height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function normalizeOpacity(value: number | undefined): number {
  if (value === undefined) return 1;
  return value > 1 ? value / 255 : value;
}

function colorChannel(value: number | undefined): number {
  if (value === undefined) return 0;
  return value > 1 ? value / 255 : value;
}

function textAlign(value: string | undefined): "left" | "center" | "right" | "justified" {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("center")) return "center";
  if (normalized.includes("right")) return "right";
  if (normalized.includes("justify")) return "justified";
  return "left";
}

function canvasFromLayer(layer: PsdLayerLike): HTMLCanvasElement | undefined {
  if (layer.canvas) return layer.canvas;
  if (!layer.imageData || typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = layer.imageData.width;
  canvas.height = layer.imageData.height;
  canvas.getContext("2d")?.putImageData(layer.imageData, 0, 0);
  return canvas;
}

function addRasterLayer(
  layer: PsdLayerLike,
  relativeTo: { left: number; top: number },
  context: ParseContext,
): IRNode | undefined {
  const canvas = canvasFromLayer(layer);
  if (!canvas) {
    context.report.skippedNodes += 1;
    context.report.items.push({
      level: "warning",
      code: "PSD_EMPTY_LAYER",
      message: "A layer had no renderable pixel data and was skipped.",
      nodeName: layer.name,
    });
    return undefined;
  }

  const layerBounds = bounds(layer);
  const assetId = createId("asset");
  context.assets.push({
    id: assetId,
    name: `${layer.name ?? "Layer"}.png`,
    mimeType: "image/png",
    data: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  });
  context.report.rasterizedNodes += 1;
  context.report.items.push({
    level: "fallback",
    code: "PSD_RASTER_LAYER",
    message: "Pixel content was preserved as an image fill.",
    nodeName: layer.name,
  });

  return {
    id: createId("image"),
    name: layer.name ?? "Pixel Layer",
    type: "image",
    x: layerBounds.left - relativeTo.left,
    y: layerBounds.top - relativeTo.top,
    width: layerBounds.width,
    height: layerBounds.height,
    opacity: normalizeOpacity(layer.opacity),
    visible: layer.hidden !== true,
    blendMode: layer.blendMode,
    assetRef: assetId,
    scaleMode: "fill",
  };
}

function addTextLayer(
  layer: PsdLayerLike,
  relativeTo: { left: number; top: number },
  context: ParseContext,
): IRNode | undefined {
  const characters = layer.text?.text ?? "";
  if (!characters) return undefined;
  const layerBounds = bounds(layer);
  const style = layer.text?.styleRuns?.[0]?.style ?? layer.text?.style ?? {};
  const fill = style.fillColor;
  context.report.editableNodes += 1;

  return {
    id: createId("text"),
    name: layer.name ?? "Text",
    type: "text",
    x: layerBounds.left - relativeTo.left,
    y: layerBounds.top - relativeTo.top,
    width: layerBounds.width,
    height: layerBounds.height,
    opacity: normalizeOpacity(layer.opacity),
    visible: layer.hidden !== true,
    blendMode: layer.blendMode,
    characters,
    fontFamily: style.font?.name ?? "Arial",
    fontStyle: "Regular",
    fontSize: Math.max(1, style.fontSize ?? 16),
    textAlignHorizontal: textAlign(style.justification),
    textAlignVertical: "top",
    fills: [
      {
        type: "solid",
        color: fill
          ? {
              r: colorChannel(fill.r),
              g: colorChannel(fill.g),
              b: colorChannel(fill.b),
              a: colorChannel(fill.a ?? 1),
            }
          : hexToColor("111111"),
      },
    ],
  };
}

function parseLayer(
  layer: PsdLayerLike,
  relativeTo: { left: number; top: number },
  context: ParseContext,
): IRNode | undefined {
  if (layer.children?.length) {
    const calculatedBounds = groupBounds(layer.children);
    const ownBounds = bounds(layer);
    const group = layer.right !== undefined && layer.bottom !== undefined ? ownBounds : calculatedBounds;
    const children = layer.children
      .map((childLayer) => parseLayer(childLayer, group, context))
      .filter((node): node is IRNode => node !== undefined);
    context.report.editableNodes += 1;
    return {
      id: createId("group"),
      name: layer.name ?? "Group",
      type: "group",
      x: group.left - relativeTo.left,
      y: group.top - relativeTo.top,
      width: group.width,
      height: group.height,
      opacity: normalizeOpacity(layer.opacity),
      visible: layer.hidden !== true,
      blendMode: layer.blendMode,
      children,
    };
  }

  if (layer.text && context.options.textMode === "editable") {
    return addTextLayer(layer, relativeTo, context);
  }

  if (context.options.unsupportedStrategy === "skip") {
    context.report.skippedNodes += 1;
    context.report.items.push({
      level: "warning",
      code: "PSD_LAYER_SKIPPED",
      message: "A non-editable PSD layer was skipped by the selected import strategy.",
      nodeName: layer.name,
    });
    return undefined;
  }

  return addRasterLayer(layer, relativeTo, context);
}

export async function parsePsd(
  input: ArrayBuffer | Uint8Array,
  sourceName: string,
  options: ParseOptions,
): Promise<IRDocument> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const psd = readPsd(bytes, {
    skipCompositeImageData: true,
    skipThumbnail: true,
    useImageData: false,
  }) as unknown as PsdLike;
  const report = createReport("psd", sourceName);
  const assets: Asset[] = [];
  const context: ParseContext = { assets, report, options };
  const root = { left: 0, top: 0 };
  const children = (psd.children ?? [])
    .map((layer) => parseLayer(layer, root, context))
    .filter((node): node is IRNode => node !== undefined);
  const page: ContainerNode = {
    id: createId("psd"),
    name: sourceName.replace(/\.psd$/i, "") || "PSD",
    type: "frame",
    x: 0,
    y: 0,
    width: Math.max(1, psd.width),
    height: Math.max(1, psd.height),
    fills: [{ type: "solid", color: hexToColor("FFFFFF") }],
    children,
    clipsContent: true,
  };

  report.parsedNodes = countNodes([page]);
  report.items.unshift({
    level: "info",
    code: "PSD_IMPORT",
    message: "PSD groups and text were preserved; pixel and unsupported effect layers use controlled image fallback.",
  });

  return {
    version: IR_VERSION,
    source: { name: sourceName, format: "psd", byteSize: bytes.byteLength },
    pages: [page],
    assets,
    report,
  };
}
