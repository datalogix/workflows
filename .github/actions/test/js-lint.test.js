import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { callsTo, runScript } from './fakes.js';

// npx, pnpm, yarn and npm record their arguments (after ESLINT_USE_FLAT_CONFIG=false when it is set), and fail when
// they match FAIL
const PACKAGE_MANAGER = `#!/usr/bin/env bash
args=("$@")
if [ -n "\${ESLINT_USE_FLAT_CONFIG:-}" ]; then args=("ESLINT_USE_FLAT_CONFIG=$ESLINT_USE_FLAT_CONFIG" "\${args[@]}"); fi
node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$(basename "$0")" "\${args[@]}" >> "$FAKE_DIR/calls.jsonl"
if [ -n "\${FAIL:-}" ] && grep -qE -- "$FAIL" <<< "$*"; then exit 1; fi
`;

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@localhost', ...args], { cwd, stdio: 'pipe' });

/**
 * Runs js-lint.sh in a repository whose main (also origin/main) has `base` and whose HEAD adds `changed`: file contents
 * by path, with package.json given as an object.
 */
async function jsLint({ packageJson = {}, base = {}, changed = {}, env = {} } = {}) {
  return runScript('js-lint/js-lint.sh', {
    env: { GITHUB_EVENT_NAME: 'push', ...env },
    async setup(dir) {
      for (const name of ['npx', 'pnpm', 'yarn', 'npm']) {
        await writeFile(join(dir, name), PACKAGE_MANAGER);
        await chmod(join(dir, name), 0o755);
      }
      const project = join(dir, 'project');
      const write = async (files) => {
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(project, path)), { recursive: true });
          await writeFile(join(project, path), typeof content === 'string' ? content : JSON.stringify(content));
        }
      };
      await mkdir(project);
      git(project, 'init', '-q', '-b', 'main');
      await write({ 'package.json': packageJson, ...base });
      git(project, 'add', '-A');
      git(project, 'commit', '-q', '-m', 'base');
      git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      if (Object.keys(changed).length) {
        await write(changed);
        git(project, 'add', '-A');
        git(project, 'commit', '-q', '-m', 'change');
      }
      return project;
    },
  });
}

const tools = (...names) => ({ devDependencies: Object.fromEntries(names.map((name) => [name, '*'])) });
const PULL_REQUEST = { GITHUB_EVENT_NAME: 'pull_request', BASE_REF: 'main' };

describe('js lint', () => {
  test('skips a project without package.json', async () => {
    const result = await runScript('js-lint/js-lint.sh');

    expect(result.code).toBe(0);
    expect(result.outputs).toEqual({ tools: '' });
  });

  test('finds nothing when no tool is declared', async () => {
    const result = await jsLint({ base: { 'eslint.config.js': '', '.prettierrc': '{}' } });

    expect(result.code).toBe(0);
    expect(result.outputs.tools).toBe('');
    expect(result.calls).toEqual([]);
  });

  test('runs each declared and configured tool on every tracked file outside pull requests', async () => {
    const result = await jsLint({
      packageJson: tools('eslint', 'prettier', 'stylelint'),
      base: {
        'eslint.config.js': '',
        '.prettierrc': '{}',
        'stylelint.config.mjs': '',
        'resources/js/app.ts': '',
        'resources/css/app.css': '',
        'README.md': '',
      },
    });

    expect(result.code).toBe(0);
    expect(result.outputs.tools).toBe('eslint prettier stylelint');
    expect(callsTo(result, 'npx')).toEqual([
      '--no-install eslint --no-warn-ignored eslint.config.js resources/js/app.ts stylelint.config.mjs',
      '--no-install prettier --check --ignore-unknown .prettierrc README.md eslint.config.js package.json resources/css/app.css resources/js/app.ts stylelint.config.mjs',
      '--no-install stylelint --allow-empty-input resources/css/app.css',
    ]);
  });

  test('checks only the files a pull request changes', async () => {
    const result = await jsLint({
      packageJson: tools('eslint', 'prettier'),
      base: { 'eslint.config.js': '', '.prettierrc': '{}', 'old.js': '' },
      changed: { 'new.js': '' },
      env: PULL_REQUEST,
    });

    expect(result.code).toBe(0);
    expect(callsTo(result, 'npx')).toEqual([
      '--no-install eslint --no-warn-ignored new.js',
      '--no-install prettier --check --ignore-unknown new.js',
    ]);
    expect(result.stdout).toContain('ESLint on the files changed since origin/main');
  });

  test('checks the files of a merge queue group since its base', async () => {
    const result = await jsLint({
      packageJson: tools('prettier'),
      base: { '.prettierrc': '{}', 'old.js': '' },
      changed: { 'new.js': '' },
      env: { GITHUB_EVENT_NAME: 'merge_group', MERGE_GROUP_BASE: 'origin/main' },
    });

    expect(callsTo(result, 'npx')).toEqual(['--no-install prettier --check --ignore-unknown new.js']);
  });

  test('skips a tool without changed files for it', async () => {
    const result = await jsLint({
      packageJson: tools('eslint', 'stylelint'),
      base: { 'eslint.config.js': '', '.stylelintrc.json': '{}' },
      changed: { 'app/Models/User.php': '' },
      env: PULL_REQUEST,
    });

    expect(result.code).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stdout).toContain('No files for ESLint in the files changed since origin/main, skipping');
  });

  test('warns and checks every tracked file when the base cannot be compared', async () => {
    const result = await jsLint({
      packageJson: tools('prettier'),
      base: { '.prettierrc': '{}' },
      env: { GITHUB_EVENT_NAME: 'pull_request', BASE_REF: 'missing' },
    });

    expect(result.stdout).toContain('::warning::Could not list the files changed since origin/missing');
    expect(callsTo(result, 'npx')).toEqual(['--no-install prettier --check --ignore-unknown .prettierrc package.json']);
  });

  test('leaves out lockfiles, minified files, vendored code and the build', async () => {
    const result = await jsLint({
      packageJson: tools('prettier'),
      base: {
        '.prettierrc': '{}',
        'composer.lock': '',
        'package-lock.json': '',
        'public/vendor/telescope/app.js': '',
        'public/build/app.js': '',
        'resources/js/lib.min.js': '',
        'resources/js/app.js': '',
      },
    });

    expect(callsTo(result, 'npx')).toEqual([
      '--no-install prettier --check --ignore-unknown .prettierrc package.json resources/js/app.js',
    ]);
  });

  test('fails after running every tool when one fails', async () => {
    const result = await jsLint({
      packageJson: tools('eslint', 'prettier'),
      base: { 'eslint.config.js': '', '.prettierrc': '{}' },
      env: { FAIL: '^--no-install eslint' },
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('::error::ESLint failed');
    expect(callsTo(result, 'npx')).toHaveLength(2);
  });

  test('finds the tools without running them when run is false', async () => {
    const result = await jsLint({
      packageJson: tools('eslint'),
      base: { 'eslint.config.js': '' },
      env: { RUN: 'false' },
    });

    expect(result.outputs.tools).toBe('eslint');
    expect(result.calls).toEqual([]);
  });

  test('skips the tools an input turns off, their scripts included', async () => {
    const result = await jsLint({
      packageJson: { ...tools('eslint', 'prettier', 'stylelint'), scripts: { 'format:check': 'prettier --check .' } },
      base: { 'eslint.config.js': '', '.stylelintrc.json': '{}', 'app.css': '' },
      env: { RUN_ESLINT: 'false', RUN_PRETTIER: 'false' },
    });

    expect(result.outputs.tools).toBe('stylelint');
    expect(result.stdout).toContain('ESLint is turned off (eslint: false)');
    expect(result.stdout).toContain('Prettier is turned off (prettier: false)');
    expect(callsTo(result, 'npm')).toEqual([]);
    expect(callsTo(result, 'npx')).toEqual(['--no-install stylelint --allow-empty-input app.css']);
  });

  describe('ESLint', () => {
    test('is left to the lint script when package.json has one', async () => {
      const result = await jsLint({
        packageJson: { ...tools('eslint'), scripts: { lint: 'oxlint' } },
        base: { 'eslint.config.js': '' },
      });

      expect(result.outputs.tools).toBe('');
    });

    test('is skipped without a config', async () => {
      const result = await jsLint({ packageJson: tools('eslint') });

      expect(result.outputs.tools).toBe('');
    });

    test('lints the whole project with a legacy config', async () => {
      const result = await jsLint({
        packageJson: tools('eslint'),
        base: { '.eslintrc.json': '{}', 'old.js': '' },
        changed: { 'new.js': '' },
        env: PULL_REQUEST,
      });

      expect(callsTo(result, 'npx')).toEqual(['ESLINT_USE_FLAT_CONFIG=false --no-install eslint .']);
    });

    test.each([
      ['pnpm-lock.yaml', 'pnpm', 'exec eslint --no-warn-ignored app.js'],
      ['yarn.lock', 'yarn', 'eslint --no-warn-ignored app.js'],
    ])('runs with the package manager of %s', async (lockfile, command, call) => {
      const result = await jsLint({
        packageJson: tools('eslint'),
        base: { 'eslint.config.js': '', [lockfile]: '' },
        changed: { 'app.js': '' },
        env: PULL_REQUEST,
      });

      expect(callsTo(result, command)).toEqual([call]);
    });
  });

  describe('Prettier', () => {
    test('runs the format:check script instead, on its own files', async () => {
      const result = await jsLint({
        packageJson: { ...tools('prettier'), scripts: { 'format:check': 'prettier --check resources/' } },
        base: { '.prettierrc': '{}' },
      });

      expect(result.outputs.tools).toBe('prettier');
      expect(callsTo(result, 'npm')).toEqual(['run format:check']);
      expect(callsTo(result, 'npx')).toEqual([]);
    });

    test('is left to the lint script when it runs Prettier', async () => {
      const result = await jsLint({
        packageJson: { ...tools('prettier'), scripts: { lint: 'eslint . && prettier --check .' } },
        base: { '.prettierrc': '{}' },
      });

      expect(result.outputs.tools).toBe('');
    });

    test('is left to the lint script when it runs the format:check script', async () => {
      const result = await jsLint({
        packageJson: { scripts: { lint: 'eslint . && npm run format:check', 'format:check': 'prettier --check .' } },
      });

      expect(result.outputs.tools).toBe('');
    });

    test('reads its config from package.json', async () => {
      const result = await jsLint({ packageJson: { ...tools('prettier'), prettier: { semi: false } } });

      expect(result.outputs.tools).toBe('prettier');
    });

    test('is skipped without a config', async () => {
      const result = await jsLint({ packageJson: tools('prettier') });

      expect(result.outputs.tools).toBe('');
      expect(result.stdout).toContain('package.json declares prettier, but no config was found');
    });
  });

  describe('Stylelint', () => {
    test('runs the lint:css script instead', async () => {
      const result = await jsLint({
        packageJson: { ...tools('stylelint'), scripts: { 'lint:css': 'stylelint "**/*.css"' } },
        base: { 'pnpm-lock.yaml': '' },
      });

      expect(callsTo(result, 'pnpm')).toEqual(['run lint:css']);
    });

    test('is left to the lint script when it runs Stylelint', async () => {
      const result = await jsLint({
        packageJson: { ...tools('stylelint'), scripts: { lint: 'eslint . && stylelint "**/*.css"' } },
        base: { '.stylelintrc.json': '{}' },
      });

      expect(result.outputs.tools).toBe('');
    });

    test('checks components only with a syntax for them', async () => {
      const files = { '.stylelintrc.json': '{}', 'App.vue': '', 'app.scss': '' };
      const plain = await jsLint({ packageJson: tools('stylelint'), base: files });
      const vue = await jsLint({ packageJson: tools('stylelint', 'stylelint-config-recommended-vue'), base: files });

      expect(callsTo(plain, 'npx')).toEqual(['--no-install stylelint --allow-empty-input app.scss']);
      expect(callsTo(vue, 'npx')).toEqual(['--no-install stylelint --allow-empty-input App.vue app.scss']);
    });
  });
});
