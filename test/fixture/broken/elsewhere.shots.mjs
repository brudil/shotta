import { defineFlow } from 'shotta';

export default defineFlow({
  profiles: ['watch'],
  steps: [{ goto: '/' }, { shot: 'face' }],
});
