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
  | GroupNode
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
    const bytes =
      typeof asset.data === "string"
        ? figma.base64Decode(
            asset.data.includes(",") ? asset.data.slice(asset.data.indexOf(",") + 1) : asset.data,
          )
        : asset.data;
    image = figma.createImage(bytes);
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

const FONT_SUBSTITUTIONS: Array<{
  matches: RegExp;
  candidates: FontName[];
}> = [
  {
    matches: /singkaibeieg-bold-gb/i,
    candidates: [
      { family: "Xingkai SC", style: "Bold" },
      { family: "Kaiti SC", style: "Bold" },
    ],
  },
  {
    matches: /sxsgys/i,
    candidates: [
      { family: "Songti SC", style: "Regular" },
      { family: "Kaiti SC", style: "Regular" },
    ],
  },
  {
    matches: /biaoxiaozhilongzhuti-j/i,
    candidates: [
      { family: "Xingkai SC", style: "Bold" },
      { family: "Kaiti SC", style: "Bold" },
    ],
  },
];

function chooseFont(source: IRTextNode, context: RenderContext): FontName {
  const requestedFamily = source.fontFamily?.trim() || context.fallbackFont.family;
  const requestedStyle = source.fontStyle?.trim() || "Regular";
  const exact = context.fonts.get(`${requestedFamily}::${requestedStyle}`.toLowerCase());
  if (exact) return exact;
  const familyRegular = context.fonts.get(`${requestedFamily}::Regular`.toLowerCase());
  if (familyRegular) return familyRegular;
  context.missingFonts.add(`${requestedFamily} ${requestedStyle}`);
  const substitution = FONT_SUBSTITUTIONS.find(({ matches }) => matches.test(requestedFamily));
  for (const candidate of substitution?.candidates ?? []) {
    const available = context.fonts.get(`${candidate.family}::${candidate.style}`.toLowerCase());
    if (available) return available;
  }
  return context.fallbackFont;
}

async function createText(source: IRTextNode, context: RenderContext): Promise<TextNode> {
  const node = figma.createText();
  const fontName = chooseFont(source, context);
  const styledRuns = (source.runs ?? []).map((run) => ({
    ...run,
    fontName: chooseFont(
      {
        ...source,
        fontFamily: run.fontFamily ?? source.fontFamily,
        fontStyle: run.fontStyle ?? source.fontStyle,
      },
      context,
    ),
  }));
  const fonts = new Map<string, FontName>();
  fonts.set(`${fontName.family}::${fontName.style}`, fontName);
  for (const run of styledRuns) {
    fonts.set(`${run.fontName.family}::${run.fontName.style}`, run.fontName);
  }
  await Promise.all([...fonts.values()].map((font) => figma.loadFontAsync(font)));
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
  for (const run of styledRuns) {
    const start = Math.max(0, Math.min(node.characters.length, run.start));
    const end = Math.max(start, Math.min(node.characters.length, run.end));
    if (end <= start) continue;
    node.setRangeFontName(start, end, run.fontName);
    if (run.fontSize !== undefined) {
      node.setRangeFontSize(start, end, Math.max(1, run.fontSize));
    }
    if (run.letterSpacing !== undefined) {
      node.setRangeLetterSpacing(start, end, { unit: "PIXELS", value: run.letterSpacing });
    }
    if (run.textDecoration !== undefined) {
      node.setRangeTextDecoration(start, end, run.textDecoration.toUpperCase() as TextDecoration);
    }
    if (run.fills) {
      const fills = run.fills
        .map((paint) => toPaint(paint, context))
        .filter((paint): paint is SolidPaint | ImagePaint => paint !== undefined);
      if (fills.length > 0) node.setRangeFills(start, end, fills);
    }
  }
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

function countRenderedTree(node: SceneNode): number {
  if (!("children" in node)) return 1;
  return 1 + node.children.reduce((total, child) => total + countRenderedTree(child), 0);
}

async function renderNode(
  source: IRNode,
  parent: BaseNode & ChildrenMixin,
  context: RenderContext,
): Promise<SceneNode[]> {
  let node: RenderedNode;
  let renderedNodeCount = 1;
  if (source.type === "frame" || source.type === "booleanGroup") {
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
  } else if (source.type === "group") {
    const staging = figma.createFrame();
    staging.name = "__easy_to_figma_staging__";
    staging.fills = [];
    staging.clipsContent = false;
    staging.resize(Math.max(1, source.width), Math.max(1, source.height));
    parent.appendChild(staging);
    try {
      for (const child of source.children) {
        await renderNode(child, staging, context);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The child node could not be imported.";
      throw new Error(`In source group "${source.name}": ${message}`);
    }
    const childNodes = [...staging.children];
    if (childNodes.length === 0) {
      staging.remove();
      throw new Error(`Figma cannot create the empty source group "${source.name}".`);
    }
    const group = figma.group(childNodes, staging);
    const localX = group.x;
    const localY = group.y;
    parent.appendChild(group);
    group.x =
      source.childCoordinateSpace === "page"
        ? localX
        : source.x + localX;
    group.y =
      source.childCoordinateSpace === "page"
        ? localY
        : source.y + localY;
    staging.remove();
    node = group;
    applyCommon(node, { ...source, x: group.x, y: group.y }, context);
  } else if (source.type === "svg") {
    let imported: FrameNode;
    try {
      imported = figma.createNodeFromSvg(source.markup);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to convert SVG file";
      throw new Error(`The source SVG node "${source.name}" could not be imported: ${message}`);
    }
    imported.fills = [];
    parent.appendChild(imported);
    imported.x = source.x;
    imported.y = source.y;
    const importedChildren = [...imported.children];
    if (importedChildren.length === 0) {
      node = imported;
      applyCommon(node, source, context);
      renderedNodeCount = countRenderedTree(node);
      context.nodeCount += renderedNodeCount;
      return [node];
    } else {
      for (const child of importedChildren) {
        const x = imported.x + child.x;
        const y = imported.y + child.y;
        parent.appendChild(child);
        child.x = x;
        child.y = y;
      }
      imported.remove();
      if (importedChildren.length === 1) {
        node = importedChildren[0]! as RenderedNode;
        applyCommon(node, { ...source, x: node.x, y: node.y }, context);
      }
    }
    renderedNodeCount = importedChildren.reduce(
      (total, child) => total + countRenderedTree(child),
      0,
    );
    context.nodeCount += renderedNodeCount;
    return importedChildren;
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

  context.nodeCount += renderedNodeCount;
  return [node];
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
  const existingRootNodes = new Set(figma.currentPage.children);
  const totalWidth =
    document.pages.reduce((total, page) => total + page.width, 0) +
    Math.max(0, document.pages.length - 1) * 120;
  const existingNodes = figma.currentPage.children;
  const left =
    existingNodes.length > 0
      ? Math.min(...existingNodes.map((node) => node.x))
      : figma.viewport.center.x - totalWidth / 2;
  let cursorX = left;
  const top =
    existingNodes.length > 0
      ? Math.max(...existingNodes.map((node) => node.y + node.height)) + 240
      : figma.viewport.center.y - Math.max(...document.pages.map((page) => page.height)) / 2;

  try {
    for (const [pageIndex, page] of document.pages.entries()) {
      const positionedPage = { ...page, x: cursorX, y: top };
      const [rendered] = await renderNode(positionedPage, figma.currentPage, context);
      if (!rendered) throw new Error(`The page "${page.name}" did not create a Figma frame.`);
      rendered.setPluginData("easy-to-figma-source", document.source.name);
      rendered.setPluginData("easy-to-figma-page", String(pageIndex + 1));
      renderedPages.push(rendered);
      cursorX += page.width + 120;
    }
  } catch (error) {
    for (const child of [...figma.currentPage.children]) {
      if (!existingRootNodes.has(child)) child.remove();
    }
    throw error;
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
