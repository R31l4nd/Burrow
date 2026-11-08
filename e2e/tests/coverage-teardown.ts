import { cpSync, existsSync } from 'node:fs';
import { CoverageReport } from 'monocart-coverage-reports';
import { COVERAGE_CACHE, COVERAGE_KEPT, COVERAGE_OPTIONS } from './coverage-options.js';

/** After the run: what all the tests went through, as one report. */
export default async function teardown(): Promise<void> {
  // Kept for a resume: the report removes the cache it was made from.
  if (existsSync(COVERAGE_CACHE)) cpSync(COVERAGE_CACHE, COVERAGE_KEPT, { recursive: true });
  await new CoverageReport(COVERAGE_OPTIONS).generate();
}
