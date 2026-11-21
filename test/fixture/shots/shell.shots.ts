import { defineFlow } from 'shotta';

export default defineFlow({
  shows: 'A list that scrolls inside a fixed shell, shot whole',
  // The shell is a desktop layout, so this is a desktop journey.
  profiles: ['desktop'],
  steps: [
    { goto: '/shell.html' },
    { scroll: '#row-20' },
    {
      label: 'note where the list is scrolled to',
      run: async (page): Promise<void> => {
        await page.evaluate(() => {
          document.body.dataset.scrolled = String(
            document.getElementById('list')?.scrollTop,
          );
        });
      },
    },
    { shot: 'whole', shows: 'All thirty rows, not only those on screen' },
    { shot: 'rows', of: '#rows', shows: 'The rows alone, all thirty' },
    {
      shot: 'row',
      of: '#row-25',
      pad: 10,
      shows: 'One row, with a little of its neighbours',
    },
    {
      label: 'the viewport and the scroll are as the shots found them',
      run: async (page): Promise<void> => {
        const state = await page.evaluate(() => ({
          height: window.innerHeight,
          scrolled: String(document.getElementById('list')?.scrollTop),
          was: document.body.dataset.scrolled,
        }));
        if (state.height !== 600 || state.scrolled !== state.was) {
          throw new Error(`left at ${JSON.stringify(state)}`);
        }
      },
    },
    { shot: 'screen', viewport: true },
  ],
});
