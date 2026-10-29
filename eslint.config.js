import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['.lint/', '**/.wrangler/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  // The relay runs as a Cloudflare Worker, not on Node
  {
    files: ['relay/src/**/*.js'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  prettier,
];
