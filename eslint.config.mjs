// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // The coordinator/client implementation is ported from Drop core, where it
    // was linted under a lighter config, and the addon tsconfigs relax
    // exactOptionalPropertyTypes/noUncheckedIndexedAccess. Keep the strict preset
    // for new code but don't fail the port on rules it cannot satisfy.
    files: ["packages/drop-addon-server/src/**/*.ts", "packages/drop-addon-client/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-useless-assignment": "off",
    },
  },
  {
    // Tests use node:test fixtures with stub async methods and fire-and-forget
    // assertions; the type-aware strict rules are noise here.
    files: ["packages/**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
    },
  },
  {
    // Type-aware linting requires a tsconfig project; plain JS config files
    // (this file included) are outside any project, so disable type-checked
    // rules for them instead of failing to parse.
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.{js,mjs,cjs}"],
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".research/**", "packages/gse-engine/target/**"],
  },
);
