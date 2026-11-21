import { defineFlow } from 'shotta';

export default defineFlow({
  steps: [
    { goto: '/' },
    { shot: 'before' },
    {
      annotate: 'Press a button that is not there',
      steps: [{ click: '#nope' }],
    },
    { shot: 'never-taken' },
  ],
});
