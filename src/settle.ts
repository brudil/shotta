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
  /** The URLs of the requests still in flight. */
  pending: () => string[];
  /**
   * Stop waiting for the requests that began before `since`, a time in ms. A
   * request that has outlasted a whole settle is a stream in all but name, and
   * waiting for it again after every step would cost the same timeout each time.
   */
  abandon: (since: number) => void;
}

/**
 * Track in-flight requests, ignoring pollers and streams, so a step can wait
 * for the app's own data to land.
 */
export function trackNetwork(
  page: Page,
  ignore: (string | RegExp)[],
): NetworkTracker {
  /** Each request in flight, and when it began. */
  const inflight = new Map<Request, number>();
  let lastChange = Date.now();
  const ignored = (url: string): boolean =>
    DEV_SERVER_REQUESTS.test(url) ||
    ignore.some((pattern) =>
      typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url),
    );
  // A socket or an event stream stays open for as long as the page does.
  const relevant = (req: Request): boolean =>
    req.resourceType() !== 'websocket' &&
    req.resourceType() !== 'eventsource' &&
    !ignored(req.url());
  // The request for the document the page is on its way to, if it is going.
  let navigation: Request | null = null;
  const main = page.mainFrame();
  const sansHash = (url: string): string => url.replace(/#.*$/, '');
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === main) navigation = req;
    if (relevant(req)) {
      lastChange = Date.now();
      inflight.set(req, lastChange);
    }
  });
  const done = (req: Request): void => {
    if (inflight.delete(req)) lastChange = Date.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', (req) => {
    if (req === navigation) navigation = null;
    done(req);
  });
  // A document's requests die with it, and the browser does not always say so:
  // one begun as the page unloads gets neither a finish nor a failure, and
  // would be waited on for ever. So when a new document arrives, only its own
  // request is still in flight. A navigation within the document (pushState)
  // also arrives here, and must leave the app's requests alone: it is told
  // apart by there being no request for the address the frame is now at.
  page.on('framenavigated', (frame) => {
    if (frame !== main || navigation === null) return;
    if (sansHash(frame.url()) !== sansHash(navigation.url())) return;
    for (const req of inflight.keys()) {
      if (req !== navigation) inflight.delete(req);
    }
    navigation = null;
    lastChange = Date.now();
  });
  return {
    quiet: () =>
      inflight.size === 0 && Date.now() - lastChange >= NETWORK_QUIET,
    pending: () => [...inflight.keys()].map((req) => req.url()),
    abandon: (since) => {
      for (const [req, began] of inflight) {
        if (began < since) inflight.delete(req);
      }
    },
  };
}

/**
 * What in the page is still loading, painting or animating, in words; null
 * when nothing is. A framework's own "stable" signal is not something every
 * app has, so these are the signals every page gives.
 */
function domBusy(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const name = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      if (element.id !== '') return `${tag}#${element.id}`;
      const first = element.classList[0];
      return first === undefined ? tag : `${tag}.${first}`;
    };
    if (document.fonts && document.fonts.status !== 'loaded') {
      return 'fonts loading';
    }
    for (const image of document.images) {
      if (!image.complete) return `an image loading: ${image.currentSrc}`;
    }
    const busy = document.querySelector('[aria-busy="true"]');
    if (busy !== null) return `aria-busy on ${name(busy)}`;
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
    const target = (moving[0]?.effect as KeyframeEffect | null | undefined)
      ?.target;
    if (moving.length === 0) return null;
    return target instanceof Element
      ? `an animation on ${name(target)}`
      : 'an animation';
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

/** A URL short enough to read in a log line: its path, and the start of its query. */
function briefUrl(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return pathname + (search.length > 40 ? `${search.slice(0, 39)}…` : search);
  } catch {
    return url;
  }
}

/**
 * Wait for the network and the DOM to go quiet. Resolves null once they have,
 * or with what it was still waiting on if they never did: the flow carries on,
 * since a page that is busy forever can still be shot. `inert` says the step
 * just performed could not have changed the page.
 */
export async function settle(
  page: Page,
  network: NetworkTracker,
  { inert = false }: { inert?: boolean } = {},
): Promise<string[] | null> {
  const began = Date.now();
  await page.waitForLoadState('load');
  // What is keeping the page busy: nothing, or the reasons, or undefined when
  // the page was navigating and could not be asked.
  const busy = (): Promise<string[] | undefined> =>
    acrossNavigation(page, async () => {
      if (!network.quiet()) {
        const pending = network.pending();
        return pending.length === 0
          ? ['a request that only just finished']
          : pending.map((url) => `request ${briefUrl(url)}`);
      }
      const dom = await domBusy(page);
      return dom === null ? [] : [dom];
    });
  // A step that changed nothing has no transition to wait out: one look
  // confirms the page is as quiet as the step before left it.
  if (inert && (await busy())?.length === 0) return null;
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
  let waitingOn: string[] = ['the page, which was navigating'];
  while (Date.now() < deadline) {
    const reasons = await busy();
    if (reasons?.length === 0) {
      consecutive += 1;
      if (consecutive >= QUIET_POLLS) return null;
    } else {
      consecutive = 0;
      if (reasons !== undefined) waitingOn = reasons;
    }
    await page.waitForTimeout(POLL_MS);
  }
  // What has been in flight all this while has shown itself to be a stream:
  // the steps after this one do not wait for it again.
  network.abandon(began);
  return waitingOn;
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

/** What a shot is of: the whole page, what is on screen, or one element. */
export type ShotArea = 'page' | 'viewport' | { of: string };

/** A panel counts as the page's own scrolling when it is this much of the viewport's height. */
const PANEL_SHARE = 0.5;
/** Chromium draws a screenshot no taller than about this many device pixels. */
const MAX_SHOT_PIXELS = 16_000;
/** A panel that shares its height with another takes more than one growth to fit. */
const GROW_ROUNDS = 3;

/**
 * As much of a panel's bottom padding as a shot keeps. Padding that grows with
 * the viewport, there so the last line can be scrolled up the screen, would
 * otherwise never fit, and be most of the picture.
 */
const PANEL_PADDING = 64;

/**
 * The panels the page scrolls its content in, in three moves: `find` them and
 * say how much the tallest hides; `grown`, after the viewport has changed
 * height, say how much the ones that took the room hid to begin with (`wanted`,
 * only counted on the `first` look) and how much they still hide (`need`); and
 * `restore` every scroll position.
 *
 * An app that keeps its document one screen tall and scrolls a panel inside it
 * has, to a full-page screenshot, a page one screen tall. Small scrolling
 * things (a menu, a code block) are not the page.
 *
 * Serialised into the browser, so it can use nothing from this module's scope.
 */
function panels({
  move,
  share,
  padding,
}: {
  move: 'find' | 'first' | 'grown' | 'restore';
  share: number;
  padding: number;
}): { wanted: number; need: number } {
  interface Panel {
    element: Element;
    /** Where it was scrolled to, to be put back. */
    top: number;
    left: number;
    /** How much of it was out of sight to begin with. */
    hidden: number;
    /** Its height when last measured. */
    height: number;
    /** Whether it gets taller when the viewport does. */
    grows: boolean;
  }
  const page = window as Window & {
    __shotsPanels?: { panels: Panel[]; x: number; y: number };
  };

  /** How far an element's content runs past what it shows of it. */
  const hiddenIn = (element: Element): number => {
    const overflow = element.scrollHeight - element.clientHeight;
    if (overflow < 2) return 0;
    // By where the content ends, not by `scrollHeight`, which counts padding.
    const range = document.createRange();
    range.selectNodeContents(element);
    const ends =
      range.getBoundingClientRect().bottom -
      element.getBoundingClientRect().top -
      element.clientTop +
      element.scrollTop;
    const kept = Math.min(
      Number.parseFloat(getComputedStyle(element).paddingBottom) || 0,
      padding,
    );
    return Math.max(
      0,
      Math.min(overflow, Math.ceil(ends + kept - element.clientHeight)),
    );
  };

  if (move === 'find') {
    const found: Panel[] = [];
    const viewport = window.innerHeight;
    for (const element of document.querySelectorAll('body, body *')) {
      if (element.scrollHeight - element.clientHeight < 2) continue;
      if (element.clientHeight < viewport * share) continue;
      const overflow = getComputedStyle(element).overflowY;
      if (
        overflow !== 'auto' &&
        overflow !== 'scroll' &&
        overflow !== 'overlay'
      ) {
        continue;
      }
      // The body's overflow is the document's unless the root has its own, and
      // a document that scrolls is what a full-page screenshot already covers.
      if (
        element === document.body &&
        getComputedStyle(document.documentElement).overflowY === 'visible'
      ) {
        continue;
      }
      const hidden = hiddenIn(element);
      if (hidden < 2) continue;
      found.push({
        element,
        top: element.scrollTop,
        left: element.scrollLeft,
        hidden,
        height: element.clientHeight,
        grows: false,
      });
    }
    page.__shotsPanels = {
      panels: found,
      x: window.scrollX,
      y: window.scrollY,
    };
    const need = Math.max(0, ...found.map((panel) => panel.hidden));
    return { wanted: need, need };
  }

  const kept = page.__shotsPanels;
  if (kept === undefined) return { wanted: 0, need: 0 };

  if (move === 'restore') {
    for (const { element, top, left } of kept.panels) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    window.scrollTo(kept.x, kept.y);
    delete page.__shotsPanels;
    return { wanted: 0, need: 0 };
  }

  let wanted = 0;
  let need = 0;
  for (const panel of kept.panels) {
    const height = panel.element.clientHeight;
    // One that stays as it was has a height of its own: no viewport fits it.
    if (move === 'first') panel.grows = height - panel.height >= 1;
    panel.height = height;
    if (!panel.grows || !panel.element.isConnected) continue;
    wanted = Math.max(wanted, panel.hidden);
    need = Math.max(need, hiddenIn(panel.element));
  }
  return { wanted, need };
}

/** Let the browser draw what the last change asked for. */
function drawn(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/**
 * Make the viewport tall enough that the panels the page scrolls in show all
 * they hold, so a shot of the page is of all of it. Resolves with what puts
 * the viewport and every scroll position back, or null when the page has no
 * such panel and nothing was changed.
 */
async function showWholePanels(
  page: Page,
): Promise<(() => Promise<void>) | null> {
  const original = page.viewportSize();
  if (original === null) return null;
  const ask = (move: 'find' | 'first' | 'grown' | 'restore') =>
    page.evaluate(panels, { move, share: PANEL_SHARE, padding: PANEL_PADDING });
  const { need: hidden } = await ask('find');
  if (hidden < 2) return null;

  const restore = async (): Promise<void> => {
    await page.setViewportSize(original);
    await ask('restore');
    await drawn(page);
  };
  const resize = async (height: number): Promise<void> => {
    await page.setViewportSize({ width: original.width, height });
    await drawn(page);
  };
  try {
    const scale = await page.evaluate(() => window.devicePixelRatio);
    const limit = Math.max(
      original.height,
      Math.floor(MAX_SHOT_PIXELS / scale),
    );
    let height = Math.min(limit, original.height + hidden);
    await resize(height);
    let { wanted, need } = await ask('first');
    if (wanted === 0) {
      // Nothing took the room: what scrolls here has a height of its own.
      await restore();
      return null;
    }
    // The tallest may have been one that did not grow; the ones that did
    // need less, and more than they need is blank page.
    const enough = Math.min(limit, original.height + wanted);
    if (enough < height) {
      height = enough;
      await resize(height);
      ({ need } = await ask('grown'));
    }
    for (
      let round = 1;
      round < GROW_ROUNDS && need >= 2 && height < limit;
      round += 1
    ) {
      height = Math.min(limit, height + need);
      await resize(height);
      ({ need } = await ask('grown'));
    }
  } catch (error) {
    await restore().catch(() => {});
    throw error;
  }
  return restore;
}

/**
 * Write a screenshot of the settled page, without the overlays. A recording
 * is paused for it: the overlays are hidden, and a shot of the page is taken
 * in a viewport as tall as its content, neither of which belongs in the video.
 */
export async function capture(
  page: Page,
  file: string,
  area: ShotArea,
  recorder: Recorder | null,
  network: NetworkTracker,
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
        if (typeof area === 'object') {
          await page.locator(area.of).first().screenshot({ path: file });
        } else if (area === 'viewport') {
          await page.screenshot({ path: file });
        } else {
          const restore = await showWholePanels(page);
          try {
            if (restore !== null) {
              // What came into view may still be loading or drawing.
              await settle(page, network);
              await settlePixels(page);
            }
            await page.screenshot({ path: file, fullPage: true });
          } finally {
            await restore?.();
          }
        }
      } finally {
        await hideOverlays(page, false);
      }
      // Drawn again before the recording picks up.
      await drawn(page);
    } finally {
      recorder?.resume();
    }
  } finally {
    await freezeOverlays(page, false);
  }
}
