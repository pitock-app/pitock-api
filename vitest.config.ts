import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { NODE_ENV: "test" },
    // PGlite (Postgres in WASM) può essere lento ad avviarsi su macchine o runner CI carichi.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
