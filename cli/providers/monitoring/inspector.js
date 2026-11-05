import { bold } from '../../lib/ui.js';

/**
 * Inspector, as a monitoring service of a stack (relay provider inspector): its error notifications open the GitHub
 * issues. They carry no signature nor environment, only the application's key, and each environment is its own
 * application, so setup asks for one key per environment and the relay stores them together.
 */
export default {
  id: 'inspector',
  name: 'Inspector',
  hint: 'exceptions, one application per environment',
  types: ['exception'],
  secret: null,
  keyPerEnvironment: true,
  webhookHint: `In Inspector, open the application of each environment, configure the ${bold('Webhook')} channel in ${bold('Settings > Notifications Channels')} and set its URL to:`,
  secretHint: `Then copy each application's ${bold('ingestion key')} (its INSPECTOR_INGESTION_KEY), which Inspector sends with every notification.`,
  markers: () => false,
};
