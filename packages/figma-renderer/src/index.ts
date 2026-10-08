import type {
  Asset,
  Color,
  Effect as IREffect,
  IRDocument,
  IRNode,
  Paint,
  Stroke,
  TextNode as IRTextNode,
} from "@easy-to-figma/ir-schema";

export interface RenderResult {
  pageCount: number;
  nodeCount: number;
  missingFonts: string[];
}

interface RenderContext {
  assets: Map<string, Asset>;
  images: Map<string, Image>;
  fonts: Map<string, FontName>;
  fallbackFont: FontName;
  missingFonts: Set<string>;
  nodeCount: number;
}

type RenderedNode =
  | FrameNode
  | TextNode
  | VectorNode
  | RectangleNode
  | EllipseNode
  | PolygonNode
  | LineNode;

function toRgb(color: Color): RGB {
  return {
    r: Math.max(0, Math.min(1, color.r)),
    g: Math.max(0, Math.min(1, color.g)),
    b: Math.max(0, Math.min(1, color.b)),
  };
}

function toPaint(paint: Paint, context: RenderContext): SolidPaint | ImagePaint | undefined {
  if (paint.type === "solid") {
    return {
      type: "SOLID",
      color: toRgb(paint.color),
      opacity: paint.opacity ?? paint.color.a ?? 1,
    };
  }

  const asset = context.assets.get(paint.assetRef);
  if (!asset) return undefined;
  let image = context.images.get(asset.id);
  if (!image) {
    const encoded = asset.data.includes(",") ? asset.data.slice(asset.data.indexOf(",") + 1) : asset.data;
    image = figma.createImage(figma.base64Decode(encoded));
    context.images.set(asset.id, image);
  }
  const scaleModes: Record<NonNullable<typeof paint.scaleMode>, ImagePaint["scaleMode"]> = {
    fill: "FILL",
    fit: "FIT",
    crop: "CROP",
    tile: "TILE",
  };
  return {
    type: "IMAGE",
    imageHash: image.hash,
    scaleMode: scaleModes[paint.scaleMode ?? "fill"],
    opacity: paint.opacity ?? 1,
  };
}

function toStrokes(strokes: Stroke[] | undefined): {
  paints: SolidPaint[];
  weight: number;
  dashPattern: number[];
} {
  if (!strokes?.length) return { paints: [], weight: 1, dashPattern: [] };
  const first = strokes[0];
  if (!first) return { paints: [], weight: 1, dashPattern: [] };
  return {
    paints: [
      {
        type: "SOLID",
        color: toRgb(first.color),
        opacity: first.opacity ?? first.color.a ?? 1,
      },
    ],
    weight: first.width,
    dashPattern: first.dashPattern ?? [],
  };
}

function toEffects(effects: IREffect[] | undefined): readonly (DropShadowEffect | BlurEffectNormal)[] {
  if (!effects?.length) return [];
  return effects.map((effect) => {
    if (effect.type === "dropShadow") {
      return {
        type: "DROP_SHADOW",
        color: {
          ...toRgb(effect.color),
          a: effect.color.a ?? 1,
        },
        offset: effect.offset,
        radius: effect.radius,
        spread: effect.spread ?? 0,
        visible: effect.visible ?? true,
        blendMode: "NORMAL",
      } satisfies DropShadowEffect;
    }
    return {
      type: "LAYER_BLUR",
      radius: effect.radius,
      visible: effect.visible ?? true,
      blurType: "NORMAL",
    } satisfies BlurEffectNormal;
  });
}

function mapBlendMode(value: string | undefined): BlendMode {
  const normalized = value?.replace(/[-\s]/g, "_").toUpperCase();
  const supported = new Set<BlendMode>([
    "PASS_THROUGH",
    "NORMAL",
    "DARKEN",
    "MULTIPLY",
    "LINEAR_BURN",
    "COLOR_BURN",
    "LIGHTEN",
    "SCREEN",
    "LINEAR_DODGE",
    "COLOR_DODGE",
    "OVERLAY",
    "SOFT_LIGHT",
    "HARD_LIGHT",
    "DIFFERENCE",
    "EXCLUSION",
    "HUE",
    "SATURATION",
    "COLOR",
    "LUMINOSITY",
  ]);
  return supported.has(normalized as BlendMode) ? (normalized as BlendMode) : "NORMAL";
}

function applyCommon(node: RenderedNode, source: IRNode, context: RenderContext): void {
  node.name = source.name;
  node.x = source.x;
  node.y = source.y;
  node.opacity = Math.max(0, Math.min(1, source.opacity ?? 1));
  node.visible = source.visible ?? true;
  node.locked = source.locked ?? false;
  if ("rotation" in node) node.rotation = source.rotation ?? 0;
  if ("blendMode" in node) node.blendMode = mapBlendMode(source.blendMode);
  if ("effects" in node) node.effects = toEffects(source.effects);
  if ("fills" in node && source.fills) {
    node.fills = source.fills
      .map((paint) => toPaint(paint, context))
      .filter((paint): paint is SolidPaint | ImagePaint => paint !== undefined);
  }
  if ("strokes" in node) {
    const stroke = toStrokes(source.strokes);
    node.strokes = stroke.paints;
    node.strokeWeight = stroke.weight;
    node.dashPattern = stroke.dashPattern;
  }
}

function chooseFont(source: IRTextNode, context: RenderContext): FontName {
  const requestedFamily = source.fontFamily?.trim() || context.fallbackFont.family;
  const requestedStyle = source.fontStyle?.trim() || "Regular";
  const exact = context.fonts.get(`${requestedFamily}::${requestedStyle}`.toLowerCase());
  if (exact) return exact;
  const familyRegular = context.fonts.get(`${requestedFamily}::Regular`.toLowerCase());
  if (familyRegular) return familyRegular;
  context.missingFonts.add(`${requestedFamily} ${requestedStyle}`);
  return context.fallbackFont;
}

async function createText(source: IRTextNode, context: RenderContext): Promise<TextNode> {
  const node = figma.createText();
  const fontName = chooseFont(source, context);
  await figma.loadFontAsync(fontName);
  node.fontName = fontName;
  node.characters = source.characters;
  node.fontSize = Math.max(1, source.fontSize ?? 16);
  node.textAutoResize = "NONE";
  node.resize(Math.max(1, source.width), Math.max(1, source.height));
  node.textAlignHorizontal = (source.textAlignHorizontal ?? "left").toUpperCase() as TextNode["textAlignHorizontal"];
  node.textAlignVertical = (source.textAlignVertical ?? "top").toUpperCase() as TextNode["textAlignVertical"];
  node.textCase = (source.textCase ?? "original").toUpperCase() as TextCase;
  node.textDecoration = (source.textDecoration ?? "none").toUpperCase() as TextDecoration;
  node.lineHeight =
    source.lineHeight === undefined || source.lineHeight === "auto"
      ? { unit: "AUTO" }
      : { unit: "PIXELS", value: source.lineHeight };
  node.letterSpacing = { unit: "PIXELS", value: source.letterSpacing ?? 0 };
  return node;
}

function createShape(source: IRNode): RectangleNode | EllipseNode | PolygonNode | LineNode {
  if (source.type === "ellipse") return figma.createEllipse();
  if (source.type === "polygon") {
    const node = figma.createPolygon();
    node.pointCount = source.pointCount ?? 3;
    return node;
  }
  if (source.type === "line") return figma.createLine();
  return figma.createRectangle();
}

function createVector(source: Extract<IRNode, { type: "vector" }>): VectorNode {
  const node = figma.createVector();
  node.vectorPaths = source.vectorPaths.map((path) => ({
    windingRule: path.windingRule === "evenodd" ? "EVENODD" : "NONZERO",
    data: path.data,
  }));
  return node;
}

async function renderNode(
  source: IRNode,
  parent: ChildrenMixin,
  context: RenderContext,
): Promise<SceneNode> {
  let node: RenderedNode;
  if (source.type === "frame" || source.type === "group" || source.type === "booleanGroup") {
    const frame = figma.createFrame();
    frame.clipsContent = source.clipsContent ?? false;
    frame.resize(Math.max(1, source.width), Math.max(1, source.height));
    if (source.cornerRadius !== undefined) frame.cornerRadius = source.cornerRadius;
    node = frame;
    parent.appendChild(node);
    applyCommon(node, source, context);
    for (const child of source.children) {
      await renderNode(child, frame, context);
    }
  } else if (source.type === "text") {
    node = await createText(source, context);
    parent.appendChild(node);
    applyCommon(node, source, context);
  } else if (source.type === "vector") {
    node = createVector(source);
    parent.appendChild(node);
    node.resize(Math.max(1, source.width), Math.max(1, source.height));
    applyCommon(node, source, context);
  } else if (source.type === "image") {
    const rectangle = figma.createRectangle();
    rectangle.resize(Math.max(1, source.width), Math.max(1, source.height));
    const paint = toPaint(
      { type: "image", assetRef: source.assetRef, scaleMode: source.scaleMode },
      context,
    );
    rectangle.fills = paint ? [paint] : [];
    node = rectangle;
    parent.appendChild(node);
    applyCommon(node, { ...source, fills: undefined }, context);
  } else {
    node = createShape(source);
    parent.appendChild(node);
    node.resize(Math.max(1, source.width), Math.max(1, source.height));
    if (node.type === "RECTANGLE" && source.type === "rectangle" && source.cornerRadius !== undefined) {
      node.cornerRadius = source.cornerRadius;
    }
    applyCommon(node, source, context);
  }

  context.nodeCount += 1;
  return node;
}

export async function renderDocument(document: IRDocument): Promise<RenderResult> {
  const availableFonts = await figma.listAvailableFontsAsync();
  const fonts = new Map<string, FontName>();
  for (const font of availableFonts) {
    fonts.set(`${font.fontName.family}::${font.fontName.style}`.toLowerCase(), font.fontName);
  }
  const fallbackFont =
    fonts.get("inter::regular") ?? fonts.get("arial::regular") ?? availableFonts[0]?.fontName;
  if (!fallbackFont) throw new Error("No fonts are available in Figma.");

  const context: RenderContext = {
    assets: new Map(document.assets.map((asset) => [asset.id, asset])),
    images: new Map(),
    fonts,
    fallbackFont,
    missingFonts: new Set(),
    nodeCount: 0,
  };
  const renderedPages: SceneNode[] = [];
  const totalWidth =
    document.pages.reduce((total, page) => total + page.width, 0) +
    Math.max(0, document.pages.length - 1) * 120;
  let cursorX = figma.viewport.center.x - totalWidth / 2;
  const top = figma.viewport.center.y - Math.max(...document.pages.map((page) => page.height)) / 2;

  for (const page of document.pages) {
    const positionedPage = { ...page, x: cursorX, y: top };
    const rendered = await renderNode(positionedPage, figma.currentPage, context);
    renderedPages.push(rendered);
    cursorX += page.width + 120;
  }

  figma.currentPage.selection = renderedPages;
  figma.viewport.scrollAndZoomIntoView(renderedPages);
  const missingFonts = [...context.missingFonts].sort();
  document.report.missingFonts = missingFonts;

  return {
    pageCount: renderedPages.length,
    nodeCount: context.nodeCount,
    missingFonts,
  };
}
