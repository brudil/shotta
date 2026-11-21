import { defineConfig } from 'shotta';

/** A project with mistakes in it, for `shotta check` to find all of. */
export default defineConfig({
  flows: 'broken',
  baseUrl: 'http://localhost:1',
  profiles: {
    desktop: { viewport: { width: 800, height: 600 } },
  },
  exports: {
    docs: { dir: '.shotta-exported/broken', shots: ['fine/home', 'fine/away'] },
  },
});
