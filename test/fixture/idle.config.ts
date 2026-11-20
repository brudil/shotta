import { defineConfig } from 'shots';

/** The app is left up for barely a moment, to watch it idle out. */
export default defineConfig({
  flows: 'shots',
  outDir: '.shots-idle',
  actionTimeout: 1500,
  server: { command: 'node server.mjs', keepAlive: 1500 },
  profiles: {
    desktop: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 },
  },
  failWhen: [{ selector: 'text=Something went wrong' }],
});
