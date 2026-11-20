/** Waiting for the page to hold still, and capturing it once it does. */
import pixelmatch from 'pixelmatch';
import type { Page, Request } from 'playwright';
import { PNG } from 'pngjs';

import { freezeOverlays, hideOverlays } from './overlays.js';
import type { Recorder } from './recorder.js';

const SETTLE_TIMEOUT = 20_000;
const NETWORK_QUIET = 500;
const POLL_MS = 100;
/** Quiet has to hold this many polls: a transition starts a frame after its step. */
const QUIET_POLLS = 3;
const PIXEL_TIMEOUT = 3_000;
const PIXEL_STABLE_FRAMES = 2;
/** Fraction of differing pixels treated as noise. */
const PIXEL_TOLERANCE = 0.001;
/** Dev-server chatter (module requests, hot updates) that never goes quiet. */
const DEV_SERVER_REQUESTS = /@vite|@fs|@ng|\.hot-update\./;

export interface NetworkTracker {
  quiet: () => boolean;
}

/**
 * Track in-flight requests, ignoring pollers, so a step can wait for the app's
 * own data to land.
 */
export function trackNetwork(
  page: Page,
  ignore: (string | RegExp)[],
): NetworkTracker {
  const inflight = new Set<Request>();
  let lastChange = Date.now();
  const ignored = (url: string): boolean =>
    DEV_SERVER_REQUESTS.test(url) ||
    ignore.some((pattern) =>
      typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url),
    );
  const relevant = (req: Request): boolean =>
    req.resourceType() !== 'websocket' && !ignored(req.url());
  page.on('request', (req) => {
    if (relevant(req)) {
      inflight.add(req);
      lastChange = Date.now();
    }
  });
  const done = (req: Request): void => {
    if (inflight.delete(req)) lastChange = Date.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    quiet: () =>
      inflight.size === 0 && Date.now() - lastChange >= NETWORK_QUIET,
  };
}

/**
 * True when nothing in the page is still loading, painting or animating. A
 * framework's own "stable" signal is not something every app has, so these are
 * the signals every page gives.
 */
function domQuiet(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (document.fonts && document.fonts.status !== 'loaded') return false;
    for (const image of document.images) {
      if (!image.complete) return false;
    }
    if (document.querySelector('[aria-busy="true"]') !== null) return false;
    const moving = document.getAnimations().filter((animation) => {
      if (animation.playState !== 'running') return false;
      const timing = animation.effect?.getComputedTiming();
      if (!timing) return false;
      // Spinners loop forever; waiting for them would never return.
      if (timing.iterations === Infinity || timing.duration === Infinity) {
        return false;
      }
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-shots-cursor], [data-shots-annotation], [data-shots-pulse]',
        ) !== null
      ) {
        return false;
      }
      return true;
    });
    return moving.length === 0;
  });
}

/**
 * Ask the page something while a step may still be navigating it. A click on a
 * link returns before the new document exists, and the old one is torn down
 * under whatever was running in it; that is not a failure, only a page that
 * has not settled yet. Resolves undefined when that happened.
 */
async function acrossNavigation<T>(
  page: Page,
  ask: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await ask();
  } catch (error) {
    const torndown =
      error instanceof Error &&
      /Execution context was destroyed|Cannot find context with specified id/.test(
        error.message,
      );
    if (!torndown) throw error;
    await page.waitForLoadState('load');
    return undefined;
  }
}

/**
 * Wait for the network and the DOM to go quiet. Resolves false if they never
 * did: the flow carries on, since a page that is busy forever can still be shot.
 * `inert` says the step just performed could not have changed the page.
 */
export async function settle(
  page: Page,
  network: NetworkTracker,
  { inert = false }: { inert?: boolean } = {},
): Promise<boolean> {
  await page.waitForLoadState('load');
  // A step that changed nothing has no transition to wait out: one look
  // confirms the page is as quiet as the step before left it.
  if (inert) {
    const quiet = await acrossNavigation(
      page,
      async () => network.quiet() && (await domQuiet(page)),
    );
    if (quiet === true) return true;
  }
  // A transition triggered by the previous step does not exist yet in the frame
  // that step returned in; give the browser two frames to start it.
  await acrossNavigation(page, () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    ),
  );
  const deadline = Date.now() + SETTLE_TIMEOUT;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const quiet = await acrossNavigation(
      page,
      async () => network.quiet() && (await domQuiet(page)),
    );
    if (quiet === true) {
      consecutive += 1;
      if (consecutive >= QUIET_POLLS) return true;
    } else {
      consecutive = 0;
    }
    await page.waitForTimeout(POLL_MS);
  }
  return false;
}

/**
 * Wait until successive viewport frames stop changing. Canvas views (maps,
 * charts) are invisible to every DOM signal, so compare pixels. The caller must
 * have frozen the overlays first, or the cursor's own transition counts as
 * change.
 */
async function settlePixels(page: Page): Promise<void> {
  const deadline = Date.now() + PIXEL_TIMEOUT;
  let previous: Buffer | null = null;
  let stable = 0;
  while (Date.now() < deadline) {
    // CSS scale: this only asks whether anything changed, and a 2x or 3x
    // profile would multiply the comparison cost for no extra answer.
    const frame = await page.screenshot({ scale: 'css' });
    if (previous !== null) {
      const before = PNG.sync.read(previous);
      const after = PNG.sync.read(frame);
      if (before.width === after.width && before.height === after.height) {
        const differing = pixelmatch(
          before.data,
          after.data,
          undefined,
          before.width,
          before.height,
          { threshold: 0.1 },
        );
        if (differing / (before.width * before.height) <= PIXEL_TOLERANCE) {
          stable += 1;
          if (stable >= PIXEL_STABLE_FRAMES) return;
        } else {
          stable = 0;
        }
      }
    }
    previous = frame;
    await page.waitForTimeout(POLL_MS);
  }
}

/**
 * Write a full-page screenshot of the settled page, without the overlays. A
 * recording is paused for it: the overlays are hidden, and the capture itself
 * can reflow the page for a frame, neither of which belongs in the video.
 */
export async function capture(
  page: Page,
  file: string,
  recorder: Recorder | null,
): Promise<void> {
  await freezeOverlays(page, true);
  try {
    await settlePixels(page);
    recorder?.pause();
    try {
      // Hidden for the screenshot only: a fixed element lands at the top of a
      // full-page capture.
      await hideOverlays(page, true);
      try {
        await page.screenshot({ path: file, fullPage: true });
      } finally {
        await hideOverlays(page, false);
      }
      // Drawn again before the recording picks up.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    } finally {
      recorder?.resume();
    }
  } finally {
    await freezeOverlays(page, false);
  }
}
