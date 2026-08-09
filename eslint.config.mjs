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
    // Local PostgreSQL install (scripts/db.mjs). Flat config does not read
    // .gitignore, and the EDB bundle ships pgAdmin's JavaScript — linting it
    // produces thousands of irrelevant findings.
    ".localdb*/**",
  ]),
]);

export default eslintConfig;
