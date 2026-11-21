import { defineConfig } from 'shotta';

// A step of the project's own: its name and the value it takes are declared
// here, so flows that use it type-check.
declare module 'shotta' {
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
    phone: { device: 'iPhone 15', colorScheme: 'dark' },
  },
  localStorage: { mock: 'on' },
  hide: ['#dev-overlay'],
  ignoreRequests: ['/api/ping'],
  // Every pass starts signed out; the site says who it thinks is there.
  setup: async (page, { baseUrl }) => {
    await page
      .context()
      .addCookies([{ name: 'user', value: 'ada', url: baseUrl }]);
  },
  steps: {
    theme: async (page, value) => {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, value);
    },
  },
  exports: {
    docs: {
      dir: '.shotta-exported/docs',
      scale: 2,
      shots: ['journey/home@desktop', 'still/heading'],
    },
    hero: {
      dir: '.shotta-exported',
      // A file is what its name says it is.
      shots: {
        'hero.png': 'still/fold@phone',
        'hero.jpg': 'still/fold@desktop',
      },
    },
    web: {
      dir: '.shotta-exported/web',
      format: 'webp',
      quality: 80,
      shots: ['still/fold@desktop'],
    },
  },
  failWhen: [
    {
      selector: 'text=Something went wrong',
      message: 'the app error page rendered',
    },
  ],
});
