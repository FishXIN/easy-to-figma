import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const directory = fileURLToPath(new URL(".", import.meta.url));

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inlineFigmaUi(): Plugin {
  return {
    name: "inline-figma-ui",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlKey = Object.keys(bundle).find((key) => key.endsWith(".html"));
      if (!htmlKey) throw new Error("Vite did not emit an HTML entry.");
      const htmlAsset = bundle[htmlKey];
      if (!htmlAsset || htmlAsset.type !== "asset" || typeof htmlAsset.source !== "string") {
        throw new Error("The emitted HTML entry is invalid.");
      }

      let html = htmlAsset.source;
      for (const [key, output] of Object.entries(bundle)) {
        if (key === htmlKey) continue;
        const filePattern = escapeExpression(output.fileName);
        if (output.type === "chunk") {
          const scriptPattern = new RegExp(
            `<script[^>]+src=["'](?:\\./|/)?${filePattern}["'][^>]*></script>`,
          );
          const inlineCode = output.code
            .replaceAll("__VITE_PRELOAD__", "void 0")
            .replaceAll("</script", "<\\/script");
          html = html.replace(
            scriptPattern,
            () => `<script type="module">\n${inlineCode}\n</script>`,
          );
          delete bundle[key];
        } else if (output.fileName.endsWith(".css")) {
          const stylePattern = new RegExp(
            `<link[^>]+href=["'](?:\\./|/)?${filePattern}["'][^>]*>`,
          );
          html = html.replace(
            stylePattern,
            () => `<style>\n${String(output.source).replaceAll("</style", "<\\/style")}\n</style>`,
          );
          delete bundle[key];
        }
      }
      if (html.includes("__VITE_PRELOAD__")) {
        throw new Error("Vite emitted an unresolved preload marker in the inlined plugin UI.");
      }
      htmlAsset.source = html;
    },
  };
}

export default defineConfig({
  root: resolve(directory, "src/ui"),
  base: "./",
  plugins: [react(), inlineFigmaUi()],
  build: {
    outDir: resolve(directory, "dist"),
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    target: "es2022",
    rollupOptions: {
      input: resolve(directory, "src/ui/index.html"),
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
  },
});
