import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const browserTypescriptFiles = [
  "apps/web/**/*.{ts,tsx}",
  "packages/protyle-browser/src/**/*.{ts,tsx}",
];
const nodeTypescriptFiles = [
  "apps/api/**/*.ts",
  "packages/authorization/**/*.ts",
  "packages/contracts/**/*.ts",
  "packages/database/**/*.ts",
  "packages/kernel-client/**/*.ts",
];
const typescriptFiles = [...browserTypescriptFiles, ...nodeTypescriptFiles];
const reactFiles = ["apps/web/src/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "**/src/generated/**",
      "**/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    ...reactHooks.configs.flat["recommended-latest"],
    files: reactFiles,
  },
  {
    ...reactRefresh.configs.vite,
    files: reactFiles,
    rules: {
      ...reactRefresh.configs.vite.rules,
      "react-refresh/only-export-components": [
        "error",
        { allowExportNames: ["buttonVariants", "useSidebar"] },
      ],
    },
  },
  {
    files: browserTypescriptFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: nodeTypescriptFiles,
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: [
      "apps/api/src/**/*.ts",
      "packages/authorization/src/**/*.ts",
      "packages/contracts/src/**/*.ts",
      "packages/database/src/**/*.ts",
      "packages/kernel-client/src/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@singularity/database/testing/postgres",
              message: "The PostgreSQL test lifecycle is not a production API.",
            },
          ],
        },
      ],
    },
  },
);
