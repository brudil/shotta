import { defineFlow } from 'shots';

export default defineFlow({
  steps: [{ goto: '/crashed.html' }, { shot: 'never-taken' }],
});
