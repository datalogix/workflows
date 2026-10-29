import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lf } from '../../lib/workflow-file.js';

export const PROVIDER_PATH = 'app/Providers/AppServiceProvider.php';

const IMPORTS = [
  'use Illuminate\\Foundation\\Events\\DiagnosingHealth;',
  'use Illuminate\\Support\\Facades\\DB;',
  'use Illuminate\\Support\\Facades\\Event;',
];

const LISTENER = [
  '        // /up fails when the database is unreachable, so deploys are rolled back',
  '        Event::listen(DiagnosingHealth::class, function () {',
  '            DB::connection()->getPdo();',
  '        });',
];

async function readOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function phpFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.php'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** What the project's health check does, read from its files. */
export async function inspectHealth(root) {
  const bootstrap = await readOrNull(join(root, 'bootstrap', 'app.php'));
  // The provider is where setup adds the check: read it first, and the rest of app/ only when it is not there
  const provider = await readOrNull(join(root, PROVIDER_PATH));
  let diagnosing = provider?.includes('DiagnosingHealth') ?? false;
  for (const file of diagnosing ? [] : await phpFiles(join(root, 'app'))) {
    if ((await readOrNull(file))?.includes('DiagnosingHealth')) {
      diagnosing = true;
      break;
    }
  }
  return {
    laravel: bootstrap !== null,
    route: bootstrap ? (/health:\s*['"]([^'"]+)['"]/.exec(bootstrap)?.[1] ?? null) : null,
    databaseCheck: diagnosing,
  };
}

/**
 * Adds the database check to AppServiceProvider::boot(). Returns the new content, or null when the file
 * does not have the shape of Laravel's default provider (then the change is left to the developer). A file with CRLF
 * line ends (checked out on Windows) keeps them.
 */
export function addDatabaseCheck(original) {
  if (original.includes('DiagnosingHealth')) return original;
  const updated = withDatabaseCheck(lf(original));
  return updated && original.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated;
}

function withDatabaseCheck(content) {
  const boot = /(public function boot\(\)(?:\s*:\s*void)?\s*\{\n)/.exec(content);
  const namespace = /^namespace [^;]+;\n/m.exec(content);
  if (!boot || !namespace) return null;

  const bodyStart = boot.index + boot[0].length;
  const rest = content.slice(bodyStart);
  const listener = LISTENER.join('\n') + '\n';
  let updated;
  if (/^[ \t]*\/\/[ \t]*\n(?=[ \t]*\})/.test(rest)) {
    // boot() only has Laravel's placeholder comment: replace it
    updated = content.slice(0, bodyStart) + listener + rest.replace(/^[ \t]*\/\/[ \t]*\n/, '');
  } else if (/^[ \t]*\}/.test(rest)) {
    updated = content.slice(0, bodyStart) + listener + rest;
  } else {
    updated = content.slice(0, bodyStart) + listener + '\n' + rest;
  }

  const missing = IMPORTS.filter((line) => !updated.includes(line));
  if (missing.length) {
    const uses = [...updated.matchAll(/^use [^;]+;\n/gm)];
    const at = uses.length ? uses.at(-1).index + uses.at(-1)[0].length : namespace.index + namespace[0].length;
    const block = uses.length ? missing.join('\n') + '\n' : '\n' + missing.join('\n') + '\n';
    updated = updated.slice(0, at) + block + updated.slice(at);
    // Keep the imports sorted, as Pint would
    updated = updated.replace(/(^use [^;]+;\n)+/m, (all) => all.split('\n').filter(Boolean).sort().join('\n') + '\n');
  }

  return updated;
}
