// The fixture's config with its setup shared, noting each time it runs. Plain
// JS, as a project's may be, so it can import the TypeScript config by its
// file name.
import { appendFileSync } from 'node:fs';

import base from './shotta.config.ts';

export default {
  ...base,
  shareSetup: true,
  setup: async (page, pass) => {
    appendFileSync(process.env.SETUP_LOG ?? 'setup.log', `${pass.profile}\n`);
    await base.setup(page, pass);
  },
};
