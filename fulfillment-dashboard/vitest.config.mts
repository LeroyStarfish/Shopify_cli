import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    clearMocks: true,
    mockReset: true,
    coverage: {
      provider: "v8",
      include: ["app/**/*.{ts,tsx}"],
      exclude: [
        "app/root.tsx",        // HTML shell — no logic
        "app/routes/app.tsx",  // Layout wrapper — no logic
      ],
      reporter: ["text", "json", "html"],
    },
  },
});
