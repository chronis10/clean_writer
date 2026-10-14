import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/ui",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:1420",
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
  reporter: "list",
});
