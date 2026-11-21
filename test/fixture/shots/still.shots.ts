import { defineFlow } from 'shotta';

export default defineFlow({
  steps: [
    { goto: '/about.html' },
    { shot: 'about' },
    { shot: 'heading', of: 'h1', shows: 'Only the heading' },
    { shot: 'fold', viewport: true },
  ],
});
