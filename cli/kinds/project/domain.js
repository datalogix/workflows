// The domains and health check paths of a project's environments (HEALTH_URL)

export function isDomain(value) {
  return /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value.trim());
}

/**
 * The domain to suggest when the health check URL gives none: the repository's name, with .com.br for an app in
 * Brazilian Portuguese (locale pt_BR) and .com otherwise. Empty without a repository.
 */
export function suggestedDomain(repository, locale) {
  const name = (repository?.split('/')[1] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) return '';
  return `${name}.${/^pt[_-]br$/i.test(locale ?? '') ? 'com.br' : 'com'}`;
}

/** Domain of a URL such as https://example.com/up, or null. */
export function domainOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Path of a URL such as https://example.com/up, or null. */
export function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
