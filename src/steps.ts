/** Performing one step, including the pointer travel that makes it watchable. */
import type { Page } from 'playwright';

import type { AnyStepHandlers } from './config.js';
import { type ActionStep, stepKind } from './flow.js';
import { type Point, pulse } from './overlays.js';

const CURSOR_MIN_MS = 250;
const CURSOR_MAX_MS = 650;
const FRAME_MS = 16;
/** The cursor holds still on a target before pressing it. Video only. */
const CURSOR_DWELL_MS = 320;

export interface StepContext {
  baseUrl: string;
  /** The project's own steps. */
  steps: AnyStepHandlers;
  /** Animate pointer travel. Only worth its time when someone will watch it. */
  cursor: boolean;
  touch: boolean;
  video: boolean;
  mouse: Point;
  log: (msg: string) => void;
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Move the real pointer to a point over several frames. The drawn cursor follows
 * `mousemove`, so this animates both. The path itself is monotone: overshooting
 * for real would trip hovers on whatever sits past the target.
 */
async function travel(page: Page, ctx: StepContext, to: Point): Promise<void> {
  const from = { x: ctx.mouse.x, y: ctx.mouse.y };
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = Math.min(
    CURSOR_MAX_MS,
    Math.max(CURSOR_MIN_MS, distance * 1.1),
  );
  const frames = Math.max(2, Math.round(duration / FRAME_MS));
  for (let frame = 1; frame <= frames; frame += 1) {
    const t = easeOutCubic(frame / frames);
    await page.mouse.move(
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
    );
    await page.waitForTimeout(duration / frames);
  }
  ctx.mouse.x = to.x;
  ctx.mouse.y = to.y;
}

/** Centre of an element, after scrolling it into view. */
async function centreOf(page: Page, selector: string): Promise<Point> {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no bounding box for selector: ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Travel to an element and press the mouse there, so the recorded pointer and
 * the real click are the same event. Touch profiles tap instead: there is no
 * pointer to move, so the hold and the ring carry the whole gesture.
 */
async function clickAt(
  page: Page,
  ctx: StepContext,
  selector: string,
): Promise<void> {
  const point = await centreOf(page, selector);
  const target = page.locator(selector).first();
  if (ctx.touch) {
    if (ctx.video) await page.waitForTimeout(CURSOR_DWELL_MS);
    await pulse(page, point);
    // Through the locator, not `page.touchscreen`: dispatching at raw
    // coordinates skips the hit-target check, so a covered control is pressed
    // silently and the shot records a state the step never reached.
    await target.tap();
    return;
  }
  await travel(page, ctx, point);
  // Arrive, hold, then press. Without the hold the cursor lands and the page
  // reacts in the same few frames, and the video never shows what was hit.
  if (ctx.video) await page.waitForTimeout(CURSOR_DWELL_MS);
  await pulse(page, point);
  await target.click();
}

export async function perform(
  page: Page,
  step: ActionStep,
  ctx: StepContext,
): Promise<void> {
  if ('goto' in step) {
    const url = /^https?:/.test(step.goto)
      ? step.goto
      : ctx.baseUrl.replace(/\/$/, '') + step.goto;
    await page.goto(url, { waitUntil: 'load' });
  } else if ('click' in step) {
    if (ctx.cursor || ctx.touch) await clickAt(page, ctx, step.click);
    else await page.locator(step.click).first().click();
  } else if ('hover' in step) {
    if (ctx.touch) ctx.log(`     hover skipped: ${step.hover} (touch profile)`);
    else if (ctx.cursor)
      await travel(page, ctx, await centreOf(page, step.hover));
    else await page.locator(step.hover).first().hover();
  } else if ('type' in step) {
    const delay = step.delay ?? 35;
    if (step.into === undefined) {
      // To whatever has the focus: the pointer stays where it is.
      await page.keyboard.type(step.type, { delay });
    } else {
      const field = page.locator(step.into).first();
      if (ctx.cursor || ctx.touch) await clickAt(page, ctx, step.into);
      else await field.click();
      await field.fill('');
      await field.pressSequentially(step.type, { delay });
    }
  } else if ('scroll' in step) {
    if (typeof step.scroll === 'number') await page.mouse.wheel(0, step.scroll);
    else await page.locator(step.scroll).first().scrollIntoViewIfNeeded();
  } else if ('press' in step) {
    await page.keyboard.press(step.press);
  } else if ('wait' in step) {
    if (typeof step.wait === 'number') await page.waitForTimeout(step.wait);
    else await page.locator(step.wait).first().waitFor();
  } else if ('shot' in step) {
    // Checkpoint is taken by the step loop, once the page has settled.
  } else if ('run' in step) {
    await step.run(page);
  } else {
    const kind = stepKind(step);
    const handler = ctx.steps[kind];
    if (handler === undefined) throw new Error(`no handler for step: ${kind}`);
    await handler(page, (step as Record<string, unknown>)[kind]);
  }
}
