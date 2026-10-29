import { defineConfig } from 'vitest/config';

// The relay is a separate package with its own tests
export default defineConfig({
  test: {
    include: ['cli/test/*.test.js', '.github/actions/test/*.test.js'],
    silent: 'passed-only',
  },
});
