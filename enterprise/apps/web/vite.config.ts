import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import runtimeAssets from "./protyle-runtime-assets.json";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(webRoot, "../../..");
const runtimePublicDirectory = resolve(webRoot, runtimeAssets.publicDirectory);
const runtimeVersion = encodeURIComponent(runtimeAssets.upstreamVersion);

const e2eApiOrigin = process.env.SINGULARITY_E2E_API_ORIGIN;
const e2eProxy = e2eApiOrigin === undefined
  ? undefined
  : {
      "/api": {
        changeOrigin: false,
        secure: false,
        target: e2eApiOrigin,
        ws: true,
      },
    };

function loadE2EHttps() {
  const certificateFile = process.env.SINGULARITY_E2E_WEB_CERT_FILE;
  const privateKeyFile = process.env.SINGULARITY_E2E_WEB_KEY_FILE;
  if (certificateFile === undefined && privateKeyFile === undefined) {
    return undefined;
  }
  if (certificateFile === undefined || privateKeyFile === undefined) {
    throw new Error("P5 E2E HTTPS configuration is incomplete");
  }
  return {
    cert: readFileSync(certificateFile),
    key: readFileSync(privateKeyFile),
  };
}

const e2eHttps = loadE2EHttps();

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
  },
  server: {
    fs: {
      allow: [repositoryRoot],
    },
    port: 4173,
    strictPort: true,
    ...(e2eHttps === undefined ? {} : { https: e2eHttps }),
    ...(e2eProxy === undefined ? {} : { proxy: e2eProxy }),
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    ...(e2eHttps === undefined ? {} : { https: e2eHttps }),
    ...(e2eProxy === undefined ? {} : { proxy: e2eProxy }),
  },
  test: {
    environment: "jsdom",
    // 浏览器 API 合同测试替换全局 fetch；串行文件才能保持每个 fixture 的全局所有权。
    fileParallelism: false,
    include: ["src/**/*.test.{js,ts,tsx}"],
    setupFiles: "./src/test/setup.ts",
  },
}));
