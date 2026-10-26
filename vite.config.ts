
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const ortDist = dirname(require.resolve("onnxruntime-web"));

export default defineConfig(({ command, mode }) => ({
  // Vite dev is served from the origin root. GitHub Pages publishes this
  // project under its repository path, so only build/preview use that prefix.
  base: command === "serve" && mode === "development" ? "/" : "/semantica_web/",

  plugins: [react()],

  optimizeDeps: {
    // The core is excluded because its browser entry contains ?url imports.
    // Force its CommonJS OCR dependency through esbuild so named exports such
    // as PSM are available to native browser modules.
    include: ["tesseract.js"],
    exclude: [
      // This package's browser entry uses Vite's ?url asset import for the
      // PDF.js worker. Let Vite transform that entry instead of esbuild's
      // dependency scanner, which treats the query as part of the filename.
      "@semantica/semantica-wasm",
      "onnxruntime-web",
      "onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs",
      "onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm",
    ],
  },

  resolve: {
    alias: [
      {
        find: /^onnxruntime-web\/dist\/(ort-wasm-simd-threaded\.jsep\.(?:mjs|wasm))/,
        replacement: `${ortDist}/$1`,
      },
    ],
  },

  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },

    proxy: {
      "/api": process.env.VITE_API_PROXY ?? "http://localhost:3000",
    },
  },

  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },

  worker: {
    format: "es",
  },
}));

