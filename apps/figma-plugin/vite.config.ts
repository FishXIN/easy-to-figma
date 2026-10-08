import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const directory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(directory, "src/ui"),
  base: "./",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve(directory, "dist"),
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
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
