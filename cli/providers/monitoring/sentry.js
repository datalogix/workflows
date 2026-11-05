import { bold } from '../../lib/ui.js';

/**
 * Sentry, as a monitoring service of a stack (relay provider sentry): its issue alerts open the GitHub issues, so an
 * alert rule picks which problems (and environments) do.
 */
export default {
  id: 'sentry',
  name: 'Sentry',
  hint: 'exceptions, through an alert rule',
  types: ['exception'],
  secret: null,
  webhookHint: [
    `In Sentry, create an internal integration (${bold('Settings > Developer Settings > Custom Integrations')}), turn on ${bold('Alert Rule Action')} and set its webhook URL to:`,
  ].join('\n'),
  secretHint: `Then copy its ${bold('Client Secret')}, and add the integration as an action of the alert rules whose problems should become issues.`,
  markers: () => false,
};
