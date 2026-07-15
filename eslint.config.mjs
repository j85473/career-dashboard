import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated/third-party artifacts and a retired one-time SQLite migration
    // are not maintained application source.
    "prisma/generated/**",
    "scratch/**",
    "scripts/migrate_old_dbs.ts",
  ]),
  {
    files: ["scripts/**/*.{cjs,js,mjs,ts}", "src/scripts/**/*.{cjs,js,mjs,ts}", "*.{cjs,js,mjs,ts}"],
    rules: {
      // Utility scripts consume several untyped third-party payloads and older
      // CommonJS-only packages. Keep the stricter rules for the shipped app.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
]);

export default eslintConfig;
