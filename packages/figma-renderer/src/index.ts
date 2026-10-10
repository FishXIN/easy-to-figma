import type {
  Asset,
  Color,
  Effect as IREffect,
  ImageFilterValues,
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
  fontSubstitutions: FontSubstitution[];
}

export interface FontDescriptor {
  family: string;
  style: string;
}

export interface MissingFont {
  key: string;
  requested: FontDescriptor;
  suggested: FontDescriptor;
}

export interface FontAnalysis {
  requestedFonts: FontDescriptor[];
  availableFonts: FontDescriptor[];
  resolvedReplacements: FontReplacementMap;
  missingFonts: MissingFont[];
  fallbackFont: FontDescriptor;
}

export interface FontSubstitution {
  requested: FontDescriptor;
  replacement: FontDescriptor;
}

export type FontReplacementMap = Record<string, FontDescriptor>;

export interface RenderOptions {
  fontReplacements?: FontReplacementMap;
}

interface RenderContext {
  assets: Map<string, Asset>;
  images: Map<string, Image>;
  fonts: Map<string, FontName>;
  fontReplacements: Map<string, FontDescriptor>;
  fallbackFont: FontName;
  missingFonts: Set<string>;
  fontSubstitutions: Map<string, FontSubstitution>;
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

function invertGradientTransform(transform: Transform): Transform {
  const [[a, c, e], [b, d, f]] = transform;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-8) {
    return [
      [1, 0, 0],
      [0, 1, 0],
    ];
  }
  return [
    [
      d / determinant,
      -c / determinant,
      (c * f - d * e) / determinant,
    ],
    [
      -b / determinant,
      a / determinant,
      (b * e - a * f) / determinant,
    ],
  ];
}

function toGradientTransform(
  gradientType: "linear" | "radial",
  start: { x: number; y: number },
  end: { x: number; y: number },
): Transform {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (gradientType === "radial") {
    return invertGradientTransform([
      [2 * deltaX, -2 * deltaY, start.x - deltaX + deltaY],
      [2 * deltaY, 2 * deltaX, start.y - deltaY - deltaX],
    ]);
  }
  return invertGradientTransform([
    [deltaX, -deltaY, start.x + deltaY / 2],
    [deltaY, deltaX, start.y - deltaX / 2],
  ]);
}

function toPaint(
  paint: Paint,
  context: RenderContext,
): SolidPaint | ImagePaint | GradientPaint | undefined {
  if (paint.type === "solid") {
    return {
      type: "SOLID",
      color: toRgb(paint.color),
      opacity: paint.opacity ?? paint.color.a ?? 1,
    };
  }
  if (paint.type === "gradient") {
    return {
      type:
        paint.gradientType === "radial"
          ? "GRADIENT_RADIAL"
          : "GRADIENT_LINEAR",
      opacity: paint.opacity ?? 1,
      gradientStops: paint.stops.map((stop) => ({
        position: Math.max(0, Math.min(1, stop.position)),
        color: {
          ...toRgb(stop.color),
          a: stop.color.a ?? 1,
        },
      })),
      gradientTransform: toGradientTransform(
        paint.gradientType,
        paint.start,
        paint.end,
      ),
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
    filters: toImageFilters(paint.filters),
  };
}

function toImageFilters(filters: ImageFilterValues | undefined): ImageFilters | undefined {
  if (!filters) return undefined;
  const clamp = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : Math.max(-1, Math.min(1, value));
  return {
    exposure: clamp(filters.exposure),
    contrast: clamp(filters.contrast),
    saturation: clamp(filters.saturation),
    temperature: clamp(filters.temperature),
    tint: clamp(filters.tint),
    highlights: clamp(filters.highlights),
    shadows: clamp(filters.shadows),
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

export function mapBlendMode(value: string | undefined): BlendMode {
  const normalized = value
    ?.replace(/^source-over$/i, "normal")
    .replace(/[-\s]/g, "_")
    .toUpperCase();
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
  if ("blendMode" in node) {
    node.blendMode =
      source.blendMode === undefined && node.type === "GROUP"
        ? "PASS_THROUGH"
        : mapBlendMode(source.blendMode);
  }
  if ("isMask" in node && source.isMask !== undefined) {
    node.isMask = source.isMask;
    if (source.maskType) node.maskType = source.maskType.toUpperCase() as MaskType;
  }
  if ("effects" in node) node.effects = toEffects(source.effects);
  if ("fills" in node && source.fills) {
    node.fills = source.fills
      .map((paint) => toPaint(paint, context))
      .filter(
        (paint): paint is SolidPaint | ImagePaint | GradientPaint =>
          paint !== undefined,
      );
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
  candidates: FontDescriptor[];
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

const FONT_EQUIVALENT_ALIASES: Array<{
  matches: RegExp;
  families: string[];
}> = [
  {
    matches: /sxsgys/i,
    families: [
      "苏新诗古印宋简",
      "SXS-GYSJ",
      "FZSuXinShiGuYinSongS",
      "方正苏新诗古印宋 简",
    ],
  },
  {
    matches: /biaoxiaozhilongzhuti-j/i,
    families: ["标小智龙珠体 简", "标小智龙珠体", "BiaoXiaoZhiLongZhuTi"],
  },
];

export function fontKey(font: FontDescriptor): string {
  return `${font.family.trim()}::${font.style.trim()}`.toLowerCase();
}

function fontLabel(font: FontDescriptor): string {
  return `${font.family} ${font.style}`;
}

function requestedFont(
  fontFamily: string | undefined,
  fontStyle: string | undefined,
  fallbackFont?: FontDescriptor,
): FontDescriptor | undefined {
  const family = fontFamily?.trim() || fallbackFont?.family;
  if (!family) return undefined;
  return {
    family,
    style: fontStyle?.trim() || fallbackFont?.style || "Regular",
  };
}

export function collectRequestedFonts(document: IRDocument): FontDescriptor[] {
  const fonts = new Map<string, FontDescriptor>();
  const visit = (node: IRNode): void => {
    if (node.type === "text") {
      const base = requestedFont(node.fontFamily, node.fontStyle);
      if (base) fonts.set(fontKey(base), base);
      for (const run of node.runs ?? []) {
        const runFont = requestedFont(run.fontFamily, run.fontStyle, base);
        if (runFont) fonts.set(fontKey(runFont), runFont);
      }
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  for (const page of document.pages) visit(page);
  return [...fonts.values()].sort(
    (left, right) =>
      left.family.localeCompare(right.family) || left.style.localeCompare(right.style),
  );
}

function chooseSuggestedFont(
  requested: FontDescriptor,
  fonts: Map<string, FontDescriptor>,
  fallbackFont: FontDescriptor,
): FontDescriptor {
  const exactFamily = [...fonts.values()].filter(
    (font) => font.family.toLowerCase() === requested.family.toLowerCase(),
  );
  const regular =
    exactFamily.find((font) => font.style.toLowerCase() === "regular") ?? exactFamily[0];
  if (regular) return regular;

  const substitution = FONT_SUBSTITUTIONS.find(({ matches }) => matches.test(requested.family));
  for (const candidate of substitution?.candidates ?? []) {
    const available = fonts.get(fontKey(candidate));
    if (available) return available;
  }
  return fallbackFont;
}

function findAvailableFamily(
  family: string,
  fonts: Map<string, FontDescriptor>,
): FontDescriptor | undefined {
  const normalizedFamily = family
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s._-]+/g, "");
  const matches = [...fonts.values()].filter(
    (font) =>
      font.family
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s._-]+/g, "") === normalizedFamily,
  );
  return matches.find((font) => font.style.toLowerCase() === "regular") ?? matches[0];
}

function chooseEquivalentInstalledFont(
  requested: FontDescriptor,
  fonts: Map<string, FontDescriptor>,
): FontDescriptor | undefined {
  const sameFamily = findAvailableFamily(requested.family, fonts);
  if (sameFamily) return sameFamily;

  const aliases = FONT_EQUIVALENT_ALIASES.find(({ matches }) => matches.test(requested.family));
  for (const family of aliases?.families ?? []) {
    const available = findAvailableFamily(family, fonts);
    if (available) return available;
  }
  return undefined;
}

export async function analyzeRequestedFonts(
  requestedFonts: FontDescriptor[],
  knownAvailableFonts?: FontDescriptor[],
): Promise<FontAnalysis> {
  const availableFonts =
    knownAvailableFonts ??
    (await figma.listAvailableFontsAsync()).map(({ fontName }) => ({
      family: fontName.family,
      style: fontName.style,
    }));
  const fonts = new Map<string, FontDescriptor>();
  for (const font of availableFonts) fonts.set(fontKey(font), font);
  const sortedAvailableFonts = [...fonts.values()].sort(
    (left, right) =>
      left.family.localeCompare(right.family) || left.style.localeCompare(right.style),
  );
  const fallbackFont =
    fonts.get(fontKey({ family: "Inter", style: "Regular" })) ??
    fonts.get(fontKey({ family: "Arial", style: "Regular" })) ??
    sortedAvailableFonts[0];
  if (!fallbackFont) throw new Error("No fonts are available in Figma.");

  const resolvedReplacements: FontReplacementMap = {};
  const missingFonts: MissingFont[] = [];
  for (const font of requestedFonts) {
    const key = fontKey(font);
    if (fonts.has(key)) continue;
    const equivalent = chooseEquivalentInstalledFont(font, fonts);
    if (equivalent) {
      resolvedReplacements[key] = equivalent;
      continue;
    }
    missingFonts.push({
      key,
      requested: font,
      suggested: chooseSuggestedFont(font, fonts, fallbackFont),
    });
  }
  return {
    requestedFonts,
    availableFonts: sortedAvailableFonts,
    resolvedReplacements,
    missingFonts,
    fallbackFont,
  };
}

export async function analyzeDocumentFonts(
  document: IRDocument,
  knownAvailableFonts?: FontDescriptor[],
): Promise<FontAnalysis> {
  return analyzeRequestedFonts(collectRequestedFonts(document), knownAvailableFonts);
}

function chooseFont(
  fontFamily: string | undefined,
  fontStyle: string | undefined,
  context: RenderContext,
): FontName {
  const requested =
    requestedFont(fontFamily, fontStyle) ?? context.fallbackFont;
  const requestedKey = fontKey(requested);
  const exact = context.fonts.get(requestedKey);
  if (exact) return exact;

  context.missingFonts.add(fontLabel(requested));
  const replacementRequest = context.fontReplacements.get(requestedKey);
  const replacement =
    (replacementRequest && context.fonts.get(fontKey(replacementRequest))) ??
    context.fallbackFont;
  context.fontSubstitutions.set(requestedKey, {
    requested,
    replacement,
  });
  return replacement;
}

async function createText(source: IRTextNode, context: RenderContext): Promise<TextNode> {
  const node = figma.createText();
  const fontName = chooseFont(source.fontFamily, source.fontStyle, context);
  const styledRuns = (source.runs ?? []).map((run) => ({
    ...run,
    fontName: chooseFont(
      run.fontFamily ?? source.fontFamily,
      run.fontStyle ?? source.fontStyle,
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
    if (run.lineHeight !== undefined) {
      node.setRangeLineHeight(
        start,
        end,
        run.lineHeight === "auto"
          ? { unit: "AUTO" }
          : { unit: "PIXELS", value: Math.max(1, run.lineHeight) },
      );
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
        .filter(
          (paint): paint is SolidPaint | ImagePaint | GradientPaint =>
            paint !== undefined,
        );
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
    frame.fills = [];
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
      node =
        importedChildren.length === 1
          ? importedChildren[0]! as RenderedNode
          : figma.group(importedChildren, parent);
      applyCommon(node, { ...source, x: node.x, y: node.y }, context);
    }
    renderedNodeCount = countRenderedTree(node);
    context.nodeCount += renderedNodeCount;
    return [node];
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
      {
        type: "image",
        assetRef: source.assetRef,
        scaleMode: source.scaleMode,
        filters: source.filters,
      },
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

export async function renderDocument(
  document: IRDocument,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const availableFonts = await figma.listAvailableFontsAsync();
  const fonts = new Map<string, FontName>();
  for (const font of availableFonts) {
    fonts.set(fontKey(font.fontName), font.fontName);
  }
  const fallbackFont =
    fonts.get("inter::regular") ?? fonts.get("arial::regular") ?? availableFonts[0]?.fontName;
  if (!fallbackFont) throw new Error("No fonts are available in Figma.");

  const context: RenderContext = {
    assets: new Map(document.assets.map((asset) => [asset.id, asset])),
    images: new Map(),
    fonts,
    fontReplacements: new Map(
      Object.entries(options.fontReplacements ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    ),
    fallbackFont,
    missingFonts: new Set(),
    fontSubstitutions: new Map(),
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
    fontSubstitutions: [...context.fontSubstitutions.values()].sort((left, right) =>
      fontLabel(left.requested).localeCompare(fontLabel(right.requested)),
    ),
  };
}
