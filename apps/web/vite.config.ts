import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const usePolling =
  process.env.CHOKIDAR_USEPOLLING === "true" || process.env.DEV_WATCH_POLLING === "true";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    watch: usePolling
      ? {
          usePolling: true,
          interval: 300
        }
      : undefined
  }
});
