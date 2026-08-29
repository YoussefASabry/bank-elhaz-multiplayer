import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4399);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    // Always rebuild first so the served client matches the working tree.
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
  },
  webServer: {
    command: `npm run build && PORT=${PORT} npm run server`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  outputDir: 'test-results',
});