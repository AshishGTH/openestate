import { defineConfig } from 'vitest/config';

/**
 * Test files that take table-level locks on shared tables when they succeed
 * (see test/exclusive-lock-controls.serial.test.ts). One file at a time, and
 * turbo's `test:serial` task starts only after `test` and `^test` (the api and
 * packages/db suites) have finished, so nothing else is using the database.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.serial.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
