import { bold } from '../../lib/ui.js';

/** Laravel Nightwatch, as a monitoring service of a stack (relay provider nightwatch). */
export default {
  id: 'nightwatch',
  name: 'Nightwatch',
  hint: 'exceptions and performance, deploy markers on Forge',
  types: ['exception', 'performance'],
  secret: 'NIGHTWATCH_TOKEN',
  tokenHint: "the app's NIGHTWATCH_TOKEN",
  webhookHint: `In Nightwatch, open the application's ${bold('Issues settings > Webhooks')} and set the URL to:`,
  secretHint: 'Then copy the signing secret it shows.',
  // Deploy markers need the Nightwatch token of a Forge site
  markers: (answers) => answers.deploy === 'forge',
};
