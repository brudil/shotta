/** The cursor, tap ring and chapter caption drawn into the page. */
import type { Page } from 'playwright';

export interface Point {
  x: number;
  y: number;
}

interface ShotsApi {
  setAnnotation: (text: string | null) => void;
  moveCursor: (x: number, y: number) => void;
  clearPulses: () => void;
  pulse: (x: number, y: number) => void;
  takePress: () => Point | null;
}

type ShotsWindow = Window & { __shots?: ShotsApi };

export interface OverlayOptions {
  localStorage: Record<string, string>;
  hide: string[];
  touch: boolean;
}

/**
 * Runs in the page on every document: applies the project's page setup and
 * installs the cursor and chapter caption. `recordVideo` captures page content,
 * so both are DOM elements; `capture` hides them before every screenshot.
 *
 * Serialised into the browser, so it can use nothing from this module's scope.
 */
export function installOverlays(options: OverlayOptions): void {
  try {
    for (const [key, value] of Object.entries(options.localStorage)) {
      localStorage.setItem(key, value);
    }
  } catch {
    // Documents without storage (about:blank) have nothing to set up.
  }

  const install = (): void => {
    if (options.touch) document.documentElement.classList.add('shots-touch');

    const style = document.createElement('style');
    const hidden =
      options.hide.length === 0
        ? ''
        : `${options.hide.join(', ')} { display: none !important; }`;
    style.textContent = `
      ${hidden}
      [data-shots-cursor], [data-shots-annotation], [data-shots-pulse] {
        position: fixed; pointer-events: none;
      }
      [data-shots-cursor] {
        top: 0; left: 0; z-index: 2147483647; width: 22px; height: 22px;
        margin: -2px 0 0 -2px;
        transform: translate(-100px, -100px);
        transition: transform 90ms cubic-bezier(0.34, 1.56, 0.64, 1);
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
      }
      /* Centred like a subtitle: apps keep widgets in both bottom corners. */
      [data-shots-annotation] {
        bottom: 40px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; max-width: 60%;
        padding: 10px 18px; border-radius: 9999px;
        background: rgba(17, 24, 39, 0.82); color: #fff;
        /* An edge of its own: over a dark theme the fill alone disappears. */
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.3);
        font: 500 16px/1.3 system-ui, sans-serif;
        opacity: 0; transition: opacity 180ms ease;
      }
      [data-shots-pulse] {
        z-index: 2147483646; width: 12px; height: 12px; margin: -6px 0 0 -6px;
        border-radius: 9999px; background: rgba(59, 130, 246, 0.55);
        animation: shots-pulse 400ms ease-out forwards;
      }
      @keyframes shots-pulse { to { transform: scale(3.5); opacity: 0; } }
      html.shots-hide-overlays [data-shots-cursor],
      html.shots-hide-overlays [data-shots-annotation],
      html.shots-hide-overlays [data-shots-pulse] { display: none !important; }
      /* A touch device has no pointer, so an arrow would show something the
         user cannot see. The pulse ring marks where the tap landed. */
      html.shots-touch [data-shots-cursor] { display: none !important; }
      /* Frozen overlays hold still, so they add no pixel churn while the frame
         stability loop runs and can stay visible in the video. */
      html.shots-freeze [data-shots-cursor],
      html.shots-freeze [data-shots-annotation] {
        transition: none !important; animation: none !important;
      }
      html.shots-freeze * { caret-color: transparent !important; }
    `;
    document.head.append(style);

    const cursor = document.createElement('div');
    cursor.dataset.shotsCursor = '';
    // Not part of the app, so not part of what assistive tech — or a failure's
    // accessibility snapshot — should find in it.
    cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML =
      '<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">' +
      '<path d="M2 1 L2 17 L6.5 12.8 L9.4 19.6 L12.4 18.2 L9.5 11.6 L15.6 11.2 Z"' +
      ' fill="#fff" stroke="#111827" stroke-width="1.4"/></svg>';

    const pill = document.createElement('div');
    pill.dataset.shotsAnnotation = '';
    pill.setAttribute('aria-hidden', 'true');

    document.body.append(cursor, pill);

    let pressed: { point: Point; on: Element | null } | null = null;
    const api: ShotsApi = {
      setAnnotation: (text) => {
        pill.textContent = text ?? '';
        pill.style.opacity = text ? '1' : '0';
      },
      moveCursor: (x, y) => {
        cursor.style.transform = `translate(${x}px, ${y}px)`;
      },
      clearPulses: () => {
        for (const ring of document.querySelectorAll('[data-shots-pulse]')) {
          ring.remove();
        }
      },
      takePress: () => {
        const press = pressed;
        pressed = null;
        if (press === null) return null;
        // A press that took the app somewhere else landed on something the
        // screen no longer shows; a mark there would point at nothing. What
        // was pressed has to be there still, and still under that point.
        const { point, on } = press;
        if (on === null || !on.isConnected) return null;
        const box = on.getBoundingClientRect();
        const under =
          point.x >= box.left &&
          point.x <= box.right &&
          point.y >= box.top &&
          point.y <= box.bottom;
        return under ? point : null;
      },
      pulse: (x, y) => {
        const ring = document.createElement('div');
        ring.dataset.shotsPulse = '';
        ring.setAttribute('aria-hidden', 'true');
        ring.style.left = `${x}px`;
        ring.style.top = `${y}px`;
        document.body.append(ring);
        setTimeout(() => ring.remove(), 500);
      },
    };
    (window as ShotsWindow).__shots = api;

    // Where the last press landed, whichever way it was made: the storyboard
    // marks it on the frame the press produced.
    document.addEventListener(
      'pointerdown',
      (event) => {
        pressed = {
          point: { x: event.clientX, y: event.clientY },
          on: event.target instanceof Element ? event.target : null,
        };
      },
      true,
    );

    // The real pointer leads; the drawn cursor follows, so they cannot disagree.
    document.addEventListener(
      'mousemove',
      (event) => api.moveCursor(event.clientX, event.clientY),
      true,
    );
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
}

export async function setAnnotation(
  page: Page,
  text: string | null,
): Promise<void> {
  await page.evaluate((value) => {
    (window as ShotsWindow).__shots?.setAnnotation(value);
  }, text);
}

/**
 * Where the page was last pressed since this was last asked, if it was and
 * what was pressed is still there. A press that loaded a new document took its
 * record with it, and one that only changed the route is dropped when the
 * element it landed on has gone: either way there is nothing left to mark.
 */
export async function takePress(page: Page): Promise<Point | null> {
  return page.evaluate(
    () => (window as ShotsWindow).__shots?.takePress() ?? null,
  );
}

export async function pulse(page: Page, point: Point): Promise<void> {
  await page.evaluate(({ x, y }) => {
    (window as ShotsWindow).__shots?.pulse(x, y);
  }, point);
}

/**
 * Hold the overlays still and stop the caret blinking, so neither shows up as
 * pixel churn. They stay visible, so the video does not blink.
 */
export async function freezeOverlays(
  page: Page,
  frozen: boolean,
): Promise<void> {
  await page.evaluate((on) => {
    if (on) (window as ShotsWindow).__shots?.clearPulses();
    document.documentElement.classList.toggle('shots-freeze', on);
  }, frozen);
}

export async function hideOverlays(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(
    (on) =>
      document.documentElement.classList.toggle('shots-hide-overlays', on),
    hidden,
  );
}
