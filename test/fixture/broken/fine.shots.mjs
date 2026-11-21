import { defineFlow } from 'shotta';

export default defineFlow({
  steps: [{ goto: '/' }, { shot: 'home' }],
});
