import {
  readPsd,
  type AdjustmentLayer,
  type BezierPath,
  type LayerMaskData,
  type LayerVectorMask,
} from "ag-psd";
import {
  IR_VERSION,
  countNodes,
  createId,
  createReport,
  hexToColor,
  type Asset,
  type ContainerNode,
  type ImageFilterValues,
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
  clipping?: boolean;
  children?: PsdLayerLike[];
  canvas?: HTMLCanvasElement;
  imageData?: ImageData;
  adjustment?: AdjustmentLayer;
  mask?: LayerMaskData;
  vectorMask?: LayerVectorMask;
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
  transparentAssetRef?: string;
}

interface LayerBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PsdAdjustmentMapping {
  filters: ImageFilterValues;
  mapped: string[];
  unsupported: string[];
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

function clampFilter(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function addFilter(
  filters: ImageFilterValues,
  key: keyof ImageFilterValues,
  value: number | undefined,
): void {
  if (value === undefined || !Number.isFinite(value)) return;
  filters[key] = clampFilter((filters[key] ?? 0) + value);
}

export function combineImageFilters(
  ...values: Array<ImageFilterValues | undefined>
): ImageFilterValues {
  const combined: ImageFilterValues = {};
  for (const filters of values) {
    if (!filters) continue;
    for (const key of Object.keys(filters) as Array<keyof ImageFilterValues>) {
      addFilter(combined, key, filters[key]);
    }
  }
  return combined;
}

function sampleCurve(
  points: Array<{ input: number; output: number }> | undefined,
  input: number,
): number {
  if (!points?.length) return input;
  const sorted = [...points].sort((left, right) => left.input - right.input);
  const lower = [...sorted].reverse().find((point) => point.input <= input) ?? sorted[0]!;
  const upper = sorted.find((point) => point.input >= input) ?? sorted[sorted.length - 1]!;
  if (upper.input === lower.input) return lower.output;
  const progress = (input - lower.input) / (upper.input - lower.input);
  return lower.output + (upper.output - lower.output) * progress;
}

function hasHueChannelAdjustment(
  channel: { hue: number; saturation: number; lightness: number } | undefined,
): boolean {
  return Boolean(channel && (channel.hue !== 0 || channel.saturation !== 0 || channel.lightness !== 0));
}

function hasColorBalanceAdjustment(
  values: { cyanRed: number; magentaGreen: number; yellowBlue: number } | undefined,
): values is { cyanRed: number; magentaGreen: number; yellowBlue: number } {
  return Boolean(
    values && (values.cyanRed !== 0 || values.magentaGreen !== 0 || values.yellowBlue !== 0),
  );
}

export function mapPsdAdjustment(adjustment: AdjustmentLayer): PsdAdjustmentMapping {
  const filters: ImageFilterValues = {};
  const mapped: string[] = [];
  const unsupported: string[] = [];

  if (adjustment.type === "brightness/contrast") {
    addFilter(filters, "exposure", (adjustment.brightness ?? 0) / 150);
    addFilter(filters, "contrast", (adjustment.contrast ?? 0) / 100);
    mapped.push("brightness→exposure", "contrast");
    if (adjustment.useLegacy || adjustment.labColorOnly || adjustment.auto) {
      unsupported.push("legacy/Lab/auto mode");
    }
  } else if (adjustment.type === "exposure") {
    addFilter(filters, "exposure", (adjustment.exposure ?? 0) / 20);
    addFilter(filters, "shadows", (1 - (adjustment.gamma ?? 1)) / 3);
    addFilter(filters, "highlights", (adjustment.offset ?? 0) * 4);
    mapped.push("exposure", "gamma→shadows", "offset→highlights");
  } else if (adjustment.type === "vibrance") {
    addFilter(
      filters,
      "saturation",
      ((adjustment.saturation ?? 0) + (adjustment.vibrance ?? 0) * 0.5) / 100,
    );
    mapped.push("vibrance/saturation→saturation");
  } else if (adjustment.type === "hue/saturation") {
    const master = adjustment.master;
    addFilter(filters, "saturation", (master?.saturation ?? 0) / 100);
    addFilter(filters, "exposure", (master?.lightness ?? 0) / 100);
    if ((master?.saturation ?? 0) !== 0) mapped.push("master saturation");
    if ((master?.lightness ?? 0) !== 0) mapped.push("master lightness→exposure");
    if ((master?.hue ?? 0) !== 0) unsupported.push("master hue");
    const perColorChannels = [
      adjustment.reds,
      adjustment.yellows,
      adjustment.greens,
      adjustment.cyans,
      adjustment.blues,
      adjustment.magentas,
    ];
    if (perColorChannels.some(hasHueChannelAdjustment)) unsupported.push("per-color channels");
  } else if (adjustment.type === "levels") {
    const rgb = adjustment.rgb;
    if (rgb) {
      addFilter(filters, "shadows", (rgb.shadowOutput - rgb.shadowInput) / 255);
      addFilter(filters, "highlights", (rgb.highlightOutput - rgb.highlightInput) / 255);
      addFilter(filters, "exposure", (1 - rgb.midtoneInput) / 2);
      const inputRange = Math.max(1, rgb.highlightInput - rgb.shadowInput);
      addFilter(filters, "contrast", 255 / inputRange - 1);
      mapped.push("RGB input/output levels", "midtone→exposure");
    }
    if (adjustment.red || adjustment.green || adjustment.blue) {
      unsupported.push("per-channel levels");
    }
  } else if (adjustment.type === "curves") {
    if (adjustment.rgb?.length) {
      const shadow = sampleCurve(adjustment.rgb, 64);
      const middle = sampleCurve(adjustment.rgb, 128);
      const highlight = sampleCurve(adjustment.rgb, 192);
      addFilter(filters, "shadows", (shadow - 64) / 191);
      addFilter(filters, "exposure", (middle - 128) / 127);
      addFilter(filters, "highlights", (highlight - 192) / 191);
      const slope = (highlight - shadow) / 128;
      addFilter(filters, "contrast", slope - 1);
      mapped.push("RGB curve→shadows/exposure/highlights/contrast");
    }
    if (adjustment.red || adjustment.green || adjustment.blue) {
      unsupported.push("per-channel curves");
    }
  } else if (adjustment.type === "color balance") {
    const tonalValues = [adjustment.shadows, adjustment.midtones, adjustment.highlights].filter(
      hasColorBalanceAdjustment,
    );
    if (tonalValues.length > 0) {
      const values = tonalValues.reduce(
        (total, current) => ({
          cyanRed: total.cyanRed + current.cyanRed,
          magentaGreen: total.magentaGreen + current.magentaGreen,
          yellowBlue: total.yellowBlue + current.yellowBlue,
        }),
        { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
      );
      const divisor = tonalValues.length * 100;
      addFilter(filters, "temperature", (-values.yellowBlue + values.cyanRed * 0.5) / divisor);
      addFilter(filters, "tint", (-values.magentaGreen + values.cyanRed * 0.5) / divisor);
      mapped.push(
        "yellow/blue→temperature",
        "magenta/green→tint",
        "cyan/red→temperature+tint",
      );
    }
    if (
      hasColorBalanceAdjustment(adjustment.shadows) ||
      hasColorBalanceAdjustment(adjustment.highlights)
    ) {
      unsupported.push("tonal-range targeting");
    }
  } else if (adjustment.type === "photo filter") {
    const color = adjustment.color;
    const density = (adjustment.density ?? 0) / 100;
    if (color && "r" in color && "g" in color && "b" in color) {
      const red = color.r > 1 ? color.r / 255 : color.r;
      const green = color.g > 1 ? color.g / 255 : color.g;
      const blue = color.b > 1 ? color.b / 255 : color.b;
      addFilter(filters, "temperature", (red - blue) * density);
      addFilter(filters, "tint", (red + blue - green * 2) * density * 0.5);
      mapped.push("filter color/density→temperature/tint");
    } else if (color) {
      unsupported.push("non-RGB photo filter color");
    }
  } else if (adjustment.type === "black & white") {
    filters.saturation = -1;
    mapped.push("black & white→saturation");
    if (adjustment.useTint || adjustment.tintColor) unsupported.push("tint and channel mix");
  } else if (adjustment.type === "channel mixer" && adjustment.monochrome) {
    filters.saturation = -1;
    mapped.push("monochrome→saturation");
    unsupported.push("channel coefficients");
  } else {
    unsupported.push(adjustment.type);
  }

  return { filters, mapped, unsupported };
}

function hasImageFilters(filters: ImageFilterValues | undefined): boolean {
  return Boolean(filters && Object.values(filters).some((value) => value !== undefined && value !== 0));
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

function canvasFromBitmap(source: {
  canvas?: HTMLCanvasElement;
  imageData?: { data: ArrayLike<number>; width: number; height: number };
}): HTMLCanvasElement | undefined {
  if (source.canvas) return source.canvas;
  if (!source.imageData || typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = source.imageData.width;
  canvas.height = source.imageData.height;
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) return undefined;
  const image = canvasContext.createImageData(canvas.width, canvas.height);
  const sourcePixels = source.imageData.data;
  const scale =
    sourcePixels instanceof Uint16Array ? 1 / 257 : sourcePixels instanceof Float32Array ? 255 : 1;
  for (let index = 0; index < image.data.length; index += 1) {
    image.data[index] = Math.max(0, Math.min(255, Number(sourcePixels[index] ?? 0) * scale));
  }
  canvasContext.putImageData(image, 0, 0);
  return canvas;
}

function canvasFromLayer(layer: PsdLayerLike): HTMLCanvasElement | undefined {
  return canvasFromBitmap(layer);
}

function addCanvasAsset(
  canvas: HTMLCanvasElement,
  name: string,
  context: ParseContext,
): string {
  const assetId = createId("asset");
  context.assets.push({
    id: assetId,
    name,
    mimeType: "image/png",
    data: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  });
  return assetId;
}

function transparentAsset(context: ParseContext): string {
  if (context.transparentAssetRef) return context.transparentAssetRef;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  context.transparentAssetRef = addCanvasAsset(canvas, "Transparent adjustment.png", context);
  return context.transparentAssetRef;
}

function maskOffset(
  mask: LayerMaskData,
  layerBounds: LayerBounds,
): { x: number; y: number } {
  const left = mask.left ?? 0;
  const top = mask.top ?? 0;
  return mask.positionRelativeToLayer
    ? { x: left, y: top }
    : { x: left - layerBounds.left, y: top - layerBounds.top };
}

function pixelMaskCanvas(
  mask: LayerMaskData,
  layerBounds: LayerBounds,
): HTMLCanvasElement | undefined {
  const source = canvasFromBitmap(mask);
  if (!source) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(layerBounds.width));
  canvas.height = Math.max(1, Math.ceil(layerBounds.height));
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) return undefined;
  const background = Math.max(0, Math.min(255, mask.defaultColor ?? 0));
  canvasContext.fillStyle = `rgb(${background},${background},${background})`;
  canvasContext.fillRect(0, 0, canvas.width, canvas.height);
  const offset = maskOffset(mask, layerBounds);
  canvasContext.drawImage(source, offset.x, offset.y);
  return canvas;
}

function traceBezierPath(
  canvasContext: CanvasRenderingContext2D,
  path: BezierPath,
  offsetX: number,
  offsetY: number,
): void {
  const first = path.knots[0]?.points;
  if (!first) return;
  canvasContext.moveTo((first[2] ?? 0) - offsetX, (first[3] ?? 0) - offsetY);
  for (let index = 0; index < path.knots.length - (path.open ? 1 : 0); index += 1) {
    const current = path.knots[index]?.points;
    const next = path.knots[(index + 1) % path.knots.length]?.points;
    if (!current || !next) continue;
    canvasContext.bezierCurveTo(
      (current[4] ?? 0) - offsetX,
      (current[5] ?? 0) - offsetY,
      (next[0] ?? 0) - offsetX,
      (next[1] ?? 0) - offsetY,
      (next[2] ?? 0) - offsetX,
      (next[3] ?? 0) - offsetY,
    );
  }
  if (!path.open) canvasContext.closePath();
}

function vectorMaskCanvas(
  vectorMask: LayerVectorMask,
  layerBounds: LayerBounds,
): HTMLCanvasElement | undefined {
  if (vectorMask.disable || vectorMask.paths.length === 0) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(layerBounds.width));
  canvas.height = Math.max(1, Math.ceil(layerBounds.height));
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) return undefined;
  const inverted = vectorMask.invert ?? false;
  const fillAll = vectorMask.fillStartsWithAllPixels ?? false;
  const background = inverted || fillAll ? 255 : 0;
  const foreground = background === 255 ? 0 : 255;
  canvasContext.fillStyle = `rgb(${background},${background},${background})`;
  canvasContext.fillRect(0, 0, canvas.width, canvas.height);

  for (const path of vectorMask.paths) {
    canvasContext.save();
    canvasContext.beginPath();
    traceBezierPath(canvasContext, path, layerBounds.left, layerBounds.top);
    if (path.operation === "subtract") {
      canvasContext.globalCompositeOperation = "destination-out";
      canvasContext.fillStyle = "#000000";
    } else if (path.operation === "intersect") {
      canvasContext.globalCompositeOperation = "destination-in";
      canvasContext.fillStyle = "#ffffff";
    } else if (path.operation === "exclude") {
      canvasContext.globalCompositeOperation = "xor";
      canvasContext.fillStyle = "#ffffff";
    } else {
      canvasContext.fillStyle = `rgb(${foreground},${foreground},${foreground})`;
    }
    canvasContext.fill(path.fillRule === "even-odd" ? "evenodd" : "nonzero");
    canvasContext.restore();
  }
  return canvas;
}

function maskImageNode(
  canvas: HTMLCanvasElement,
  name: string,
  layerBounds: LayerBounds,
  density: number | undefined,
  feather: number | undefined,
  context: ParseContext,
): IRNode {
  return {
    id: createId("mask"),
    name,
    type: "image",
    x: 0,
    y: 0,
    width: layerBounds.width,
    height: layerBounds.height,
    opacity: density ?? 1,
    assetRef: addCanvasAsset(canvas, `${name}.png`, context),
    scaleMode: "fill",
    isMask: true,
    maskType: "luminance",
    effects:
      feather && feather > 0
        ? [{ type: "layerBlur", radius: feather, visible: true }]
        : undefined,
  };
}

function layerMaskNodes(
  layer: PsdLayerLike,
  layerBounds: LayerBounds,
  context: ParseContext,
): IRNode[] {
  const masks: IRNode[] = [];
  if (layer.mask && !layer.mask.disabled) {
    const canvas = pixelMaskCanvas(layer.mask, layerBounds);
    if (canvas) {
      masks.push(
        maskImageNode(
          canvas,
          `${layer.name ?? "Layer"} 图层蒙版`,
          layerBounds,
          layer.mask.userMaskDensity,
          layer.mask.userMaskFeather,
          context,
        ),
      );
      context.report.items.push({
        level: "info",
        code: "PSD_PIXEL_MASK_NATIVE",
        message: "The Photoshop pixel mask was restored as a native Figma luminance mask.",
        nodeName: layer.name,
      });
    }
  }
  if (layer.vectorMask && !layer.vectorMask.disable) {
    const canvas = vectorMaskCanvas(layer.vectorMask, layerBounds);
    if (canvas) {
      masks.push(
        maskImageNode(
          canvas,
          `${layer.name ?? "Layer"} 矢量蒙版`,
          layerBounds,
          layer.mask?.vectorMaskDensity,
          layer.mask?.vectorMaskFeather,
          context,
        ),
      );
      context.report.items.push({
        level: "info",
        code: "PSD_VECTOR_MASK_NATIVE",
        message:
          "The Photoshop vector mask was restored as a native Figma luminance mask, including density and feather.",
        nodeName: layer.name,
      });
    }
  }
  return masks;
}

function addRasterLayer(
  layer: PsdLayerLike,
  relativeTo: LayerBounds,
  context: ParseContext,
  filters?: ImageFilterValues,
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
  const assetId = addCanvasAsset(canvas, `${layer.name ?? "Layer"}.png`, context);
  context.report.rasterizedNodes += 1;
  context.report.items.push({
    level: "fallback",
    code: "PSD_RASTER_LAYER",
    message: "Pixel content was preserved as an image fill.",
    nodeName: layer.name,
  });

  const image: IRNode = {
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
    filters: hasImageFilters(filters) ? filters : undefined,
  };
  return wrapLeafWithMasks(image, layer, layerBounds, relativeTo, context);
}

function addTextLayer(
  layer: PsdLayerLike,
  relativeTo: LayerBounds,
  context: ParseContext,
  filters?: ImageFilterValues,
): IRNode | undefined {
  const characters = layer.text?.text ?? "";
  if (!characters) return undefined;
  const layerBounds = bounds(layer);
  const style = layer.text?.styleRuns?.[0]?.style ?? layer.text?.style ?? {};
  const fill = style.fillColor;
  context.report.editableNodes += 1;

  if (hasImageFilters(filters)) {
    context.report.items.push({
      level: "warning",
      code: "PSD_ADJUSTMENT_NON_IMAGE_TARGET",
      message:
        "Figma image adjustments cannot be applied directly to editable text; the text remains editable without that image-only adjustment.",
      nodeName: layer.name,
    });
  }

  const text: IRNode = {
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
  return wrapLeafWithMasks(text, layer, layerBounds, relativeTo, context);
}

function wrapLeafWithMasks(
  node: IRNode,
  layer: PsdLayerLike,
  layerBounds: LayerBounds,
  relativeTo: LayerBounds,
  context: ParseContext,
): IRNode {
  const masks = layerMaskNodes(layer, layerBounds, context);
  if (masks.length === 0) return node;
  const content = {
    ...node,
    id: createId(node.type),
    name: `${layer.name ?? "Layer"} 内容`,
    x: 0,
    y: 0,
    opacity: 1,
    visible: true,
    blendMode: "normal",
  } as IRNode;
  context.report.editableNodes += 1;
  return {
    id: createId("masked-layer"),
    name: layer.name ?? "Masked Layer",
    type: "group",
    x: layerBounds.left - relativeTo.left,
    y: layerBounds.top - relativeTo.top,
    width: layerBounds.width,
    height: layerBounds.height,
    opacity: normalizeOpacity(layer.opacity),
    visible: layer.hidden !== true,
    blendMode: layer.blendMode,
    children: [...masks, content],
  };
}

interface AdjustmentOverlay {
  node: ContainerNode;
  filters: ImageFilterValues;
  clipped: boolean;
  appliedCount: number;
}

function createAdjustmentNode(
  layer: PsdLayerLike,
  container: LayerBounds,
  relativeTo: LayerBounds,
  mapping: PsdAdjustmentMapping,
  context: ParseContext,
): { node: IRNode; overlay?: AdjustmentOverlay } {
  const marker: IRNode = {
    id: createId("adjustment"),
    name: layer.name ?? layer.adjustment?.type ?? "Adjustment",
    type: "image",
    x: container.left - relativeTo.left,
    y: container.top - relativeTo.top,
    width: container.width,
    height: container.height,
    opacity: normalizeOpacity(layer.opacity),
    visible: layer.hidden !== true,
    blendMode: layer.blendMode,
    assetRef: transparentAsset(context),
    scaleMode: "fill",
    filters: hasImageFilters(mapping.filters) ? mapping.filters : undefined,
  };
  const masks = layerMaskNodes(layer, container, context);
  if (masks.length === 0) return { node: marker };

  const group: ContainerNode = {
    id: createId("adjustment-group"),
    name: layer.name ?? layer.adjustment?.type ?? "Adjustment",
    type: "group",
    x: container.left - relativeTo.left,
    y: container.top - relativeTo.top,
    width: container.width,
    height: container.height,
    opacity: normalizeOpacity(layer.opacity),
    visible: layer.hidden !== true,
    blendMode: layer.blendMode,
    children: [
      ...masks,
      {
        ...marker,
        id: createId("adjustment-marker"),
        name: `${marker.name} 调整参数`,
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        blendMode: "normal",
      },
    ],
  };
  return {
    node: group,
    overlay: {
      node: group,
      filters: mapping.filters,
      clipped: layer.clipping ?? false,
      appliedCount: 0,
    },
  };
}

function cloneAdjustedImages(
  node: IRNode,
  filters: ImageFilterValues,
): IRNode | undefined {
  if (node.type === "image") {
    return {
      ...node,
      id: createId(node.isMask ? "mask-copy" : "adjusted-image"),
      name: node.isMask ? node.name : `${node.name} 调整效果`,
      filters: node.isMask ? node.filters : combineImageFilters(node.filters, filters),
    };
  }
  if (!("children" in node)) return undefined;
  const children = node.children
    .map((child) => cloneAdjustedImages(child, filters))
    .filter((child): child is IRNode => child !== undefined);
  if (!children.some((child) => child.isMask !== true)) return undefined;
  return {
    ...node,
    id: createId("adjusted-group"),
    children,
  };
}

function reportAdjustment(
  layer: PsdLayerLike,
  mapping: PsdAdjustmentMapping,
  context: ParseContext,
): void {
  const type = layer.adjustment?.type ?? "adjustment";
  if (mapping.mapped.length > 0) {
    context.report.items.push({
      level: "info",
      code: "PSD_ADJUSTMENT_NATIVE",
      message: `${type} was mapped to native Figma image adjustments: ${mapping.mapped.join(", ")}.`,
      nodeName: layer.name,
    });
  }
  if (mapping.unsupported.length > 0) {
    context.report.items.push({
      level: "fallback",
      code: "PSD_ADJUSTMENT_PARTIAL",
      message: `${type} contains settings with no equivalent Figma image slider: ${mapping.unsupported.join(", ")}.`,
      nodeName: layer.name,
    });
  }
}

function parseLayers(
  layers: PsdLayerLike[],
  container: LayerBounds,
  context: ParseContext,
  inheritedFilters: ImageFilterValues = {},
): IRNode[] {
  const nodes: IRNode[] = [];
  let persistentFilters = inheritedFilters;
  let clippedFilters: ImageFilterValues = {};
  let overlays: AdjustmentOverlay[] = [];

  for (const layer of layers) {
    if (layer.adjustment) {
      const mapping = mapPsdAdjustment(layer.adjustment);
      const adjustment = createAdjustmentNode(layer, container, container, mapping, context);
      nodes.push(adjustment.node);
      context.report.editableNodes += 1;
      reportAdjustment(layer, mapping, context);
      if (layer.hidden !== true && hasImageFilters(mapping.filters)) {
        if (adjustment.overlay) {
          overlays.push(adjustment.overlay);
          context.report.items.push({
            level: "info",
            code: "PSD_MASKED_ADJUSTMENT_NATIVE",
            message:
              "The masked adjustment was rebuilt as a native Figma mask with filtered image overlays.",
            nodeName: layer.name,
          });
        } else if (layer.clipping) {
          clippedFilters = combineImageFilters(clippedFilters, mapping.filters);
        } else {
          persistentFilters = combineImageFilters(persistentFilters, mapping.filters);
        }
      }
      continue;
    }

    const filters = combineImageFilters(persistentFilters, clippedFilters);
    const node = parseLayer(layer, container, context, filters);
    if (node) {
      nodes.push(node);
      for (const overlay of overlays) {
        const adjusted = cloneAdjustedImages(node, overlay.filters);
        if (!adjusted) continue;
        overlay.node.children.push(adjusted);
        overlay.appliedCount += 1;
      }
    }
    clippedFilters = {};
    overlays = overlays.filter((overlay) => !overlay.clipped);
  }

  for (const overlay of overlays) {
    if (overlay.appliedCount > 0) continue;
    context.report.items.push({
      level: "warning",
      code: "PSD_MASKED_ADJUSTMENT_EMPTY",
      message: "The masked adjustment did not contain any compatible image layers below it.",
      nodeName: overlay.node.name,
    });
  }
  return nodes;
}

function parseLayer(
  layer: PsdLayerLike,
  relativeTo: LayerBounds,
  context: ParseContext,
  filters: ImageFilterValues = {},
): IRNode | undefined {
  if (layer.children?.length) {
    const calculatedBounds = groupBounds(layer.children);
    const ownBounds = bounds(layer);
    const group = layer.right !== undefined && layer.bottom !== undefined ? ownBounds : calculatedBounds;
    const children = [
      ...layerMaskNodes(layer, group, context),
      ...parseLayers(layer.children, group, context, filters),
    ];
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
    return addTextLayer(layer, relativeTo, context, filters);
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

  return addRasterLayer(layer, relativeTo, context, filters);
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
  const root = {
    left: 0,
    top: 0,
    width: Math.max(1, psd.width),
    height: Math.max(1, psd.height),
  };
  const children = parseLayers(psd.children ?? [], root, context);
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
    message:
      "PSD groups, text, masks and compatible adjustment layers were preserved; pixel and unsupported effect layers use controlled image fallback.",
  });

  return {
    version: IR_VERSION,
    source: { name: sourceName, format: "psd", byteSize: bytes.byteLength },
    pages: [page],
    assets,
    report,
  };
}
