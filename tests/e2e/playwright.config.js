import { defineConfig } from "@playwright/test";

// We let run.sh manage the PHP server (seeds the DB first), so there's no
// webServer block here -- Playwright just hits the running 127.0.0.1:8765.
export default defineConfig({
  testDir: "./specs",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL || "http://127.0.0.1:8765",
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: process.env.CI ? [["list"], ["junit", { outputFile: "junit.xml" }]] : [["list"]],
});
