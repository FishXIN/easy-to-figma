import { renderDocument } from "@easy-to-figma/figma-renderer";
import type { IRDocument } from "@easy-to-figma/ir-schema";

type PluginMessage =
  | { type: "import-document"; document: IRDocument }
  | { type: "resize"; width: number; height: number }
  | { type: "close" };

figma.showUI(__html__, {
  width: 420,
  height: 680,
  themeColors: true,
});

figma.ui.onmessage = async (message: PluginMessage) => {
  if (message.type === "resize") {
    figma.ui.resize(
      Math.max(360, Math.min(560, message.width)),
      Math.max(480, Math.min(800, message.height)),
    );
    return;
  }

  if (message.type === "close") {
    figma.closePlugin();
    return;
  }

  if (message.type !== "import-document") return;

  try {
    const result = await renderDocument(message.document);
    figma.ui.postMessage({
      type: "import-complete",
      result,
      report: message.document.report,
    });
    figma.notify(
      `Imported ${result.pageCount} ${result.pageCount === 1 ? "page" : "pages"} and ${result.nodeCount} layers.`,
      { timeout: 3500 },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown renderer error";
    figma.ui.postMessage({ type: "import-error", message: detail });
    figma.notify(`Import failed: ${detail}`, { error: true, timeout: 5000 });
  }
};

figma.ui.postMessage({ type: "plugin-ready" });
