import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoverageReportOptions } from 'monocart-coverage-reports';

// The web app's code the e2e run went through, per source file (the bundle
// carries its source maps): added up by the tests (fixtures.ts), written at
// the end of the run (coverage-teardown.ts), held to a floor by the gate
// (scripts/web-coverage.mjs).

export const COVERAGE_OPTIONS: CoverageReportOptions = {
  name: 'Burrow web app, e2e',
  outputDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'coverage'),
  // Burrow's own code only: not the libraries in the bundle.
  // (Paths as the source maps give them: src/... for the app, shared/src/... for the shared code.)
  sourceFilter: (path: string) => /(^|\/)src\//.test(path) && !path.includes('node_modules'),
  // lcov.info: which lines of a file no test went through, for finding what to test next.
  reports: [['json-summary', { file: 'summary.json' }], ['lcovonly', { file: 'lcov.info' }], ['console-summary']],
};

/**
 * What the tests added, kept past the report: monocart removes its cache
 * when it writes one, and a resumed gate adds to the run before (an e2e
 * resume of 10 specs counted only theirs, 2.3.1 gate).
 */
export const COVERAGE_KEPT = join(COVERAGE_OPTIONS.outputDir!, '..', 'coverage-kept');
export const COVERAGE_CACHE = join(COVERAGE_OPTIONS.outputDir!, '.cache');
