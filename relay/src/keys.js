/**
 * Key of a repository's webhook secret in the SECRETS namespace, shared with the setup command (cli/).
 * Lowercase because GitHub owner and repository names are case-insensitive: Datalogix/App and datalogix/app share one
 * secret.
 */
export function secretKey(providerId, repository) {
  return `${providerId}:${repository.toLowerCase()}`;
}

/**
 * Key of a delivered event in the SECRETS namespace, from the SHA-256 of its signed body, so an event that already
 * reached GitHub is not sent again.
 */
export function deliveryKey(providerId, repository, digest) {
  return `delivery:${providerId}:${repository.toLowerCase()}:${digest}`;
}
