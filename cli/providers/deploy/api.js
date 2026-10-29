// A small client for the JSON APIs of Forge, Laravel Cloud and Vercel. The token goes only in the Authorization header,
// and only to the API's own origin: a next-page link elsewhere is refused

const TIMEOUT = 15_000;
// A list longer than this is a loop of next links, not a real account
const MAX_PAGES = 50;

/** A client for `base` (e.g. https://forge.laravel.com/api) with the user's API token; `name` goes in its errors. */
export function apiClient(base, token, name) {
  async function request(method, path, body) {
    const url = path.startsWith('https://') ? path : `${base}${path}`;
    if (!url.startsWith(`${base}/`)) throw new Error(`The ${name} API pointed to another site: ${new URL(url).host}`);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (error) {
      throw new Error(`Could not reach the ${name} API: ${error.message}`, { cause: error });
    }
    const where = `${method} ${new URL(url).pathname}`;
    if (response.status === 401) throw new Error(`The ${name} API token was refused`);
    if (response.status === 403)
      throw new Error(`The ${name} API token is not allowed to ${where}: check its permissions`);
    if (!response.ok) throw new Error(`The ${name} API answered HTTP ${response.status} to ${where}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /** Every item of a paginated list ({ data, included }), following its next links. */
  async function all(path) {
    const data = [];
    const included = [];
    let next = path;
    for (let page = 0; next; page++) {
      if (page === MAX_PAGES) throw new Error(`The ${name} API list ${path} has more than ${MAX_PAGES} pages`);
      const body = await request('GET', next);
      data.push(...(body?.data ?? []));
      included.push(...(body?.included ?? []));
      next = body?.links?.next || null;
    }
    return { data, included };
  }

  return {
    all,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
    delete: (path) => request('DELETE', path),
  };
}

/** owner/repo of a repository as Forge stores it (owner/repo, git@github.com:owner/repo.git or an https URL), lower case. */
export function repositoryOf(value) {
  return /(?:^|[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(value?.trim() ?? '')?.[1].toLowerCase() ?? null;
}
