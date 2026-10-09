import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Import,
  Layers3,
  PenTool,
  RotateCcw,
  UploadCloud,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  collectRequestedFonts,
  fontKey,
  type FontAnalysis,
  type FontDescriptor,
  type FontReplacementMap,
  type FontSubstitution,
} from "@easy-to-figma/figma-renderer";
import {
  parseIllustrator,
  type IllustratorParseProgress,
} from "@easy-to-figma/parser-ai";
import { parsePptx } from "@easy-to-figma/parser-pptx";
import { parsePsd } from "@easy-to-figma/parser-psd";
import {
  DEFAULT_PARSE_OPTIONS,
  type IRDocument,
  type ImportReport,
  type ParseOptions,
} from "@easy-to-figma/ir-schema";
import JSZip from "jszip";

type Status =
  | "idle"
  | "parsing"
  | "analyzing"
  | "ready"
  | "importing"
  | "success"
  | "error";
type FileFormat = "pptx" | "psd" | "ai";

interface ImportResult {
  pageCount: number;
  nodeCount: number;
  missingFonts: string[];
  fontSubstitutions: FontSubstitution[];
}

const MAX_STANDARD_FILE_SIZE = 500 * 1024 * 1024;
const MAX_ILLUSTRATOR_FILE_SIZE = 1.5 * 1024 * 1024 * 1024;

const formatDetails: Record<
  FileFormat,
  { label: string; extension: string; description: string; icon: typeof FileText }
> = {
  pptx: {
    label: "PowerPoint",
    extension: "PPTX",
    description: "Slides, text, shapes and images",
    icon: FileText,
  },
  psd: {
    label: "Photoshop",
    extension: "PSD",
    description: "Groups, text and pixel layers",
    icon: Layers3,
  },
  ai: {
    label: "Illustrator",
    extension: "AI / SVG",
    description: "Artboards, paths, text and images",
    icon: PenTool,
  },
};

function detectFormat(file: File): FileFormat | undefined {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pptx") return "pptx";
  if (extension === "psd") return "psd";
  if (extension === "ai" || extension === "svg" || extension === "pdf") return "ai";
  return undefined;
}

function isZipFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".zip");
}

async function expandSelectedFiles(files: File[]): Promise<File[]> {
  const expanded: File[] = [];
  for (const file of files) {
    if (!isZipFile(file)) {
      expanded.push(file);
      continue;
    }
    const archive = await JSZip.loadAsync(file);
    const entries = Object.values(archive.files)
      .filter((entry) => !entry.dir && /\.(pptx|psd|ai|svg|pdf)$/i.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    for (const entry of entries) {
      const data = await entry.async("uint8array");
      const name = entry.name.split("/").pop() ?? entry.name;
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);
      expanded.push(new File([buffer], name));
    }
  }
  if (expanded.length === 0) {
    throw new Error("The ZIP archive does not contain any supported source files.");
  }
  return expanded;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sendToPlugin(message: unknown): void {
  window.parent.postMessage({ pluginMessage: message }, "*");
}

async function parseFile(
  file: File,
  format: FileFormat,
  options: ParseOptions,
  onProgress: (progress: IllustratorParseProgress) => void,
): Promise<IRDocument> {
  if (format === "ai") {
    return parseIllustrator(file, file.name, options, { onProgress });
  }
  const buffer = await file.arrayBuffer();
  if (format === "pptx") return parsePptx(buffer, file.name, options);
  return parsePsd(buffer, file.name, options);
}

function mergeDocuments(documents: IRDocument[], files: File[]): IRDocument {
  const [first] = documents;
  if (!first) throw new Error("No documents were parsed.");
  const missingFonts = new Set(documents.flatMap((document) => document.report.missingFonts));
  const sourceName =
    files.length === 1 ? files[0]?.name ?? first.source.name : `${files.length} selected files`;

  return {
    version: first.version,
    source: {
      name: sourceName,
      format: first.source.format,
      byteSize: files.reduce((total, file) => total + file.size, 0),
    },
    pages: documents.flatMap((document) => document.pages),
    assets: documents.flatMap((document) => document.assets),
    report: {
      sourceFormat: first.report.sourceFormat,
      sourceName,
      parsedNodes: documents.reduce((total, document) => total + document.report.parsedNodes, 0),
      editableNodes: documents.reduce((total, document) => total + document.report.editableNodes, 0),
      rasterizedNodes: documents.reduce((total, document) => total + document.report.rasterizedNodes, 0),
      skippedNodes: documents.reduce((total, document) => total + document.report.skippedNodes, 0),
      missingFonts: [...missingFonts],
      items: documents.flatMap((document) =>
        document.report.items.map((item) => ({
          ...item,
          pageName: item.pageName ?? document.source.name,
        })),
      ),
    },
  };
}

function FormatIcon({ format }: { format: FileFormat }) {
  const Icon = formatDetails[format].icon;
  return <Icon aria-hidden="true" size={19} strokeWidth={1.8} />;
}

export function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const fontAnalysisRequestRef = useRef(0);
  const [status, setStatus] = useState<Status>("idle");
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState<FileFormat>();
  const [document, setDocument] = useState<IRDocument>();
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState("");
  const [options, setOptions] = useState<ParseOptions>(DEFAULT_PARSE_OPTIONS);
  const [parseProgress, setParseProgress] = useState<IllustratorParseProgress>();
  const [showReport, setShowReport] = useState(false);
  const [fontAnalysis, setFontAnalysis] = useState<FontAnalysis>();
  const [fontReplacements, setFontReplacements] = useState<FontReplacementMap>({});
  const file = files[0];
  const totalFileSize = files.reduce((total, current) => total + current.size, 0);
  const fileLabel = files.length === 1 ? file?.name ?? "" : `${files.length} files selected`;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data?.pluginMessage ?? event.data;
      if (message?.type === "import-complete") {
        setResult(message.result as ImportResult);
        setDocument((current) =>
          current ? { ...current, report: (message.report as ImportReport) ?? current.report } : current,
        );
        setStatus("success");
      }
      if (message?.type === "import-error") {
        setError(message.message ?? "Figma could not create the imported layers.");
        setStatus("error");
      }
      if (
        message?.type === "font-analysis-complete" &&
        message.requestId === fontAnalysisRequestRef.current
      ) {
        const analysis = message.analysis as FontAnalysis;
        setFontAnalysis(analysis);
        setFontReplacements(
          Object.fromEntries(
            analysis.missingFonts.map((missing) => [missing.key, missing.suggested]),
          ),
        );
        setStatus("ready");
      }
      if (
        message?.type === "font-analysis-error" &&
        message.requestId === fontAnalysisRequestRef.current
      ) {
        setError(message.message ?? "Figma could not inspect the available fonts.");
        setStatus("error");
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const reset = useCallback(() => {
    fontAnalysisRequestRef.current += 1;
    setStatus("idle");
    setFiles([]);
    setFormat(undefined);
    setDocument(undefined);
    setResult(undefined);
    setError("");
    setParseProgress(undefined);
    setShowReport(false);
    setFontAnalysis(undefined);
    setFontReplacements({});
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleFiles = useCallback(
    async (nextFiles: File[]) => {
      if (nextFiles.length === 0) return;
      const oversizedArchive = nextFiles.find(
        (nextFile) => isZipFile(nextFile) && nextFile.size > MAX_ILLUSTRATOR_FILE_SIZE,
      );
      if (oversizedArchive) {
        setError(
          `${oversizedArchive.name} is larger than ${formatBytes(MAX_ILLUSTRATOR_FILE_SIZE)}. Optimize it before importing.`,
        );
        setStatus("error");
        return;
      }
      setStatus("parsing");
      setError("");
      setDocument(undefined);
      setResult(undefined);
      setParseProgress(undefined);
      setFontAnalysis(undefined);
      setFontReplacements({});
      try {
        const expandedFiles = await expandSelectedFiles(nextFiles);
        const detectedFormats = expandedFiles.map((nextFile) => detectFormat(nextFile));
        if (detectedFormats.some((detectedFormat) => detectedFormat === undefined)) {
          throw new Error("Choose PPTX, PSD, AI, SVG, PDF-compatible AI or a ZIP bundle.");
        }
        const oversizedFile = expandedFiles.find((nextFile, index) => {
          const sizeLimit =
            detectedFormats[index] === "ai" ? MAX_ILLUSTRATOR_FILE_SIZE : MAX_STANDARD_FILE_SIZE;
          return nextFile.size > sizeLimit;
        });
        if (oversizedFile) {
          const oversizedFormat = detectFormat(oversizedFile);
          const sizeLimit =
            oversizedFormat === "ai" ? MAX_ILLUSTRATOR_FILE_SIZE : MAX_STANDARD_FILE_SIZE;
          throw new Error(
            `${oversizedFile.name} is larger than ${formatBytes(sizeLimit)}. Optimize it before importing.`,
          );
        }
        setFiles(expandedFiles);
        setFormat(detectedFormats[0]);
        const parsedDocuments: IRDocument[] = [];
        for (const [index, nextFile] of expandedFiles.entries()) {
          const nextFormat = detectedFormats[index];
          if (!nextFormat) continue;
          const parsed = await parseFile(nextFile, nextFormat, options, setParseProgress);
          parsedDocuments.push(parsed);
        }
        const mergedDocument = mergeDocuments(parsedDocuments, expandedFiles);
        const requestedFonts = collectRequestedFonts(mergedDocument);
        setDocument(mergedDocument);
        setStatus("analyzing");
        const requestId = fontAnalysisRequestRef.current + 1;
        fontAnalysisRequestRef.current = requestId;
        sendToPlugin({ type: "analyze-fonts", requestId, requestedFonts });
        if (window.parent === window) {
          const fallbackFont = requestedFonts[0] ?? { family: "Inter", style: "Regular" };
          window.setTimeout(() => {
            if (fontAnalysisRequestRef.current !== requestId) return;
            setFontAnalysis({
              requestedFonts,
              availableFonts: requestedFonts,
              missingFonts: [],
              fallbackFont,
            });
            setFontReplacements({});
            setStatus("ready");
          }, 250);
        }
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : "The file could not be parsed.");
        setStatus("error");
      }
    },
    [options],
  );

  const importDocument = () => {
    if (!document || !fontAnalysis) return;
    setStatus("importing");
    sendToPlugin({ type: "import-document", document, fontReplacements });
    if (window.parent === window) {
      window.setTimeout(() => {
        setResult({
          pageCount: document.pages.length,
          nodeCount: document.report.parsedNodes,
          missingFonts: [],
          fontSubstitutions: [],
        });
        setStatus("success");
      }, 700);
    }
  };

  const report = document?.report;
  const warningCount =
    report?.items.filter((item) => item.level === "warning" || item.level === "fallback").length ?? 0;
  const parsePercent = Math.round((parseProgress?.progress ?? 0) * 100);
  const parseStatus =
    parseProgress?.pageCount && parseProgress.page > 0
      ? `${parseProgress.phase === "encoding" ? "Encoding" : "Rendering"} artboard ${parseProgress.page} of ${parseProgress.pageCount}`
      : "Resolving document structure";
  const unresolvedFontCount =
    fontAnalysis?.missingFonts.filter((missing) => !fontReplacements[missing.key]).length ?? 0;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-mark" aria-hidden="true">
          <span>E</span>
          <span>F</span>
        </div>
        <div className="brand-copy">
          <h1>Easy to Figma</h1>
          <p>Bring source files in as editable layers.</p>
        </div>
        {status !== "idle" && (
          <button className="icon-button" type="button" onClick={reset} aria-label="Start over" title="Start over">
            <RotateCcw size={17} />
          </button>
        )}
      </header>

      {status === "idle" && (
        <>
          <section
            className={`drop-zone ${isDragging ? "is-dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              event.preventDefault();
              if (event.currentTarget === event.target) setIsDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const droppedFiles = Array.from(event.dataTransfer.files);
              if (droppedFiles.length > 0) void handleFiles(droppedFiles);
            }}
          >
            <div className="drop-icon" aria-hidden="true">
              <UploadCloud size={25} strokeWidth={1.7} />
            </div>
            <h2>Drop source files</h2>
            <p>PPTX, PSD, AI, SVG, PDF-compatible AI or ZIP</p>
            <button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>
              Choose file
            </button>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              multiple
              accept=".pptx,.psd,.ai,.svg,.pdf,.zip"
              onChange={(event) => {
                const selectedFiles = Array.from(event.target.files ?? []);
                if (selectedFiles.length > 0) void handleFiles(selectedFiles);
              }}
            />
          </section>

          <section className="format-list" aria-label="Supported formats">
            {(Object.keys(formatDetails) as FileFormat[]).map((item) => {
              const details = formatDetails[item];
              return (
                <div className="format-row" key={item}>
                  <span className={`format-icon format-${item}`}>
                    <FormatIcon format={item} />
                  </span>
                  <span className="format-name">
                    <strong>{details.label}</strong>
                    <small>{details.description}</small>
                  </span>
                  <span className="extension">{details.extension}</span>
                </div>
              );
            })}
          </section>

          <section className="settings-section" aria-labelledby="settings-title">
            <div className="section-heading">
              <h2 id="settings-title">Import settings</h2>
              <span>Applied before parsing</span>
            </div>
            <div className="setting-row">
              <div>
                <strong>Text handling</strong>
                <small>Choose editability or visual fidelity.</small>
              </div>
              <div className="segmented-control" aria-label="Text handling">
                <button
                  type="button"
                  className={options.textMode === "editable" ? "is-active" : ""}
                  onClick={() => setOptions((current) => ({ ...current, textMode: "editable" }))}
                >
                  Editable
                </button>
                <button
                  type="button"
                  className={options.textMode === "visual" ? "is-active" : ""}
                  onClick={() => setOptions((current) => ({ ...current, textMode: "visual" }))}
                >
                  Visual
                </button>
              </div>
            </div>
            <label className="setting-row select-row">
              <span>
                <strong>Unsupported effects</strong>
                <small>Keep appearance or omit those layers.</small>
              </span>
              <select
                value={options.unsupportedStrategy}
                onChange={(event) =>
                  setOptions((current) => ({
                    ...current,
                    unsupportedStrategy: event.target.value as ParseOptions["unsupportedStrategy"],
                  }))
                }
              >
                <option value="rasterize">Rasterize</option>
                <option value="skip">Skip</option>
              </select>
            </label>
          </section>
        </>
      )}

      {(status === "parsing" ||
        status === "analyzing" ||
        status === "ready" ||
        status === "importing") &&
        file &&
        format && (
        <section className="work-area">
          <div className="file-summary">
            <span className={`format-icon format-${format}`}>
              <FormatIcon format={format} />
            </span>
            <span className="file-name">
              <strong title={files.map((current) => current.name).join("\n")}>{fileLabel}</strong>
              <small>
                {files.length === 1 ? formatDetails[format].label : "Batch import"} ·{" "}
                {formatBytes(totalFileSize)}
              </small>
            </span>
            {status === "ready" && (
              <button className="icon-button" type="button" onClick={reset} aria-label="Remove file" title="Remove file">
                <X size={17} />
              </button>
            )}
          </div>

          {status === "parsing" && (
            <div className="progress-state" role="status">
              <span className="spinner" />
              <strong>{parseStatus}</strong>
              <p>
                {parseProgress?.pageCount
                  ? `${parsePercent}% · preserving artwork at 2x`
                  : "Resolving layers, assets and editable content."}
              </p>
              <span className="progress-track">
                <span
                  className={parseProgress?.pageCount ? "is-determinate" : ""}
                  style={parseProgress?.pageCount ? { width: `${Math.max(2, parsePercent)}%` } : undefined}
                />
              </span>
            </div>
          )}

          {status === "analyzing" && (
            <div className="progress-state" role="status">
              <span className="spinner" />
              <strong>Checking source fonts</strong>
              <p>Matching every family and style against fonts available in Figma.</p>
              <span className="progress-track">
                <span />
              </span>
            </div>
          )}

          {status === "ready" && document && report && fontAnalysis && (
            <>
              <div className="ready-state">
                <span className="status-check" aria-hidden="true">
                  <Check size={18} strokeWidth={2.4} />
                </span>
                <div>
                  <strong>Ready to import</strong>
                  <p>
                    {document.pages.length} {document.pages.length === 1 ? "page" : "pages"} ·{" "}
                    {report.parsedNodes} layers found
                  </p>
                </div>
              </div>

              <div className="metrics" aria-label="Import summary">
                <div>
                  <strong>{report.editableNodes}</strong>
                  <span>Editable</span>
                </div>
                <div>
                  <strong>{report.rasterizedNodes}</strong>
                  <span>Rasterized</span>
                </div>
                <div>
                  <strong>{warningCount}</strong>
                  <span>Notes</span>
                </div>
              </div>

              {fontAnalysis.missingFonts.length > 0 && (
                <section className="font-replacement-panel" aria-labelledby="missing-fonts-title">
                  <div className="font-replacement-heading">
                    <AlertCircle size={16} />
                    <span>
                      <strong id="missing-fonts-title">
                        {fontAnalysis.missingFonts.length} missing font
                        {fontAnalysis.missingFonts.length === 1 ? "" : "s"}
                      </strong>
                      <small>Choose a replacement before importing.</small>
                    </span>
                  </div>
                  <div className="font-replacement-list">
                    {fontAnalysis.missingFonts.map((missing) => (
                      <label className="font-replacement-row" key={missing.key}>
                        <span title={`${missing.requested.family} ${missing.requested.style}`}>
                          <strong>{missing.requested.family}</strong>
                          <small>{missing.requested.style}</small>
                        </span>
                        <select
                          aria-label={`Replace ${missing.requested.family} ${missing.requested.style}`}
                          value={
                            fontReplacements[missing.key]
                              ? fontKey(fontReplacements[missing.key]!)
                              : ""
                          }
                          onChange={(event) => {
                            const replacement = fontAnalysis.availableFonts.find(
                              (font) => fontKey(font) === event.target.value,
                            );
                            setFontReplacements((current) => {
                              const next = { ...current };
                              if (replacement) next[missing.key] = replacement;
                              else delete next[missing.key];
                              return next;
                            });
                          }}
                        >
                          <option value="">Choose replacement</option>
                          {fontAnalysis.availableFonts.map((font) => (
                            <option key={fontKey(font)} value={fontKey(font)}>
                              {font.family} · {font.style}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </section>
              )}

              <button
                className="report-toggle"
                type="button"
                onClick={() => setShowReport((current) => !current)}
                aria-expanded={showReport}
              >
                <span>Conversion report</span>
                {showReport ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {showReport && (
                <div className="report-list">
                  {report.items.length ? (
                    report.items.map((item, index) => (
                      <div className={`report-item report-${item.level}`} key={`${item.code}-${index}`}>
                        <span className="report-dot" />
                        <span>
                          <strong>{item.nodeName ?? item.code.replaceAll("_", " ")}</strong>
                          <small>{item.message}</small>
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="empty-report">No conversion notes.</p>
                  )}
                </div>
              )}

              <button
                className="primary-button"
                type="button"
                onClick={importDocument}
                disabled={unresolvedFontCount > 0}
              >
                <Import size={17} />
                {unresolvedFontCount > 0
                  ? `Choose ${unresolvedFontCount} font replacement${unresolvedFontCount === 1 ? "" : "s"}`
                  : "Import to canvas"}
              </button>
            </>
          )}

          {status === "importing" && (
            <div className="progress-state" role="status">
              <span className="spinner" />
              <strong>Creating Figma layers</strong>
              <p>Loading fonts, placing assets and restoring hierarchy.</p>
              <span className="progress-track">
                <span />
              </span>
            </div>
          )}
        </section>
      )}

      {status === "success" && file && result && (
        <section className="result-state">
          <span className="result-icon" aria-hidden="true">
            <Check size={26} strokeWidth={2.4} />
          </span>
          <h2>Import complete</h2>
          <p>{fileLabel} {files.length === 1 ? "is" : "are"} now on the Figma canvas.</p>
          <div className="result-stats">
            <span>
              <strong>{result.pageCount}</strong>
              Pages
            </span>
            <span>
              <strong>{result.nodeCount}</strong>
              Layers
            </span>
            <span>
              <strong>{result.missingFonts.length}</strong>
              Font swaps
            </span>
          </div>
          {result.fontSubstitutions.length > 0 && (
            <div className="font-warning">
              <AlertCircle size={16} />
              <span>
                {result.fontSubstitutions
                  .map(
                    ({ requested, replacement }: {
                      requested: FontDescriptor;
                      replacement: FontDescriptor;
                    }) =>
                      `${requested.family} ${requested.style} → ${replacement.family} ${replacement.style}`,
                  )
                  .join("; ")}
              </span>
            </div>
          )}
          <button className="primary-button" type="button" onClick={reset}>
            Import another file
          </button>
        </section>
      )}

      {status === "error" && (
        <section className="error-state" role="alert">
          <span className="error-icon" aria-hidden="true">
            <AlertCircle size={24} />
          </span>
          <h2>Could not import this file</h2>
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={reset}>
            <ArrowLeft size={16} />
            Choose another file
          </button>
        </section>
      )}

      <footer className="app-footer">
        <span>Free and open source</span>
        <span>Files stay on your device</span>
      </footer>
    </main>
  );
}
