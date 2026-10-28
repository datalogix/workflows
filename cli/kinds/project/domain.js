// The domains and health check paths of a project's environments (HEALTH_URL)

export function isDomain(value) {
  return /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value.trim());
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
