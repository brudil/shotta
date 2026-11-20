import { describe, expect, it } from 'vitest';

import { Timeline } from './recorder.js';

describe('Timeline', () => {
  it('numbers frames at 25 a second from the first one', () => {
    const timeline = new Timeline();

    expect(timeline.place(10_000)).toBe(0);
    expect(timeline.place(10_040)).toBe(1);
    expect(timeline.place(11_000)).toBe(25);
  });

  it('drops what is drawn during a pause and closes the gap it leaves', () => {
    const timeline = new Timeline();
    timeline.place(10_000);
    timeline.pause(10_400);

    expect(timeline.place(10_500)).toBeNull();

    timeline.resume(11_400);

    // A second was cut: 11_800 is 800ms into the video, not 1800.
    expect(timeline.place(11_800)).toBe(20);
  });

  it('still drops a frame from a pause that arrives after it ended', () => {
    const timeline = new Timeline();
    timeline.place(10_000);
    timeline.pause(10_400);
    timeline.resume(11_400);

    expect(timeline.place(10_900)).toBeNull();
  });

  it('keeps a frame drawn before a pause that arrives during it', () => {
    const timeline = new Timeline();
    timeline.place(10_000);
    timeline.pause(10_400);

    expect(timeline.place(10_360)).toBe(9);
  });

  it('adds up every pause before a frame', () => {
    const timeline = new Timeline();
    timeline.place(10_000);
    timeline.pause(10_200);
    timeline.resume(10_700);
    timeline.pause(11_000);
    timeline.resume(11_500);

    expect(timeline.place(10_900)).toBe(10);
    expect(timeline.place(12_000)).toBe(25);
  });
});
