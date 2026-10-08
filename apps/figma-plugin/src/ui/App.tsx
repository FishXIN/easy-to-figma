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

type Status = "idle" | "parsing" | "ready" | "importing" | "success" | "error";
type FileFormat = "pptx" | "psd" | "ai";

interface ImportResult {
  pageCount: number;
  nodeCount: number;
  missingFonts: string[];
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

function FormatIcon({ format }: { format: FileFormat }) {
  const Icon = formatDetails[format].icon;
  return <Icon aria-hidden="true" size={19} strokeWidth={1.8} />;
}

export function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File>();
  const [format, setFormat] = useState<FileFormat>();
  const [document, setDocument] = useState<IRDocument>();
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState("");
  const [options, setOptions] = useState<ParseOptions>(DEFAULT_PARSE_OPTIONS);
  const [parseProgress, setParseProgress] = useState<IllustratorParseProgress>();
  const [showReport, setShowReport] = useState(false);

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
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const reset = useCallback(() => {
    setStatus("idle");
    setFile(undefined);
    setFormat(undefined);
    setDocument(undefined);
    setResult(undefined);
    setError("");
    setParseProgress(undefined);
    setShowReport(false);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleFile = useCallback(
    async (nextFile: File) => {
      const nextFormat = detectFormat(nextFile);
      if (!nextFormat) {
        setError("Choose a PPTX, PSD, AI, SVG or PDF-compatible AI file.");
        setStatus("error");
        return;
      }
      const sizeLimit =
        nextFormat === "ai" ? MAX_ILLUSTRATOR_FILE_SIZE : MAX_STANDARD_FILE_SIZE;
      if (nextFile.size > sizeLimit) {
        setError(
          `This file is larger than ${formatBytes(sizeLimit)}. Optimize it before importing.`,
        );
        setStatus("error");
        return;
      }

      setFile(nextFile);
      setFormat(nextFormat);
      setStatus("parsing");
      setError("");
      setDocument(undefined);
      setResult(undefined);
      setParseProgress(undefined);
      try {
        const parsed = await parseFile(nextFile, nextFormat, options, setParseProgress);
        setDocument(parsed);
        setStatus("ready");
      } catch (parseError) {
        setError(parseError instanceof Error ? parseError.message : "The file could not be parsed.");
        setStatus("error");
      }
    },
    [options],
  );

  const importDocument = () => {
    if (!document) return;
    setStatus("importing");
    sendToPlugin({ type: "import-document", document });
    if (window.parent === window) {
      window.setTimeout(() => {
        setResult({
          pageCount: document.pages.length,
          nodeCount: document.report.parsedNodes,
          missingFonts: [],
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
              const droppedFile = event.dataTransfer.files[0];
              if (droppedFile) void handleFile(droppedFile);
            }}
          >
            <div className="drop-icon" aria-hidden="true">
              <UploadCloud size={25} strokeWidth={1.7} />
            </div>
            <h2>Drop a source file</h2>
            <p>PPTX, PSD, AI, SVG or PDF-compatible AI</p>
            <button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>
              Choose file
            </button>
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept=".pptx,.psd,.ai,.svg,.pdf"
              onChange={(event) => {
                const selectedFile = event.target.files?.[0];
                if (selectedFile) void handleFile(selectedFile);
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

      {(status === "parsing" || status === "ready" || status === "importing") && file && format && (
        <section className="work-area">
          <div className="file-summary">
            <span className={`format-icon format-${format}`}>
              <FormatIcon format={format} />
            </span>
            <span className="file-name">
              <strong title={file.name}>{file.name}</strong>
              <small>
                {formatDetails[format].label} · {formatBytes(file.size)}
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

          {status === "ready" && document && report && (
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

              <button className="primary-button" type="button" onClick={importDocument}>
                <Import size={17} />
                Import to canvas
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
          <p>{file.name} is now on the Figma canvas.</p>
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
          {result.missingFonts.length > 0 && (
            <div className="font-warning">
              <AlertCircle size={16} />
              <span>{result.missingFonts.join(", ")} replaced with an available font.</span>
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
