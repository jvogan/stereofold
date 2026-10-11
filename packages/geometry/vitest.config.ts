import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    silent: false,
    // Two acceptance tests instantiate Mol* 5.11.0's real Camera/StereoCamera
    // and rasterise projected markers. They take 6-10 s on this hardware, well
    // past vitest's 5 s default, so the whole file gets a generous budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
