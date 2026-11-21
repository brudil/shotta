import { defineFlow } from 'shotta';

// JavaScript, so that nothing but shotta itself is there to catch the typo.
export default defineFlow({
  steps: [{ goto: '/' }, { clik: '#save' }, { shot: 'saved' }],
});
