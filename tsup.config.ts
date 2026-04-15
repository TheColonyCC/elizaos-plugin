import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
  sourcemap: true,
  clean: true,
  format: ["esm"],
  dts: true,
  external: [
    "@elizaos/core",
    "@thecolony/sdk",
    "dotenv",
    "fs",
    "path",
    "node:fs",
    "node:path",
    "node:http",
    "node:https",
    "node:crypto",
    "node:os",
    "node:url",
    "http",
    "https",
  ],
});
