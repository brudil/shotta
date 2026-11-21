import { defineFlow } from 'shotta';

export default defineFlow({
  steps: [{ goto: '/crashed.html' }, { shot: 'never-taken' }],
});
