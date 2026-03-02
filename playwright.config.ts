import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3199',
    headless: true,
  },
  webServer: {
    command: 'npx tsx e2e/test-server.ts',
    port: 3199,
    timeout: 10000,
    reuseExistingServer: true,
  },
})
