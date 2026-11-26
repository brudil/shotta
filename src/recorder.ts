/**
 * Recording a journey: frames from the page, encoded as they arrive.
 *
 * Playwright can record a page to a file by itself, but only all of it. Taking
 * the frames instead means the recording starts when the app is ready rather
 * than at a blank page, and can be paused while a screenshot is taken — the
 * overlays are hidden for that, and would otherwise blink in the video.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Page } from 'playwright';

const FPS = 25;
/** JPEG quality of the frames the browser hands over. */
const FRAME_QUALITY = 90;
/** How long the last frame is held, so a video does not end on a cut. */
const HOLD_MS = 600;

/** Where `playwright install` puts the browsers, and the ffmpeg beside them. */
function browsersDir(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override) return override;
  const home = homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'ms-playwright');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'ms-playwright');
  }
  return path.join(home, '.cache', 'ms-playwright');
}

/**
 * The ffmpeg revisions the project's own Playwright installs, the one it uses
 * first: the browsers directory is shared by every Playwright on the machine,
 * and another project's may have put a newer ffmpeg beside it. Empty when
 * that cannot be read, which leaves the choice to what is installed.
 */
async function wantedRevisions(): Promise<string[]> {
  try {
    // The Playwright the run drives, the project's own: it is a peer dependency.
    const playwright = createRequire(import.meta.url).resolve('playwright');
    const core = createRequire(playwright).resolve(
      'playwright-core/package.json',
    );
    const { browsers } = JSON.parse(
      await readFile(path.join(path.dirname(core), 'browsers.json'), 'utf8'),
    ) as {
      browsers: {
        name: string;
        revision: string;
        revisionOverrides?: Record<string, string>;
      }[];
    };
    const ffmpeg = browsers.find((browser) => browser.name === 'ffmpeg');
    if (ffmpeg === undefined) return [];
    // An override is for an older OS, where only that revision is installed.
    return [ffmpeg.revision, ...Object.values(ffmpeg.revisionOverrides ?? {})];
  } catch {
    return [];
  }
}

/**
 * The installed `ffmpeg-<revision>` directories to try, best first: the
 * revisions the project's Playwright asks for, in its order, then the rest,
 * newest first.
 */
export function ffmpegCandidates(
  installed: string[],
  wanted: string[],
): string[] {
  const revisions = installed
    .filter((entry) => /^ffmpeg-\d+$/.test(entry))
    .map((entry) => entry.slice('ffmpeg-'.length))
    .sort((a, b) => Number(b) - Number(a));
  return [
    ...wanted.filter((revision) => revisions.includes(revision)),
    ...revisions.filter((revision) => !wanted.includes(revision)),
  ].map((revision) => `ffmpeg-${revision}`);
}

/**
 * Playwright installs an ffmpeg with its browsers, so recording needs no new
 * dependency. Falls back to one on PATH.
 */
async function findFfmpeg(): Promise<string> {
  const name =
    process.platform === 'darwin'
      ? 'ffmpeg-mac'
      : process.platform === 'win32'
        ? 'ffmpeg-win64.exe'
        : 'ffmpeg-linux';
  const installed = await readdir(browsersDir()).catch(() => [] as string[]);
  for (const dir of ffmpegCandidates(installed, await wantedRevisions())) {
    const candidate = path.join(browsersDir(), dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Half installed; try the next.
    }
  }
  try {
    await promisify(execFile)('ffmpeg', ['-version']);
    return 'ffmpeg';
  } catch {
    throw new Error(
      'no ffmpeg to record with: run `playwright install ffmpeg`, or pass --no-video',
    );
  }
}

export type Codec = 'vp9' | 'vp8';

/**
 * Which WebM codec an ffmpeg can write, from its `-encoders` listing: VP9 where
 * it has it, VP8 otherwise. Playwright's own builds carry one or the other.
 */
export function codecFrom(encoders: string): Codec | null {
  const has = (name: string): boolean =>
    new RegExp(`^\\s*V\\S*\\s+${name}\\s`, 'm').test(encoders);
  if (has('libvpx-vp9')) return 'vp9';
  if (has('libvpx')) return 'vp8';
  return null;
}

/** The encoder's arguments for each codec, as tuned against real recordings. */
const ENCODE: Record<Codec, string> = {
  // VP9 at the realtime deadline keeps up with the frames as they arrive, eight
  // times over at 1440x1000, in a third of VP8's file and 3dB better.
  vp9: '-c:v libvpx-vp9 -crf 10 -b:v 2M -deadline realtime -cpu-used 6 -lag-in-frames 0 -row-mt 1 -threads 4',
  // VP8 needs an explicit bitrate ceiling to honour crf: with `-b:v 0` libvpx
  // picks its own target and spends the bits at a coarse quantizer, which
  // costs ~11dB of PSNR against these settings at the same file size.
  vp8: '-c:v libvpx -crf 10 -b:v 2M -cpu-used 2 -threads 4',
};

/** The ffmpeg to record with and the codec it writes, found once per process. */
let encoder: Promise<{ ffmpeg: string; codec: Codec }> | null = null;

function findEncoder(): Promise<{ ffmpeg: string; codec: Codec }> {
  encoder ??= (async () => {
    const ffmpeg = await findFfmpeg();
    const { stdout } = await promisify(execFile)(ffmpeg, [
      '-hide_banner',
      '-encoders',
    ]);
    const codec = codecFrom(stdout);
    if (codec === null) {
      throw new Error(
        `${ffmpeg} can write neither VP9 nor VP8: run \`playwright install ffmpeg\`, or pass --no-video`,
      );
    }
    return { ffmpeg, codec };
  })();
  // A failure is reported by the pass that met it; the next may try again.
  encoder.catch(() => {
    encoder = null;
  });
  return encoder;
}

/**
 * Where each frame belongs in a video from which the paused stretches have
 * been cut out. Times are epoch ms, as the browser stamps its frames.
 */
export class Timeline {
  #first: number | null = null;
  #pausedFrom: number | null = null;
  #cuts: { from: number; to: number }[] = [];

  pause(now: number): void {
    this.#pausedFrom ??= now;
  }

  resume(now: number): void {
    if (this.#pausedFrom === null) return;
    this.#cuts.push({ from: this.#pausedFrom, to: now });
    this.#pausedFrom = null;
  }

  /**
   * The frame number a frame stamped `timestamp` lands on, or null if it was
   * drawn during a pause. A frame can arrive after the pause it was drawn in
   * has ended, so this goes by when it was drawn, not when it is asked.
   */
  place(timestamp: number): number | null {
    if (this.#pausedFrom !== null && timestamp >= this.#pausedFrom) return null;
    let cut = 0;
    for (const { from, to } of this.#cuts) {
      if (timestamp >= from && timestamp <= to) return null;
      if (timestamp > to) cut += to - from;
    }
    const at = timestamp - cut;
    this.#first ??= at;
    return Math.max(0, Math.floor(((at - this.#first) / 1000) * FPS));
  }
}

export class Recorder {
  readonly file: string;
  #page: Page;
  #ffmpeg: ChildProcess;
  #exited: Promise<number | null>;
  #errors = '';
  #timeline = new Timeline();
  #last: { data: Buffer; number: number } | null = null;
  #writes: Promise<void> = Promise.resolve();

  private constructor(page: Page, file: string, ffmpeg: ChildProcess) {
    this.#page = page;
    this.file = file;
    this.#ffmpeg = ffmpeg;
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      this.#errors += chunk.toString();
    });
    // A dead encoder shows up as its exit code; the pipe breaking under a
    // write must not take the run down with it.
    ffmpeg.stdin?.on('error', () => {});
    this.#exited = new Promise((resolve) => ffmpeg.on('exit', resolve));
  }

  /** Start recording the page as it is now, to a `.webm` file. */
  static async start(
    page: Page,
    file: string,
    size: { width: number; height: number },
  ): Promise<Recorder> {
    const { width, height } = size;
    const { ffmpeg: binary, codec } = await findEncoder();
    const ffmpeg = spawn(
      binary,
      [
        ...'-loglevel error -f image2pipe -avioflags direct -fpsprobesize 0'.split(
          ' ',
        ),
        ...'-probesize 32 -analyzeduration 0 -c:v mjpeg -i pipe:0 -y -an'.split(
          ' ',
        ),
        '-r',
        String(FPS),
        ...ENCODE[codec].split(' '),
        '-vf',
        `pad=${width}:${height}:0:0:gray,crop=${width}:${height}:0:0`,
        file,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    const recorder = new Recorder(page, file, ffmpeg);
    await page.screencast.start({
      size,
      quality: FRAME_QUALITY,
      onFrame: ({ data, timestamp }) => recorder.#frame(data, timestamp),
    });
    return recorder;
  }

  /** Leave out everything the page draws until {@link resume}. */
  pause(): void {
    this.#timeline.pause(Date.now());
  }

  resume(): void {
    this.#timeline.resume(Date.now());
  }

  /** A frame shows until the next one arrives, so it is written then. */
  #frame(data: Buffer, timestamp: number): void {
    const number = this.#timeline.place(timestamp);
    if (number === null) return;
    if (this.#last !== null)
      this.#write(this.#last.data, number - this.#last.number);
    this.#last = { data, number };
  }

  #write(data: Buffer, times: number): void {
    for (let count = 0; count < times; count += 1) {
      this.#writes = this.#writes.then(
        () =>
          new Promise<void>((resolve) => {
            this.#ffmpeg.stdin?.write(data, () => resolve());
          }),
      );
    }
  }

  /** Finish the file. Throws if the encoder failed. */
  async stop(): Promise<void> {
    await this.#page.screencast.stop().catch(() => {
      // The page may already be gone; what was recorded still stands.
    });
    if (this.#last !== null) {
      this.#write(this.#last.data, Math.ceil((HOLD_MS / 1000) * FPS));
    }
    await this.#writes;
    this.#ffmpeg.stdin?.end();
    const code = await this.#exited;
    if (code !== 0) {
      throw new Error(
        `ffmpeg could not write ${path.basename(this.file)}: ${this.#errors.trim() || `exit ${code}`}`,
      );
    }
    if (this.#last === null) throw new Error('nothing was recorded');
  }
}
