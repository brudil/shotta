import { defineConfig } from 'shots';

// A step of the project's own: its name and the value it takes are declared
// here, so flows that use it type-check.
declare module 'shots' {
  interface CustomSteps {
    theme: 'light' | 'dark';
  }
}

export default defineConfig({
  flows: 'shots',
  pace: 0,
  actionTimeout: 1500,
  server: { command: 'node server.mjs' },
  profiles: {
    desktop: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 },
    phone: { device: 'iPhone 15' },
  },
  localStorage: { mock: 'on' },
  hide: ['#dev-overlay'],
  ignoreRequests: ['/api/ping'],
  steps: {
    theme: async (page, value) => {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, value);
    },
  },
  failWhen: [
    {
      selector: 'text=Something went wrong',
      message: 'the app error page rendered',
    },
  ],
});
