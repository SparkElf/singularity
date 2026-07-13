import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const typescriptFiles = [
  "apps/web/**/*.{ts,tsx}",
  "packages/protyle-browser/src/**/*.{ts,tsx}",
];
const reactFiles = ["apps/web/src/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/playwright-report/**",
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
    files: typescriptFiles,
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
);
