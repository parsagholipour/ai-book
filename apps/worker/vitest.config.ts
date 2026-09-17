import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["./src/testing/objectStorage.ts"] }
});
