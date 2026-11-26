import { describe, expect, it } from 'vitest';

import { codecFrom, ffmpegCandidates, Timeline } from './recorder.js';

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

describe('ffmpegCandidates', () => {
  it("tries the revisions the project's Playwright asks for before the rest", () => {
    const installed = [
      'chromium-1228',
      'ffmpeg-1013',
      'ffmpeg-1011',
      'ffmpeg-1009',
    ];

    // Another project's newer Playwright put 1013 there; this one wants 1011.
    expect(ffmpegCandidates(installed, ['1011', '1010'])).toEqual([
      'ffmpeg-1011',
      'ffmpeg-1013',
      'ffmpeg-1009',
    ]);
  });

  it('falls back to the newest when what is asked for is not installed', () => {
    expect(ffmpegCandidates(['ffmpeg-999', 'ffmpeg-1013'], ['1011'])).toEqual([
      'ffmpeg-1013',
      'ffmpeg-999',
    ]);
    expect(ffmpegCandidates(['ffmpeg-1011', 'ffmpeg-1013'], [])).toEqual([
      'ffmpeg-1013',
      'ffmpeg-1011',
    ]);
  });
});

describe('codecFrom', () => {
  // As Playwright's own builds list them.
  const vp8 = ' V....D libvpx               libvpx VP8 (codec vp8)\n';
  const vp9 = ' V....D libvpx-vp9           libvpx VP9 (codec vp9)\n';

  it('writes VP9 where it can, and VP8 where that is all there is', () => {
    expect(codecFrom(vp9)).toBe('vp9');
    expect(codecFrom(vp8)).toBe('vp8');
    expect(codecFrom(vp8 + vp9)).toBe('vp9');
  });

  it('finds neither in an ffmpeg built without them', () => {
    expect(
      codecFrom(' V....D mjpeg                MJPEG (Motion JPEG)\n'),
    ).toBeNull();
  });
});
