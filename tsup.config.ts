import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  target: "node20",
  format: ["esm"],
  clean: true,
  bundle: true,
  skipNodeModulesBundle: true,
  outDir: "dist",
  splitting: false,
  platform: "node",
});
