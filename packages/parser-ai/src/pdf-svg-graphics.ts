interface PdfOperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

export interface PdfObjectPool {
  get: (id: string, callback?: (value: unknown) => void) => unknown;
}

export interface PdfViewport {
  width: number;
  height: number;
  transform: ArrayLike<number>;
}

type Matrix = [number, number, number, number, number, number];

interface GraphicsState {
  x: number;
  y: number;
  fillColor: string;
  strokeColor: string;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  miterLimit: number;
  dashArray: number[];
  dashPhase: number;
  blendMode: string;
  activeClipUrl?: string;
  clipGroup?: SVGGElement;
  path?: SVGPathElement;
  element?: SVGElement;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
const LINE_CAP_STYLES = ["butt", "round", "square"];
const LINE_JOIN_STYLES = ["miter", "round", "bevel"];
let clipCount = 0;
let shadingCount = 0;

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

function numericArray(value: unknown): number[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return value;
  }
  if (
    ArrayBuffer.isView(value) &&
    "length" in value &&
    typeof value.length === "number"
  ) {
    return Array.from(value as unknown as ArrayLike<number>, Number);
  }
  return undefined;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(8).replace(/(?:\.0+|(\.\d+?)0+)$/, "$1");
}

function matrixString(matrix: ArrayLike<number>): string {
  const values = Array.from(matrix, Number);
  if (
    values[0] === 1 &&
    values[1] === 0 &&
    values[2] === 0 &&
    values[3] === 1 &&
    values[4] === 0 &&
    values[5] === 0
  ) {
    return "";
  }
  return `matrix(${values.slice(0, 6).map(formatNumber).join(" ")})`;
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

function inverseMatrix(matrix: Matrix): Matrix {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (determinant === 0) return [...IDENTITY_MATRIX];
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[4] * matrix[3]) / determinant,
    (matrix[4] * matrix[1] - matrix[5] * matrix[0]) / determinant,
  ];
}

function transformPoint(matrix: Matrix, x: number, y: number): [number, number] {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

function transformedBounds(
  matrix: Matrix,
  left: number,
  top: number,
  right: number,
  bottom: number,
): [number, number, number, number] {
  const points = [
    transformPoint(matrix, left, top),
    transformPoint(matrix, right, top),
    transformPoint(matrix, right, bottom),
    transformPoint(matrix, left, bottom),
  ];
  return [
    Math.min(...points.map(([x]) => x)),
    Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)),
    Math.max(...points.map(([, y]) => y)),
  ];
}

function cloneState(state: GraphicsState): GraphicsState {
  return {
    ...state,
    dashArray: [...state.dashArray],
  };
}

function initialState(): GraphicsState {
  return {
    x: 0,
    y: 0,
    fillColor: "#000000",
    strokeColor: "#000000",
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    lineJoin: "",
    lineCap: "",
    miterLimit: 0,
    dashArray: [],
    dashPhase: 0,
    blendMode: "normal",
  };
}

function cssColor(args: unknown[]): string {
  if (typeof args[0] === "string") return args[0];
  const values = args.slice(0, 3).map((value) => Number(value));
  const scale = values.every((value) => value >= 0 && value <= 1) ? 255 : 1;
  const hex = values
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value * scale)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return `#${hex}`;
}

function normalizedBlendMode(value: unknown): string {
  if (typeof value !== "string" || value === "source-over") return "normal";
  return value;
}

export class PdfSvgGraphics {
  private current = initialState();
  private transformMatrix: Matrix = [...IDENTITY_MATRIX];
  private readonly transformStack: Matrix[] = [];
  private readonly stateStack: GraphicsState[] = [];
  private pendingClip?: "nonzero" | "evenodd";
  private root!: SVGGElement;
  private defs!: SVGDefsElement;
  private transformGroup?: SVGGElement;
  private viewport!: PdfViewport;

  constructor(
    private readonly commonObjs: PdfObjectPool,
    private readonly objs: PdfObjectPool,
    private readonly ops: Record<string, number>,
  ) {}

  async getSVG(operatorList: PdfOperatorList, viewport: PdfViewport): Promise<SVGSVGElement> {
    this.viewport = viewport;
    const svg = this.initialize(viewport);
    await this.loadDependencies(operatorList);
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      this.execute(operatorList.fnArray[index]!, operatorList.argsArray[index]);
    }
    return svg;
  }

  private initialize(viewport: PdfViewport): SVGSVGElement {
    const svg = createSvgElement("svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("width", formatNumber(viewport.width));
    svg.setAttribute("height", formatNumber(viewport.height));
    svg.setAttribute("viewBox", `0 0 ${formatNumber(viewport.width)} ${formatNumber(viewport.height)}`);
    this.defs = createSvgElement("defs");
    svg.appendChild(this.defs);
    this.root = createSvgElement("g");
    this.root.setAttribute("transform", matrixString(viewport.transform));
    svg.appendChild(this.root);
    return svg;
  }

  private async loadDependencies(operatorList: PdfOperatorList): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < operatorList.fnArray.length; index += 1) {
      if (operatorList.fnArray[index] !== this.ops.dependency) continue;
      const ids = Array.isArray(operatorList.argsArray[index])
        ? operatorList.argsArray[index] as unknown[]
        : [];
      for (const value of ids) {
        if (typeof value !== "string") continue;
        const pool = value.startsWith("g_") ? this.commonObjs : this.objs;
        pending.push(new Promise((resolve) => pool.get(value, resolve)));
      }
    }
    await Promise.all(pending);
  }

  private execute(operator: number, rawArgs: unknown): void {
    const args = Array.isArray(rawArgs) ? rawArgs : numericArray(rawArgs) ?? [];
    if (operator === this.ops.dependency || operator === this.ops.setRenderingIntent) return;
    if (operator === this.ops.save) {
      this.save();
    } else if (operator === this.ops.restore) {
      this.restore();
    } else if (operator === this.ops.transform) {
      this.transform(args);
    } else if (operator === this.ops.setLineWidth) {
      this.current.lineWidth = Math.max(0, Number(args[0]) || 0);
    } else if (operator === this.ops.setLineCap) {
      this.current.lineCap = LINE_CAP_STYLES[Number(args[0])] ?? "";
    } else if (operator === this.ops.setLineJoin) {
      this.current.lineJoin = LINE_JOIN_STYLES[Number(args[0])] ?? "";
    } else if (operator === this.ops.setMiterLimit) {
      this.current.miterLimit = Number(args[0]) || 0;
    } else if (operator === this.ops.setDash) {
      this.current.dashArray = numericArray(args[0]) ?? [];
      this.current.dashPhase = Number(args[1]) || 0;
    } else if (operator === this.ops.setFillRGBColor) {
      this.current.fillColor = cssColor(args);
    } else if (operator === this.ops.setStrokeRGBColor) {
      this.current.strokeColor = cssColor(args);
    } else if (operator === this.ops.setGState) {
      this.setGState(args[0]);
    } else if (operator === this.ops.constructPath) {
      this.constructPath(args[0], args[1]);
    } else if (operator === this.ops.clip) {
      this.pendingClip = "nonzero";
    } else if (operator === this.ops.eoClip) {
      this.pendingClip = "evenodd";
    } else if (operator === this.ops.fill) {
      this.fill(false);
    } else if (operator === this.ops.eoFill) {
      this.fill(true);
    } else if (operator === this.ops.stroke) {
      this.stroke();
    } else if (operator === this.ops.fillStroke) {
      this.fillStroke(false);
    } else if (operator === this.ops.eoFillStroke) {
      this.fillStroke(true);
    } else if (operator === this.ops.closePath) {
      this.closePath();
    } else if (operator === this.ops.closeStroke) {
      this.closePath();
      this.stroke();
    } else if (operator === this.ops.closeFillStroke) {
      this.closePath();
      this.fillStroke(false);
    } else if (operator === this.ops.closeEOFillStroke) {
      this.closePath();
      this.fillStroke(true);
    } else if (operator === this.ops.endPath) {
      this.endPath();
    } else if (operator === this.ops.shadingFill) {
      this.shadingFill(args[0]);
    } else if (operator === this.ops.paintFormXObjectBegin) {
      this.paintFormXObjectBegin(args[0], args[1]);
    }
  }

  private save(): void {
    this.transformStack.push([...this.transformMatrix]);
    this.stateStack.push(this.current);
    this.current = cloneState(this.current);
  }

  private restore(): void {
    this.transformMatrix = this.transformStack.pop() ?? [...IDENTITY_MATRIX];
    this.current = this.stateStack.pop() ?? initialState();
    this.pendingClip = undefined;
    this.transformGroup = undefined;
  }

  private transform(args: unknown[]): void {
    const matrix = numericArray(args);
    if (!matrix || matrix.length < 6) return;
    this.transformMatrix = multiplyMatrix(
      this.transformMatrix,
      matrix.slice(0, 6) as Matrix,
    );
    this.transformGroup = undefined;
  }

  private setGState(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!Array.isArray(entry)) continue;
      const [key, stateValue] = entry;
      if (key === "LW") this.current.lineWidth = Number(stateValue) || 0;
      if (key === "LC") this.current.lineCap = LINE_CAP_STYLES[Number(stateValue)] ?? "";
      if (key === "LJ") this.current.lineJoin = LINE_JOIN_STYLES[Number(stateValue)] ?? "";
      if (key === "ML") this.current.miterLimit = Number(stateValue) || 0;
      if (key === "CA") this.current.strokeAlpha = Number(stateValue);
      if (key === "ca") this.current.fillAlpha = Number(stateValue);
      if (key === "BM") this.current.blendMode = normalizedBlendMode(stateValue);
      if (key === "D" && Array.isArray(stateValue)) {
        this.current.dashArray = numericArray(stateValue[0]) ?? [];
        this.current.dashPhase = Number(stateValue[1]) || 0;
      }
    }
  }

  private constructPath(rawOperators: unknown, rawArguments: unknown): void {
    const operators = numericArray(rawOperators) ?? [];
    const argumentsList = numericArray(rawArguments) ?? [];
    let x = this.current.x;
    let y = this.current.y;
    let argumentIndex = 0;
    const commands: string[] = [];

    for (const operator of operators) {
      if (operator === this.ops.rectangle) {
        x = argumentsList[argumentIndex++] ?? 0;
        y = argumentsList[argumentIndex++] ?? 0;
        const width = argumentsList[argumentIndex++] ?? 0;
        const height = argumentsList[argumentIndex++] ?? 0;
        commands.push(
          "M", formatNumber(x), formatNumber(y),
          "L", formatNumber(x + width), formatNumber(y),
          "L", formatNumber(x + width), formatNumber(y + height),
          "L", formatNumber(x), formatNumber(y + height),
          "Z",
        );
      } else if (operator === this.ops.moveTo) {
        x = argumentsList[argumentIndex++] ?? 0;
        y = argumentsList[argumentIndex++] ?? 0;
        commands.push("M", formatNumber(x), formatNumber(y));
      } else if (operator === this.ops.lineTo) {
        x = argumentsList[argumentIndex++] ?? 0;
        y = argumentsList[argumentIndex++] ?? 0;
        commands.push("L", formatNumber(x), formatNumber(y));
      } else if (operator === this.ops.curveTo) {
        const values = argumentsList.slice(argumentIndex, argumentIndex + 6);
        argumentIndex += 6;
        x = values[4] ?? x;
        y = values[5] ?? y;
        commands.push("C", ...values.map(formatNumber));
      } else if (operator === this.ops.curveTo2) {
        const values = argumentsList.slice(argumentIndex, argumentIndex + 4);
        argumentIndex += 4;
        commands.push(
          "C",
          formatNumber(x),
          formatNumber(y),
          ...values.map(formatNumber),
        );
        x = values[2] ?? x;
        y = values[3] ?? y;
      } else if (operator === this.ops.curveTo3) {
        const values = argumentsList.slice(argumentIndex, argumentIndex + 4);
        argumentIndex += 4;
        x = values[2] ?? x;
        y = values[3] ?? y;
        commands.push(
          "C",
          formatNumber(values[0] ?? x),
          formatNumber(values[1] ?? y),
          formatNumber(x),
          formatNumber(y),
          formatNumber(x),
          formatNumber(y),
        );
      } else if (operator === this.ops.closePath) {
        commands.push("Z");
      }
    }

    const path = createSvgElement("path");
    path.setAttribute("d", commands.join(" "));
    path.setAttribute("fill", "none");
    this.ensureTransformGroup().appendChild(path);
    this.current.path = path;
    this.current.element = path;
    this.current.x = x;
    this.current.y = y;
  }

  private closePath(): void {
    const path = this.current.path;
    if (path) path.setAttribute("d", `${path.getAttribute("d") ?? ""} Z`);
  }

  private fill(evenOdd: boolean): void {
    const element = this.current.element;
    if (!element) return;
    element.setAttribute("fill", this.current.fillColor);
    element.setAttribute("fill-opacity", String(this.current.fillAlpha));
    if (evenOdd) element.setAttribute("fill-rule", "evenodd");
    this.applyBlendMode(element);
    this.endPath();
  }

  private stroke(): void {
    const element = this.current.element;
    if (!element) return;
    element.setAttribute("fill", "none");
    element.setAttribute("stroke", this.current.strokeColor);
    element.setAttribute("stroke-opacity", String(this.current.strokeAlpha));
    element.setAttribute("stroke-width", formatNumber(this.current.lineWidth));
    if (this.current.lineCap) element.setAttribute("stroke-linecap", this.current.lineCap);
    if (this.current.lineJoin) element.setAttribute("stroke-linejoin", this.current.lineJoin);
    if (this.current.miterLimit > 0) {
      element.setAttribute("stroke-miterlimit", formatNumber(this.current.miterLimit));
    }
    if (this.current.dashArray.length > 0) {
      element.setAttribute("stroke-dasharray", this.current.dashArray.map(formatNumber).join(" "));
      element.setAttribute("stroke-dashoffset", formatNumber(this.current.dashPhase));
    }
    this.applyBlendMode(element);
    this.endPath();
  }

  private fillStroke(evenOdd: boolean): void {
    const element = this.current.element;
    if (!element) return;
    element.setAttribute("stroke", this.current.strokeColor);
    element.setAttribute("stroke-opacity", String(this.current.strokeAlpha));
    element.setAttribute("stroke-width", formatNumber(this.current.lineWidth));
    element.setAttribute("fill", this.current.fillColor);
    element.setAttribute("fill-opacity", String(this.current.fillAlpha));
    if (evenOdd) element.setAttribute("fill-rule", "evenodd");
    if (this.current.lineCap) element.setAttribute("stroke-linecap", this.current.lineCap);
    if (this.current.lineJoin) element.setAttribute("stroke-linejoin", this.current.lineJoin);
    this.applyBlendMode(element);
    this.endPath();
  }

  private endPath(): void {
    this.current.path = undefined;
    if (!this.pendingClip || !this.current.element) return;

    const id = `pdf-clip-${clipCount++}`;
    const clipPath = createSvgElement("clipPath");
    clipPath.setAttribute("id", id);
    clipPath.setAttribute("transform", matrixString(this.transformMatrix));
    const clipElement = this.current.element.cloneNode(true) as SVGElement;
    clipElement.setAttribute("clip-rule", this.pendingClip);
    clipPath.appendChild(clipElement);
    if (this.current.activeClipUrl) {
      clipPath.setAttribute("clip-path", this.current.activeClipUrl);
    }
    this.defs.appendChild(clipPath);
    this.current.activeClipUrl = `url(#${id})`;
    this.current.clipGroup = undefined;
    this.pendingClip = undefined;
    this.transformGroup = undefined;
  }

  private shadingFill(value: unknown): void {
    const pattern = this.makeShadingPattern(value);
    if (!pattern) return;
    const bounds = transformedBounds(
      inverseMatrix(this.transformMatrix),
      0,
      0,
      this.viewport.width,
      this.viewport.height,
    );
    const rectangle = createSvgElement("rect");
    rectangle.setAttribute("x", formatNumber(bounds[0]));
    rectangle.setAttribute("y", formatNumber(bounds[1]));
    rectangle.setAttribute("width", formatNumber(bounds[2] - bounds[0]));
    rectangle.setAttribute("height", formatNumber(bounds[3] - bounds[1]));
    rectangle.setAttribute("fill", pattern);
    rectangle.setAttribute("fill-opacity", String(this.current.fillAlpha));
    this.applyBlendMode(rectangle);
    this.ensureTransformGroup().appendChild(rectangle);
  }

  private makeShadingPattern(value: unknown): string | undefined {
    const pattern = typeof value === "string" ? this.objs.get(value) : value;
    if (!Array.isArray(pattern) || pattern[0] !== "RadialAxial") return undefined;
    const id = `pdf-shading-${shadingCount++}`;
    const stops = Array.isArray(pattern[3]) ? pattern[3] : [];
    let gradient: SVGLinearGradientElement | SVGRadialGradientElement;
    if (pattern[1] === "axial") {
      const start = numericArray(pattern[4]) ?? [0, 0];
      const end = numericArray(pattern[5]) ?? [1, 0];
      gradient = createSvgElement("linearGradient");
      gradient.setAttribute("x1", formatNumber(start[0] ?? 0));
      gradient.setAttribute("y1", formatNumber(start[1] ?? 0));
      gradient.setAttribute("x2", formatNumber(end[0] ?? 1));
      gradient.setAttribute("y2", formatNumber(end[1] ?? 0));
    } else if (pattern[1] === "radial") {
      const focal = numericArray(pattern[4]) ?? [0, 0];
      const circle = numericArray(pattern[5]) ?? [0, 0];
      gradient = createSvgElement("radialGradient");
      gradient.setAttribute("fx", formatNumber(focal[0] ?? 0));
      gradient.setAttribute("fy", formatNumber(focal[1] ?? 0));
      gradient.setAttribute("fr", formatNumber(Number(pattern[6]) || 0));
      gradient.setAttribute("cx", formatNumber(circle[0] ?? 0));
      gradient.setAttribute("cy", formatNumber(circle[1] ?? 0));
      gradient.setAttribute("r", formatNumber(Number(pattern[7]) || 0));
    } else {
      return undefined;
    }
    gradient.setAttribute("id", id);
    gradient.setAttribute("gradientUnits", "userSpaceOnUse");
    for (const rawStop of stops) {
      if (!Array.isArray(rawStop)) continue;
      const stop = createSvgElement("stop");
      stop.setAttribute("offset", String(rawStop[0] ?? 0));
      stop.setAttribute("stop-color", String(rawStop[1] ?? "#000000"));
      gradient.appendChild(stop);
    }
    this.defs.appendChild(gradient);
    return `url(#${id})`;
  }

  private paintFormXObjectBegin(rawMatrix: unknown, rawBox: unknown): void {
    const matrix = numericArray(rawMatrix);
    if (matrix?.length === 6) this.transform(matrix);
    const box = numericArray(rawBox);
    if (!box || box.length < 4) return;
    const rectangle = createSvgElement("rect");
    rectangle.setAttribute("x", formatNumber(box[0] ?? 0));
    rectangle.setAttribute("y", formatNumber(box[1] ?? 0));
    rectangle.setAttribute("width", formatNumber((box[2] ?? 0) - (box[0] ?? 0)));
    rectangle.setAttribute("height", formatNumber((box[3] ?? 0) - (box[1] ?? 0)));
    this.current.element = rectangle;
    this.pendingClip = "nonzero";
    this.endPath();
  }

  private applyBlendMode(element: SVGElement): void {
    if (this.current.blendMode !== "normal") {
      element.style.mixBlendMode = this.current.blendMode;
    }
  }

  private ensureClipGroup(): SVGGElement {
    if (!this.current.clipGroup) {
      const group = createSvgElement("g");
      group.setAttribute("clip-path", this.current.activeClipUrl ?? "");
      this.root.appendChild(group);
      this.current.clipGroup = group;
    }
    return this.current.clipGroup;
  }

  private ensureTransformGroup(): SVGGElement {
    if (!this.transformGroup) {
      const group = createSvgElement("g");
      group.setAttribute("transform", matrixString(this.transformMatrix));
      const parent = this.current.activeClipUrl ? this.ensureClipGroup() : this.root;
      parent.appendChild(group);
      this.transformGroup = group;
    }
    return this.transformGroup;
  }
}
