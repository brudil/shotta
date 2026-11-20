import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { Storyboard, sheetLayout } from './storyboard.js';

/** A flat 40×40 frame; `marks` pixels differ from a blank one. */
function frame(shade: number, marks = 0): Buffer {
  const png = new PNG({ width: 40, height: 40 });
  png.data.fill(shade);
  for (let index = 0; index < marks; index += 1)
    png.data[index * 4] = 255 - shade;
  return PNG.sync.write(png);
}

const base = { chapter: null, press: null, failure: null, shows: null };

describe('Storyboard', () => {
  it('folds a step that changed nothing into the frame before it', () => {
    const board = new Storyboard();
    board.add({ ...base, step: 1, action: 'goto /', image: frame(200) });
    board.add({ ...base, step: 2, action: 'wait #list', image: frame(200) });
    board.add({
      ...base,
      step: 3,
      action: 'shot home',
      shot: 'home',
      image: frame(200),
    });
    board.add({ ...base, step: 4, action: 'click #open', image: frame(20) });

    expect(board.frames.map((f) => f.steps.map((s) => s.step))).toEqual([
      [1, 2, 3],
      [4],
    ]);
    expect(board.frames[0]?.shots).toEqual(['home']);
  });

  it('treats a pixel or two of difference as the same moment', () => {
    const board = new Storyboard();
    board.add({ ...base, step: 1, action: 'goto /', image: frame(200) });
    board.add({ ...base, step: 2, action: 'hover #a', image: frame(200, 1) });

    expect(board.frames).toHaveLength(1);
  });

  it('starts a new frame at a chapter boundary even when nothing moved', () => {
    const board = new Storyboard();
    board.add({ ...base, step: 1, action: 'goto /', image: frame(200) });
    board.add({
      ...base,
      chapter: 'Check the totals',
      step: 2,
      action: 'wait #totals',
      image: frame(200),
    });

    expect(board.frames).toHaveLength(2);
  });

  it('keeps where the page was pressed, and never folds a failure away', () => {
    const board = new Storyboard();
    board.add({
      ...base,
      step: 1,
      action: 'click #a',
      press: { x: 5, y: 6 },
      image: frame(200),
    });
    board.add({
      ...base,
      step: 2,
      action: 'click #nope',
      failure: 'Timeout',
      image: frame(200),
    });

    expect(board.frames[0]?.press).toEqual({ x: 5, y: 6 });
    expect(board.frames[1]?.failure).toBe('Timeout');
  });
});

describe('sheetLayout', () => {
  it('puts desktop frames three across', () => {
    expect(sheetLayout({ width: 1440, height: 1000 })).toEqual({
      columns: 3,
      cellWidth: 493,
      cellHeight: 342,
      rowsPerPage: 3,
    });
  });

  it('puts phone frames six across', () => {
    const layout = sheetLayout({ width: 393, height: 852 });

    expect(layout.columns).toBe(6);
    expect(layout.rowsPerPage).toBe(2);
  });

  it('never makes a page taller than a model reads at full detail', () => {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 393, height: 852 },
      { width: 810, height: 1080 },
      { width: 1920, height: 1080 },
    ]) {
      const { cellHeight, rowsPerPage } = sheetLayout(viewport);
      const height = 36 + 16 * 2 + rowsPerPage * (cellHeight + 62 + 12) - 12;

      expect(height).toBeLessThanOrEqual(1568);
    }
  });
});
