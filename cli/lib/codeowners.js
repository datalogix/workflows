export const CODEOWNERS_PATH = '.github/CODEOWNERS';

// The only line the setup command manages; any other line of an existing file is kept as it is
const PATTERN = '/.github/';

const COMMENT =
  '# Changes to the workflows need their approval, so a pull request cannot lower its own checks (datalogix/workflows)';

// A file the line must cover: the workflow file, whose changes could lower the checks
const WORKFLOW = '.github/workflows/datalogix.yml';

/** The pattern and owners of a CODEOWNERS line, without a trailing comment, or null for a blank or comment line. */
function entry(line) {
  const [pattern, ...owners] = line
    .replace(/(^|\s)#.*$/, '')
    .trim()
    .split(/\s+/);
  return pattern ? { pattern, owners } : null;
}

/**
 * Whether a CODEOWNERS pattern covers the path, as gitignore patterns do: `*` within a folder, `**` across folders, a
 * pattern with a slash anchored at the root, a trailing slash for a folder and what is inside it.
 */
function covers(pattern, path = WORKFLOW) {
  const anchored = pattern.replace(/\/$/, '').includes('/');
  const source = pattern
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) =>
      token === '**' ? '.*' : token === '*' ? '[^/]*' : token === '?' ? '[^/]' : `\\${token}`,
    );
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}(?:/.*)?$`).test(path);
}

/**
 * Owners of the .github folder (["@user", "@org/team"]), or null when the file has no `/.github/` line. GitHub applies
 * the last matching line, so that is the one read: the `/.github/` line, or a broader one after it (`*`).
 */
export function parseOwners(content) {
  const entries = content.split(/\r?\n/).map(entry);
  const ours = entries.findLastIndex((candidate) => candidate?.pattern === PATTERN);
  if (ours === -1) return null;
  const last = entries.findLast((candidate, index) => index >= ours && candidate && covers(candidate.pattern));
  return last?.owners.length ? last.owners : null;
}

/** Whether the value is a space-separated list of @users, @org/teams or emails. */
export function isOwnerList(value) {
  const owners = value.trim().split(/\s+/);
  return (
    owners[0] !== '' &&
    owners.every((owner) => /^@[\w-]+(\/[\w.-]+)?$/.test(owner) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner))
  );
}

/**
 * The CODEOWNERS file with the given owners for .github, keeping the other lines of the existing file and its line
 * ends. The `/.github/` line is replaced in place when it is the last line covering .github; otherwise it goes last,
 * so a broader pattern above it cannot take .github away from these owners.
 */
export function renderCodeOwners(owners, existing = '') {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const line = `${PATTERN} ${owners.trim().split(/\s+/).join(' ')}`;
  const lines = existing.replace(/(\r?\n)+$/, '').split(/\r?\n/);
  const ours = (candidate) => entry(candidate)?.pattern === PATTERN;
  const last = lines.findLastIndex((candidate) => entry(candidate) && covers(entry(candidate).pattern));
  if (last !== -1 && ours(lines[last])) {
    lines[last] = line;
    return `${lines.join(eol)}${eol}`;
  }
  // A broader line after ours (or none): ours moves to the end, with its comment
  const kept = lines.filter(
    (candidate, index) => !ours(candidate) && !(candidate === COMMENT && ours(lines[index + 1] ?? '')),
  );
  const head = existing.trim() && kept.some((candidate) => candidate.trim()) ? `${kept.join(eol)}${eol}${eol}` : '';
  return `${head}${COMMENT}${eol}${line}${eol}`;
}
