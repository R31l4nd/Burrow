import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CoverageReport } from 'monocart-coverage-reports';
import { COVERAGE_CACHE, COVERAGE_KEPT, COVERAGE_OPTIONS } from './coverage-options.js';

/** Before the run: nothing left from an earlier one (coverage, controls pressed). */
export default function setup(): void {
  // A resumed gate adds to what the run before saw (scripts/e2e.sh).
  if (process.env.E2E_RESUME) {
    if (existsSync(COVERAGE_KEPT)) cpSync(COVERAGE_KEPT, COVERAGE_CACHE, { recursive: true });
    return;
  }
  new CoverageReport(COVERAGE_OPTIONS).cleanCache();
  for (const dir of ['pressed', 'controls-seen', 'coverage-kept']) rmSync(join(COVERAGE_OPTIONS.outputDir!, '..', dir), { recursive: true, force: true });
}
