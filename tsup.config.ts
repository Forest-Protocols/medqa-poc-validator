import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts"],
  target: "node20",
  format: ["esm"],
  clean: true,
  bundle: false,
  skipNodeModulesBundle: true,
  outDir: "dist",
  splitting: false,
  platform: "node",
});
