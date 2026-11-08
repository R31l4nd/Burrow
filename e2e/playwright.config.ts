import { defineConfig, devices } from '@playwright/test';

// Runs against a throwaway Burrow container started by scripts/e2e.sh.
// The setup project claims the fresh instance once; the others sign in with
// the passkey it registered.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  // Up to four browsers at once, against the one instance: the specs that
  // build up its state run one after another (workers: 1 on their project),
  // the ones that only look run side by side after them.
  workers: 4,
  forbidOnly: !!process.env.CI,
  // The gate retries a failed test once (E2E_RETRIES=1) and names it flaky; by hand a failure stays a failure.
  retries: Number(process.env.E2E_RETRIES ?? 0),
  // The web app's code coverage and the controls pressed, over the whole run (tests/fixtures.ts).
  globalSetup: './tests/coverage-setup.ts',
  globalTeardown: './tests/coverage-teardown.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  // Playwright empties its output folder at every start: the failures'
  // screenshots and traces go in their own, so the coverage, the presses
  // and the pages seen (test-results/coverage, pressed, ...) outlive a
  // resumed run of a few specs (scripts/gate.sh RESUME=1).
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8190',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    // Still pictures and steady clicks: the UI's motion off, as the system
    // setting turns it off (workspace-motion.spec.ts looks at the motion).
    reducedMotion: 'reduce',
  },
  projects: [
    // Never retried: it claims the instance, and a second try would meet one claimed already, failing
    // for that instead of its own reason (AUDIT2 TEST-03).
    { name: 'setup', testMatch: /setup\.spec\.ts/, workers: 1, retries: 0, use: { ...devices['Desktop Chrome'] } },
    // In file order, one at a time: later specs use what earlier ones made.
    { name: 'desktop', testMatch: /(hosts|terminal[a-z-]*|workspace[a-z-]*)\.spec\.ts/, testIgnore: /workspace-(tour|sizes)\.spec\.ts/, dependencies: ['setup'], workers: 1, use: { ...devices['Desktop Chrome'] } },
    // What only looks (the tour's six passes, every page at every size): side by side, after the state is built.
    // Three at a time: five (2.12.0) made each tour pass about twice as slow on the gate's 8 cores and e2e 9 minutes longer.
    { name: 'look', testMatch: /workspace-(tour|sizes)\.spec\.ts/, dependencies: ['desktop'], fullyParallel: true, workers: 3, use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', testMatch: /mobile[a-z-]*\.spec\.ts/, dependencies: ['desktop'], workers: 1, use: { ...devices['Pixel 7'] } },
    // The same app in the other engines, on a computer and as a phone (browsers.spec.ts).
    { name: 'firefox', testMatch: /browsers\.spec\.ts/, dependencies: ['desktop'], workers: 1, use: { ...devices['Desktop Firefox'] } },
    { name: 'firefox-phone', testMatch: /browsers\.spec\.ts/, dependencies: ['firefox'], workers: 1, use: { browserName: 'firefox', viewport: { width: 412, height: 839 }, hasTouch: true } },
    { name: 'webkit-phone', testMatch: /browsers\.spec\.ts/, dependencies: ['firefox-phone'], workers: 1, use: { ...devices['iPhone 15'] } },
    // After all the others: every page and dialog seen; what no other test pressed, each on purpose; then every control left (it may change things).
    { name: 'press-each', testMatch: /(seen|press-each)\.spec\.ts/, dependencies: ['look', 'mobile', 'webkit-phone'], workers: 1, use: { ...devices['Desktop Chrome'] } },
    { name: 'press', testMatch: /press-all\.spec\.ts/, dependencies: ['press-each'], workers: 1, use: { ...devices['Desktop Chrome'] } },
    { name: 'press-phone', testMatch: /press-all\.spec\.ts/, dependencies: ['press'], workers: 1, use: { ...devices['Pixel 7'] } },
    // make replay ID=...: a problem report's input played again (skipped without one). Last: beside the others it trusted the test host's key too early, and its host showed up in what they looked at.
    { name: 'replay', testMatch: /replay\.spec\.ts/, dependencies: ['press-phone'], workers: 1, use: { ...devices['Pixel 7'] } },
  ],
});
