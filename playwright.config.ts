import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    timeout: 90_000,
    expect: { timeout: 30_000 },
    workers: 1,
    reporter: "list",
    use: {
        baseURL: "http://127.0.0.1:4138/bridge/",
        headless: true,
        trace: "retain-on-failure",
    },
    webServer: {
        command: "pnpm build && node scripts/serve-static.mjs",
        url: "http://127.0.0.1:4138/bridge/",
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
