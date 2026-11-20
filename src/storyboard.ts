/**
 * A journey as a contact sheet: one frame per step that changed something,
 * captioned with what the step did. It is the video for a reader who cannot
 * watch one — a whole flow in an image or two.
 */
import path from 'node:path';

import pixelmatch from 'pixelmatch';
import type { Browser } from 'playwright';
import { PNG } from 'pngjs';

import type { Point } from './overlays.js';

/** Sheets stay within what a vision model reads at full detail, both ways. */
const SHEET_WIDTH = 1536;
const SHEET_MAX_HEIGHT = 1568;
const PADDING = 16;
const GAP = 12;
const HEADER = 36;
const CAPTION = 62;
/** A frame is drawn about this wide: enough for layout, not for body text. */
const LANDSCAPE_CELL = 490;
const PORTRAIT_CELL = 240;
/** Fraction of differing pixels below which two frames are the same moment. */
const SAME_FRAME = 0.001;

export interface FrameStep {
  /** 1-based position in the flow. */
  step: number;
  action: string;
}

/** What one cell of the sheet shows. */
export interface Frame {
  /** The viewport, at CSS size. */
  image: Buffer;
  /** Every step this frame stands for: the one that produced it and any after that left it unchanged. */
  steps: FrameStep[];
  chapter: string | null;
  /** Names of the shots taken of this state. */
  shots: string[];
  /** What the flow says a shot of this state shows. */
  shows: string | null;
  /** Where the step pressed, in viewport coordinates. */
  press: Point | null;
  /** Set on the frame a failed step left behind. */
  failure: string | null;
}

export interface SheetLayout {
  columns: number;
  cellWidth: number;
  cellHeight: number;
  rowsPerPage: number;
}

/** How frames of a given viewport are arranged on a sheet. */
export function sheetLayout(viewport: {
  width: number;
  height: number;
}): SheetLayout {
  const inner = SHEET_WIDTH - PADDING * 2;
  const target =
    viewport.width >= viewport.height ? LANDSCAPE_CELL : PORTRAIT_CELL;
  const columns = Math.max(1, Math.round((inner + GAP) / (target + GAP)));
  const cellWidth = Math.floor((inner - GAP * (columns - 1)) / columns);
  const cellHeight = Math.round((cellWidth * viewport.height) / viewport.width);
  const room = SHEET_MAX_HEIGHT - HEADER - PADDING * 2;
  const rowsPerPage = Math.max(
    1,
    Math.floor((room + GAP) / (cellHeight + CAPTION + GAP)),
  );
  return { columns, cellWidth, cellHeight, rowsPerPage };
}

function sameFrame(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return true;
  const before = PNG.sync.read(a);
  const after = PNG.sync.read(b);
  if (before.width !== after.width || before.height !== after.height) {
    return false;
  }
  const differing = pixelmatch(
    before.data,
    after.data,
    undefined,
    before.width,
    before.height,
    { threshold: 0.1 },
  );
  return differing / (before.width * before.height) <= SAME_FRAME;
}

/** Collects a flow's frames as it runs. */
export class Storyboard {
  readonly frames: Frame[] = [];

  /**
   * Record the page as a step left it. A step that changed nothing a viewer
   * could see — a wait, a shot — joins the frame before it rather than
   * repeating it.
   */
  add(frame: Omit<Frame, 'steps' | 'shots'> & FrameStep & { shot?: string }) {
    const { step, action, shot, ...rest } = frame;
    const last = this.frames.at(-1);
    if (
      last !== undefined &&
      last.failure === null &&
      rest.failure === null &&
      last.chapter === rest.chapter &&
      sameFrame(last.image, rest.image)
    ) {
      last.steps.push({ step, action });
      if (shot !== undefined) last.shots.push(shot);
      last.shows ??= rest.shows;
      last.press ??= rest.press;
      // The later frame is the truer one: the pointer may have moved on.
      last.image = rest.image;
      return;
    }
    this.frames.push({
      ...rest,
      steps: [{ step, action }],
      shots: shot === undefined ? [] : [shot],
    });
  }
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function cellHtml(frame: Frame, layout: SheetLayout, scale: number): string {
  const first = frame.steps[0];
  const numbers =
    frame.steps.length === 1
      ? String(first?.step).padStart(2, '0')
      : `${String(first?.step).padStart(2, '0')}–${String(frame.steps.at(-1)?.step).padStart(2, '0')}`;
  const actions = frame.steps
    .filter((s) => !s.action.startsWith('shot '))
    .map((s) => s.action)
    .join(' · ');
  const press =
    frame.press === null
      ? ''
      : `<i class="press" style="left:${frame.press.x * scale}px;top:${frame.press.y * scale}px"></i>`;
  const shots = frame.shots
    .map((name) => `<b class="shot">${escapeHtml(name)}</b>`)
    .join('');
  const note =
    frame.failure !== null
      ? `<p class="failed">${escapeHtml(frame.failure)}</p>`
      : frame.shows !== null
        ? `<p class="shows">${escapeHtml(frame.shows)}</p>`
        : frame.chapter !== null
          ? `<p class="chapter">${escapeHtml(frame.chapter)}</p>`
          : '';
  return `
    <figure class="${frame.failure === null ? '' : 'failure'}">
      <div class="frame" style="height:${layout.cellHeight}px">
        <img src="data:image/png;base64,${frame.image.toString('base64')}" />
        ${press}
      </div>
      <figcaption>
        <p class="action"><span>${numbers}</span> ${escapeHtml(actions)}${shots}</p>
        ${note}
      </figcaption>
    </figure>`;
}

function sheetHtml(
  title: string,
  frames: Frame[],
  layout: SheetLayout,
  scale: number,
): string {
  return `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: ${SHEET_WIDTH}px; padding: ${PADDING}px; background: #f3f4f6;
      color: #111827; font: 13px/1.35 system-ui, sans-serif; }
    h1 { height: ${HEADER}px; font-size: 17px; font-weight: 600; }
    main { display: grid; gap: ${GAP}px;
      grid-template-columns: repeat(${layout.columns}, ${layout.cellWidth}px); }
    figure { width: ${layout.cellWidth}px; }
    .frame { position: relative; overflow: hidden; background: #fff;
      outline: 1px solid #d1d5db; border-radius: 4px; }
    .failure .frame { outline: 3px solid #dc2626; }
    img { display: block; width: 100%; }
    .press { position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px;
      border-radius: 50%; border: 3px solid #2563eb; background: rgba(37, 99, 235, 0.25); }
    figcaption { height: ${CAPTION}px; padding-top: 6px; overflow: hidden; }
    p { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
    .action { -webkit-line-clamp: 2; font-family: ui-monospace, monospace; font-size: 12px; }
    .action span { color: #6b7280; }
    .shot { margin-left: 6px; padding: 0 6px; border-radius: 9999px;
      background: #111827; color: #fff; font: 600 11px/1.5 system-ui, sans-serif; }
    .chapter { -webkit-line-clamp: 1; color: #4b5563; font-weight: 600; }
    .shows { -webkit-line-clamp: 2; color: #111827; }
    figure:has(.shows) .action { -webkit-line-clamp: 1; }
    .failed { -webkit-line-clamp: 2; color: #b91c1c; font-weight: 600; }
    .failure .action { -webkit-line-clamp: 1; }
  </style>
  <h1>${escapeHtml(title)}</h1>
  <main>${frames.map((frame) => cellHtml(frame, layout, scale)).join('')}</main>`;
}

/**
 * Write the sheet, split into pages of whole rows so no frame is cut:
 * `storyboard.png`, or `storyboard.1.png`, `storyboard.2.png`, ….
 * @returns the pages' paths, in order
 */
export async function writeStoryboard(
  browser: Browser,
  frames: Frame[],
  {
    title,
    viewport,
    dir,
  }: {
    title: string;
    viewport: { width: number; height: number };
    dir: string;
  },
): Promise<string[]> {
  if (frames.length === 0) return [];
  const layout = sheetLayout(viewport);
  const scale = layout.cellWidth / viewport.width;
  const perPage = layout.columns * layout.rowsPerPage;
  const pages = Math.ceil(frames.length / perPage);

  // The same browser that took the frames lays them out: no image library.
  const context = await browser.newContext({
    // Short, so a full-page screenshot is exactly as tall as the sheet.
    viewport: { width: SHEET_WIDTH, height: 100 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    const files: string[] = [];
    for (let index = 0; index < pages; index += 1) {
      const heading = pages === 1 ? title : `${title} · ${index + 1}/${pages}`;
      await page.setContent(
        sheetHtml(
          heading,
          frames.slice(index * perPage, (index + 1) * perPage),
          layout,
          scale,
        ),
      );
      const name =
        pages === 1 ? 'storyboard.png' : `storyboard.${index + 1}.png`;
      const file = path.join(dir, name);
      await page.screenshot({ path: file, fullPage: true });
      files.push(file);
    }
    return files;
  } finally {
    await context.close();
  }
}
