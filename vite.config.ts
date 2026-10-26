
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const ortDist = dirname(require.resolve("onnxruntime-web"));

export default defineConfig({
  // Ruta base del repositorio en GitHub Pages
  base: "/semantica_web/",

  plugins: [react()],

  optimizeDeps: {
    exclude: [
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
});

