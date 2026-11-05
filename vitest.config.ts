import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'vendor/operating-model-simulator/tests/**/*.test.ts'],
  },
});
