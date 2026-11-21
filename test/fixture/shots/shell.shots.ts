import { defineFlow } from 'shotta';

export default defineFlow({
  shows: 'A list that scrolls inside a fixed shell, shot whole',
  // The shell is a desktop layout, so this is a desktop journey.
  profiles: ['desktop'],
  steps: [
    { goto: '/shell.html' },
    { scroll: '#row-20' },
    { shot: 'whole', shows: 'All thirty rows, not only those on screen' },
    {
      label: 'the viewport and the scroll are as the shot found them',
      run: async (page): Promise<void> => {
        const state = await page.evaluate(() => ({
          height: window.innerHeight,
          scrolled: document.getElementById('list')?.scrollTop ?? 0,
        }));
        if (state.height !== 600 || state.scrolled === 0) {
          throw new Error(`left at ${JSON.stringify(state)}`);
        }
      },
    },
    { shot: 'screen', viewport: true },
  ],
});
