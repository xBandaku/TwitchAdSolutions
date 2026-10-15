const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: __dirname,
    testMatch: 'browser.spec.js',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: process.env.CI ? 2 : undefined,
    timeout: 30000,
    globalTimeout: 5 * 60 * 1000,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        serviceWorkers: 'block'
    },
    projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({ name: browserName, use: { browserName } }))
});
