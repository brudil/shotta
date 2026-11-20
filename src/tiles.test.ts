import { describe, expect, it } from 'vitest';

import { tileRanges } from './tiles.js';

describe('tileRanges', () => {
  it('leaves an image that fits as one tile', () => {
    expect(tileRanges(900, 1568)).toEqual([{ top: 0, height: 900 }]);
    expect(tileRanges(1568, 1568)).toEqual([{ top: 0, height: 1568 }]);
  });

  it('cuts a tall image into full-height tiles that overlap', () => {
    expect(tileRanges(4000, 1568)).toEqual([
      { top: 0, height: 1568 },
      { top: 1488, height: 1568 },
      { top: 2432, height: 1568 },
    ]);
  });

  it('aligns the last tile to the bottom rather than leaving a sliver', () => {
    const ranges = tileRanges(1600, 1568);

    expect(ranges).toEqual([
      { top: 0, height: 1568 },
      { top: 32, height: 1568 },
    ]);
  });

  it('covers every row', () => {
    for (const height of [1569, 3056, 3057, 9999]) {
      const ranges = tileRanges(height, 1568);
      let covered = 0;
      for (const range of ranges) {
        expect(range.top).toBeLessThanOrEqual(covered);
        covered = range.top + range.height;
      }
      expect(covered).toBe(height);
    }
  });
});
