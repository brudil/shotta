/** Running one flow at one profile. */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type Browser,
  type BrowserContext,
  devices,
  type Page,
} from 'playwright';

import type { ResolvedConfig, ResolvedProfile, Setup } from './config.js';
import { describeStep, type Flow, hasMotion, walk } from './flow.js';
import { installOverlays, setAnnotation, takePress } from './overlays.js';
import { Recorder } from './recorder.js';
import type { PassResult } from './report.js';
import { capture, settle, trackNetwork, watchForChange } from './settle.js';
import { perform, type StepContext } from './steps.js';
import { Storyboard, writeStoryboard } from './storyboard.js';
import { writeTiles } from './tiles.js';

/** The opening frame is held this long, so a video does not start mid-motion. */
const VIDEO_LEAD_MS = 250;
/** A page too broken to describe itself should not hold up the report. */
const ARIA_TIMEOUT = 3_000;
/** Enough to diagnose a failure without flooding the report. */
const MAX_CONSOLE_ERRORS = 20;

export interface RunFlowOptions {
  browser: Browser;
  baseUrl: string;
  /** Absolute. */
  outDir: string;
  profile: ResolvedProfile;
  config: ResolvedConfig;
  log: (msg: string) => void;
  /**
   * With `shareSetup`, what the setup left at a profile, made once and shared
   * by every pass that asks; null for each pass to run the setup itself.
   */
  setupState?: ((profile: ResolvedProfile) => Promise<StorageState>) | null;
}

/** Cookies and storage, as a context saves and is started from. */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * A context set up as every page shotta drives needs it: the profile's
 * device, the project's page setup and overlays, and the watch on what moves.
 */
async function openContext(
  browser: Browser,
  profile: ResolvedProfile,
  config: ResolvedConfig,
  storageState?: StorageState,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...emulationFor(profile),
    ...(storageState === undefined ? {} : { storageState }),
  });
  context.setDefaultTimeout(config.actionTimeout);
  await context.addInitScript(installOverlays, {
    localStorage: config.localStorage,
    hide: config.hide,
    touch: profile.hasTouch,
  });
  await context.addInitScript(watchForChange);
  return context;
}

/**
 * Run the setup once per profile, however many passes ask, and hand each the
 * cookies and storage (IndexedDB included) it left. A setup that fails fails
 * every pass at that profile, once.
 */
export function sharedSetup(
  setup: Setup,
  {
    browser,
    baseUrl,
    config,
  }: Pick<RunFlowOptions, 'browser' | 'baseUrl' | 'config'>,
): (profile: ResolvedProfile) => Promise<StorageState> {
  const made = new Map<string, Promise<StorageState>>();
  const make = async (profile: ResolvedProfile): Promise<StorageState> => {
    const context = await openContext(browser, profile, config);
    try {
      const page = await context.newPage();
      await setup(page, {
        baseUrl: baseUrl.replace(/\/$/, ''),
        profile: profile.name,
      });
      return await context.storageState({ indexedDB: true });
    } finally {
      await context.close();
    }
  };
  return (profile) => {
    let state = made.get(profile.name);
    if (state === undefined) {
      state = make(profile);
      made.set(profile.name, state);
    }
    return state;
  };
}

/** Playwright colours its call logs for a terminal; a report is not one. */
function plain(message: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape codes is the point
  return message.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function emulationFor(profile: ResolvedProfile) {
  // A preset contributes everything it knows about the device; explicit keys win.
  const { defaultBrowserType: _browser, ...preset } =
    profile.device === null
      ? { defaultBrowserType: undefined }
      : (devices[profile.device] ?? { defaultBrowserType: undefined });
  const emulation = {
    ...preset,
    ...(profile.viewport === null ? {} : { viewport: profile.viewport }),
    ...(profile.deviceScaleFactor === null
      ? {}
      : { deviceScaleFactor: profile.deviceScaleFactor }),
    ...(profile.colorScheme === null
      ? {}
      : { colorScheme: profile.colorScheme }),
  };
  if (!('viewport' in emulation) || !emulation.viewport) {
    throw new Error(`profile ${profile.name} resolved to no viewport`);
  }
  return { ...emulation, viewport: emulation.viewport };
}

async function assertNotFailed(
  page: Page,
  failWhen: ResolvedConfig['failWhen'],
): Promise<void> {
  for (const { selector, message } of failWhen) {
    if ((await page.locator(selector).count()) > 0) {
      throw new Error(message ?? `failWhen matched: ${selector}`);
    }
  }
}

/** Whether a pass will be recorded: the config allows it and the flow has something to watch. */
export function records(flow: Flow, config: ResolvedConfig): boolean {
  return config.video && (flow.video ?? hasMotion(flow.steps));
}

/**
 * Never throws for something the flow did: a failed step is reported in the
 * result, with a screenshot of where it happened, so the passes after it run.
 */
export async function runFlow(
  flow: Flow,
  {
    browser,
    baseUrl,
    outDir,
    profile,
    config,
    log,
    setupState = null,
  }: RunFlowOptions,
): Promise<PassResult> {
  const startedAt = Date.now();
  // Per profile, so one profile's pass does not wipe another's output.
  const flowDir = path.join(outDir, flow.name, profile.name);
  await rm(flowDir, { recursive: true, force: true });
  await mkdir(flowDir, { recursive: true });

  const result: PassResult = {
    flow: flow.name,
    profile: profile.name,
    ok: true,
    durationMs: 0,
    shots: [],
    video: null,
    storyboard: [],
    consoleErrors: [],
    unsettled: [],
    failure: null,
  };
  const noteConsoleError = (text: string): void => {
    if (result.consoleErrors.length < MAX_CONSOLE_ERRORS) {
      result.consoleErrors.push(text);
    }
  };

  const moves = hasMotion(flow.steps);
  const wantsVideo = flow.video ?? moves;
  // The same test as for a video: a flow that only loads a route and shoots it
  // would get a sheet of one frame, which is the shot.
  const storyboard = config.storyboard && moves ? new Storyboard() : null;
  let viewport = { width: 0, height: 0 };
  const recordVideo = config.video && wantsVideo;
  if (config.video && !wantsVideo) {
    log('  · no video: the flow only loads and shoots');
  }
  // Pacing and pointer travel exist to make a recording watchable. With nobody
  // to watch, they are only time: the pointer still ends up on its target.
  const pace = recordVideo ? (flow.pace ?? config.pace) : 0;
  const cursor = recordVideo && flow.cursor !== false && !profile.hasTouch;

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let recorder: Recorder | null = null;
  const at = { step: 0, action: 'start', chapter: null as string | null };

  try {
    viewport = emulationFor(profile).viewport;
    // Shared, the setup ran once for every pass at this profile, and each
    // starts from what it left; otherwise each pass runs it for itself.
    let signedIn: StorageState | undefined;
    if (setupState !== null) {
      at.action = 'setup';
      log('  · setup (shared by the passes at this profile)');
      signedIn = await setupState(profile);
    }
    // A fresh context per pass is what resets the app's state between flows.
    context = await openContext(browser, profile, config, signedIn);
    page = await context.newPage();
    page.on('pageerror', (error) => noteConsoleError(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') noteConsoleError(message.text());
    });
    const network = trackNetwork(page, config.ignoreRequests);
    // Set by a `goto` and equally by a click on a plain link.
    let newDocument = false;
    const main = page.mainFrame();
    page.on('framenavigated', (frame) => {
      if (frame === main) newDocument = true;
    });

    const ctx: StepContext = {
      baseUrl,
      steps: config.steps,
      cursor,
      touch: profile.hasTouch,
      video: recordVideo,
      log,
      // The pointer rests in the corner until a step moves it: parked over
      // content it raises hover states and chart tooltips in unrelated shots.
      mouse: { x: 2, y: 2 },
    };

    if (config.setup !== null && setupState === null) {
      at.action = 'setup';
      log('  · setup');
      await config.setup(page, {
        baseUrl: baseUrl.replace(/\/$/, ''),
        profile: profile.name,
      });
    }

    let shotIndex = 0;
    let chapterShown: string | null = null;
    for (const { step, chapter } of walk(flow.steps)) {
      at.step += 1;
      at.action = describeStep(step);
      at.chapter = chapter;
      if (chapter !== chapterShown) {
        chapterShown = chapter;
        if (chapter !== null) log(`  ▸ ${chapter}`);
        // The caption is for the recording; elsewhere it only covers the app.
        if (recordVideo) await setAnnotation(page, chapter);
      }
      log(`  ${String(at.step).padStart(2, '0')} ${at.action}`);
      await perform(page, step, ctx);
      // A shot or a wait does nothing to the page: if it is already quiet,
      // one look says so, and if it is not, it is waited for as after any step.
      const waitingOn = await settle(page, network, {
        inert: 'shot' in step || 'wait' in step,
      });
      if (waitingOn !== null) {
        log(`     · the page never went quiet (${waitingOn.join(', ')})`);
        result.unsettled.push({
          step: at.step,
          action: at.action,
          waitingOn,
        });
      }
      if (newDocument) {
        // Navigation destroyed the injected overlays; restore their state.
        newDocument = false;
        if (recordVideo) await setAnnotation(page, chapterShown);
        if (cursor) await page.mouse.move(ctx.mouse.x, ctx.mouse.y);
      }
      if (recordVideo && recorder === null) {
        // The first settle is the end of the initial load, so the recording
        // opens on the app rather than on a blank page and a skeleton.
        recorder = await Recorder.start(
          page,
          path.join(flowDir, 'journey.webm'),
          viewport,
        );
        await page.waitForTimeout(VIDEO_LEAD_MS);
      }
      await assertNotFailed(page, config.failWhen);
      const pressed = storyboard === null ? null : await takePress(page);
      storyboard?.add({
        step: at.step,
        action: at.action,
        chapter,
        shot: 'shot' in step ? step.shot : undefined,
        shows: 'shot' in step ? (step.shows ?? null) : null,
        image: await page.screenshot({ scale: 'css' }),
        press: pressed,
        failure: null,
      });
      if ('shot' in step) {
        shotIndex += 1;
        const dir =
          chapter === null ? flowDir : path.join(flowDir, slug(chapter));
        await mkdir(dir, { recursive: true });
        const file = path.join(
          dir,
          `${String(shotIndex).padStart(2, '0')}-${step.shot}.png`,
        );
        const area =
          step.of !== undefined
            ? { of: step.of, pad: step.pad ?? 0 }
            : step.viewport === true
              ? 'viewport'
              : 'page';
        await capture(page, file, area, recorder, network);
        const tiles =
          config.tileHeight === null
            ? []
            : await writeTiles(file, config.tileHeight);
        result.shots.push({
          name: step.shot,
          shows: step.shows ?? null,
          area: typeof area === 'object' ? 'element' : area,
          chapter,
          step: at.step,
          file,
          tiles,
        });
      }
      if (pace > 0) await page.waitForTimeout(pace);
    }
  } catch (error) {
    result.ok = false;
    const message = error instanceof Error ? error.message : String(error);
    let screenshot: string | null = null;
    let aria: string | null = null;
    if (page !== null) {
      // The overlays stay in: where the cursor was is part of what went wrong.
      const file = path.join(flowDir, 'failure.png');
      try {
        await page.screenshot({ path: file });
        screenshot = file;
        storyboard?.add({
          ...at,
          shows: null,
          image: await page.screenshot({ scale: 'css' }),
          press: null,
          failure: plain(message).split('\n')[0] ?? '',
        });
      } catch {
        // The page is gone; the message has to do.
      }
      // What was actually on the page, in the terms a selector is written in:
      // usually enough to see why one did not match.
      const tree = path.join(flowDir, 'failure.aria.yml');
      try {
        const snapshot = await page
          .locator('body')
          .ariaSnapshot({ timeout: ARIA_TIMEOUT });
        await writeFile(tree, `${snapshot}\n`);
        aria = tree;
      } catch {
        // Likewise.
      }
    }
    result.failure = {
      ...at,
      message: plain(message),
      url: page?.url() ?? '',
      screenshot,
      aria,
    };
  } finally {
    if (recorder !== null) {
      try {
        await recorder.stop();
        result.video = recorder.file;
      } catch (error) {
        // A flow asked to be recorded and was not: that is a failed pass, not
        // a footnote.
        const why = error instanceof Error ? error.message : String(error);
        log(`  · no video: ${why.split('\n')[0]}`);
        result.ok = false;
        result.failure ??= {
          ...at,
          action: 'record journey.webm',
          message: why,
          url: page?.url() ?? '',
          screenshot: null,
          aria: null,
        };
      }
    }
    await context?.close();
    if (storyboard !== null) {
      try {
        result.storyboard = await writeStoryboard(browser, storyboard.frames, {
          title: `${flow.name} · ${profile.name}`,
          viewport,
          dir: flowDir,
        });
      } catch (error) {
        // The shots and the video stand without it.
        const why = error instanceof Error ? error.message : String(error);
        log(`  · could not write the storyboard: ${why.split('\n')[0]}`);
      }
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
