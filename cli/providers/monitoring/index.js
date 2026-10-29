import nightwatch from './nightwatch.js';
import sentry from './sentry.js';

/**
 * The monitoring services setup knows, each a file here whose default export is:
 *
 *   id            the monitoring input, the relay provider (relay/src/providers/<id>.js) and its webhook URL segment
 *   name, hint    how setup names it, and what it offers, in the monitoring question
 *   types         the incident types it reports (exception, performance)
 *   webhookHint   where to set the relay's webhook URL; secretHint what to copy then, the relay's signing secret
 *   secret        the environment secret of its deploy markers (null without markers), with tokenHint
 *   markers(answers)   whether it marks the deploys of that target (.github/actions/deploy/monitoring/<id>.sh)
 *
 * A stack offers the ones its apps use (monitoringServices), the first by default.
 */
export const MONITORING_SERVICES = Object.fromEntries([nightwatch, sentry].map((service) => [service.id, service]));

/** The monitoring services of a stack, by id, in the order given. */
export const monitoringServices = (ids) => ids.map((id) => MONITORING_SERVICES[id]);
