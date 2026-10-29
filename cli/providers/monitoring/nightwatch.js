import { bold } from '../../lib/ui.js';

/** Laravel Nightwatch, as the monitoring service of a stack (relay provider nightwatch). */
export default {
  id: 'nightwatch',
  name: 'Nightwatch',
  secret: 'NIGHTWATCH_TOKEN',
  tokenHint: "the app's NIGHTWATCH_TOKEN",
  webhookHint: `In Nightwatch, open the application's ${bold('Issues settings > Webhooks')} and set the URL to:`,
  // Deploy markers need the Nightwatch token of a Forge site
  markers: (answers) => answers.deploy === 'forge',
};
