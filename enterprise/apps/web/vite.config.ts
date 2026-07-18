import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import runtimeAssets from "./protyle-runtime-assets.json";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(webRoot, "../../..");
const runtimePublicDirectory = resolve(webRoot, runtimeAssets.publicDirectory);
const runtimeVersion = encodeURIComponent(runtimeAssets.upstreamVersion);

export default defineConfig(({ mode }) => ({
  define: {
    NODE_ENV: JSON.stringify(mode),
    SIYUAN_VERSION: JSON.stringify(runtimeAssets.upstreamVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "protyle-runtime-assets",
      transformIndexHtml() {
        return [
          {
            tag: "link",
            attrs: {
              href: `/${runtimeAssets.style.theme.target}?v=${runtimeVersion}`,
              rel: "stylesheet",
            },
            injectTo: "head-prepend",
          },
          {
            tag: "link",
            attrs: {
              href: `/${runtimeAssets.style.target}?v=${runtimeVersion}`,
              rel: "stylesheet",
            },
            injectTo: "head",
          },
          ...runtimeAssets.browserScripts.map((script) => ({
            tag: "script",
            attrs: {
              src: `/${script}?v=${runtimeVersion}`,
            },
            injectTo: "body-prepend" as const,
          })),
        ];
      },
    },
  ],
  publicDir: runtimePublicDirectory,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    conditions: ["development"],
  },
  server: {
    fs: {
      allow: [repositoryRoot],
    },
    port: 4173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{js,ts,tsx}"],
    setupFiles: "./src/test/setup.ts",
  },
}));
