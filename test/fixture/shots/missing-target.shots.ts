import { defineFlow } from 'shots';

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
