import { defineFlow } from 'shots';

export default defineFlow({
  shows: 'The home page, its details panel, and the way through to About',
  steps: [
    { goto: '/' },
    // Both come from the config: the flag is set before the app boots, and the
    // dev overlay is hidden in every shot.
    { wait: 'html[data-mock=on]' },
    {
      label: 'the dev overlay is hidden',
      run: async (page): Promise<void> => {
        if (await page.locator('#dev-overlay').isVisible()) {
          throw new Error('#dev-overlay is visible');
        }
      },
    },
    { wait: '#items li >> nth=2' },
    { theme: 'dark' },
    { wait: 'html[data-theme=dark]' },
    { shot: 'home', shows: 'The list has loaded: Alpha, Beta, Gamma' },
    {
      annotate: 'Fill in the form',
      steps: [
        { type: 'Ada', into: '#name' },
        { hover: '#toggle' },
        { click: '#toggle' },
        { shot: 'details' },
      ],
    },
    {
      annotate: 'Read the small print',
      steps: [
        { scroll: '#footer' },
        { click: '#about' },
        { wait: 'text=A second page.' },
        { shot: 'about' },
      ],
    },
  ],
});
