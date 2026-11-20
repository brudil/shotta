import { defineFlow } from 'shots';

export default defineFlow({
  steps: [{ goto: '/about.html' }, { shot: 'about' }],
});
