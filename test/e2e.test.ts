/**
 * Runs the built CLI against the fixture site, the way a project would: a
 * TypeScript config and flows, loaded by Node, importing the package by name.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CheckResult,
  ExportResult,
  FlowSummary,
  RunResult,
} from '../src/index.js';

const fixture = path.join(import.meta.dirname, 'fixture');
const cli = path.join(import.meta.dirname, '..', 'dist', 'cli.js');

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

function shotsWith(input: string | undefined, ...args: string[]): Outcome {
  const { status, stdout, stderr } = spawnSync('node', [cli, ...args], {
    cwd: fixture,
    encoding: 'utf8',
    input,
  });
  return { status, stdout, stderr };
}

const shots = (...args: string[]): Outcome => shotsWith(undefined, ...args);

const relative = (file: string): string =>
  path.relative(path.join(fixture, '.shotta'), file);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  rmSync(path.join(fixture, '.shotta'), { recursive: true, force: true });
  rmSync(path.join(fixture, '.shotta-idle'), { recursive: true, force: true });
  rmSync(path.join(fixture, '.shotta-url'), { recursive: true, force: true });
  rmSync(path.join(fixture, '.shotta-exported'), {
    recursive: true,
    force: true,
  });
});

// Runs leave the app up for each other; the suite must not leave it behind.
afterAll(() => {
  shots('stop');
  shots('stop', '--config', 'idle.config.ts');
});

describe('shotta list', () => {
  it('is a catalog: each flow, what it shows, where it goes, what it shoots', () => {
    const { status, stdout } = shots('list', '--json');
    const flows: FlowSummary[] = JSON.parse(stdout);

    expect(status).toBe(0);
    expect(flows.map((flow) => flow.name)).toEqual([
      'crashed',
      'journey',
      'missing-target',
      'shell',
      'still',
    ]);
    // A flow runs at the run's profiles unless it lists its own.
    expect(flows.map((flow) => flow.profiles.join(' '))).toEqual([
      'desktop phone',
      'desktop phone',
      'desktop phone',
      'desktop',
      'desktop phone',
    ]);
    expect(flows[1]).toMatchObject({
      shows: 'The home page, its details panel, and the way through to About',
      routes: ['/'],
      chapters: ['Fill in the form', 'Read the small print'],
      shots: [
        { name: 'home', shows: 'The list has loaded: Alpha, Beta, Gamma' },
        { name: 'details', shows: null },
        { name: 'about', shows: null },
      ],
    });
  });

  it('narrows to the flows that go to a route', () => {
    const { stdout } = shots('list', '--route', '/about', '--json');
    const flows: FlowSummary[] = JSON.parse(stdout);

    expect(flows.map((flow) => flow.name)).toEqual(['still']);
  });

  it('narrows to the flows nearest a source file', () => {
    const { stdout } = shots('list', '--near', 'shots/helpers/x.ts', '--json');
    const flows: FlowSummary[] = JSON.parse(stdout);

    expect(flows).toHaveLength(5);
    expect(shots('list', '--near', 'site/index.html').status).toBe(2);
  });
});

describe('shotta check', () => {
  it('passes a project with nothing wrong, without a browser or the app', () => {
    const { status, stdout } = shots('check', '--json');
    const result: CheckResult = JSON.parse(stdout);

    expect(status).toBe(0);
    expect(result).toMatchObject({ ok: true, flows: 5, exports: 3 });
    expect(result.problems).toEqual([]);
    expect(shots('check').stdout).toMatch(/^✓ 5 flows, \d+ shots, 3 exports$/m);
  });

  it('finds every mistake at once: steps, profiles and exports', () => {
    const { status, stdout } = shots(
      'check',
      '--config',
      'broken.config.ts',
      '--json',
    );
    const result: CheckResult = JSON.parse(stdout);

    expect(status).toBe(1);
    expect(result).toMatchObject({ ok: false, flows: 1, shots: 1 });
    expect(
      result.problems.map(
        ({ file, message }) =>
          `${file === null ? 'config' : path.basename(file)}: ${message}`,
      ),
    ).toEqual([
      'elsewhere.shots.mjs: elsewhere: unknown profile: watch (have: desktop)',
      expect.stringMatching(
        /^typo\.shots\.mjs: steps\[1\]: not a step: \{"clik":"#save"\}/,
      ),
      'config: exports.docs: fine has no shot called away (have: home)',
    ]);
  });
});

describe('shotta', () => {
  it('shoots a journey at every profile, with a storyboard and a video', () => {
    const { status, stdout, stderr } = shots('journey', '--json');
    const result: RunResult = JSON.parse(stdout);

    expect(stderr).not.toContain('never went quiet');
    expect(status).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.passes.map((pass) => pass.profile)).toEqual([
      'desktop',
      'phone',
    ]);
    for (const pass of result.passes) {
      const dir = `review/journey/${pass.profile}`;
      expect(pass.failure).toBeNull();
      // The site keeps an event stream open, and asks for more as it is left.
      expect(pass.unsettled).toEqual([]);
      expect(pass.shots.map((shot) => relative(shot.file))).toEqual([
        `${dir}/01-home.png`,
        `${dir}/fill-in-the-form/02-details.png`,
        `${dir}/read-the-small-print/03-about.png`,
      ]);
      expect(pass.shots[0]?.shows).toBe(
        'The list has loaded: Alpha, Beta, Gamma',
      );
      for (const shot of pass.shots) expect(existsSync(shot.file)).toBe(true);
      expect(relative(pass.video ?? '')).toBe(`${dir}/journey.webm`);
      expect(existsSync(pass.video ?? '')).toBe(true);
      expect(pass.storyboard.map(relative)).toEqual([`${dir}/storyboard.png`]);
      expect(existsSync(pass.storyboard[0] ?? '')).toBe(true);
    }
    // The same report is left on disk, one file per run.
    expect(relative(result.report)).toMatch(/^review\/runs\/.+\.json$/);
    expect(JSON.parse(readFileSync(result.report, 'utf8'))).toEqual(result);
  });

  it('records no video for a flow that only loads a route and shoots it', () => {
    const { status, stdout } = shots('still@desktop', '--json');
    const result: RunResult = JSON.parse(stdout);

    expect(status).toBe(0);
    expect(result.passes).toHaveLength(1);
    expect(
      result.passes[0]?.shots.map((shot) => `${shot.name} ${shot.area}`),
    ).toEqual(['about page', 'heading element', 'fold viewport']);
    expect(result.passes[0]?.video).toBeNull();
    expect(result.passes[0]?.storyboard).toEqual([]);
  });

  it('shoots all of a page that scrolls inside a fixed shell, then puts it back', () => {
    const { status, stdout } = shots('shell', '--json');
    const result: RunResult = JSON.parse(stdout);
    const size = (file: string | undefined): string => {
      const { width, height } = PNG.sync.read(readFileSync(file ?? ''));
      return `${width}x${height}`;
    };

    // The flow's step fails if the viewport or the scroll were not restored.
    expect(result.passes[0]?.failure).toBeNull();
    expect(status).toBe(0);
    // At its own profiles, not the run's.
    expect(result.passes.map((pass) => pass.profile)).toEqual(['desktop']);
    // Thirty rows of 60px and 64px of the padding under them, in a viewport
    // of 600. The padding is 40% of the viewport, so it never all fits; and
    // the log beside the rows scrolls further still, but has a height of its
    // own and is left as it is.
    expect(size(result.passes[0]?.shots[0]?.file)).toBe('800x1864');
    // One element the panel shows only part of, shot whole the same way; and
    // one row with 10px of the page around it, not cut out at its edge.
    expect(size(result.passes[0]?.shots[1]?.file)).toBe('600x1800');
    expect(size(result.passes[0]?.shots[2]?.file)).toBe('620x80');
    expect(size(result.passes[0]?.shots[3]?.file)).toBe('800x600');
    expect(existsSync(result.passes[0]?.video ?? '')).toBe(true);
  });

  it('exits 2 when no flow asked for runs at the profiles asked for', () => {
    const { status, stderr } = shots('shell', '--profiles', 'phone');

    expect(status).toBe(2);
    expect(stderr).toContain('nothing to run at phone: shell runs at desktop');
    // Asked for by name, the profile is the caller's business.
    expect(shots('shell/whole@phone', '--no-video').status).toBe(0);
  });

  it('runs a flow only as far as the shot asked for', () => {
    const { status, stdout } = shots(
      'journey/home@desktop',
      '--no-video',
      '--json',
    );
    const result: RunResult = JSON.parse(stdout);

    expect(status).toBe(0);
    expect(result.passes).toHaveLength(1);
    expect(result.passes[0]?.shots.map((shot) => shot.name)).toEqual(['home']);
  });

  it('reports the step that failed, with a screenshot, and exits 1', () => {
    const { status, stdout, stderr } = shots(
      'missing-target@desktop',
      '--no-video',
      '--json',
    );
    const result: RunResult = JSON.parse(stdout);
    const pass = result.passes[0];

    expect(status).toBe(1);
    expect(result.ok).toBe(false);
    expect(pass?.shots.map((shot) => shot.name)).toEqual(['before']);
    expect(pass?.failure).toMatchObject({
      step: 3,
      action: 'click #nope',
      chapter: 'Press a button that is not there',
    });
    expect(existsSync(pass?.failure?.screenshot ?? '')).toBe(true);
    // The page as a selector sees it, so the flow can be fixed without the image.
    const aria = readFileSync(pass?.failure?.aria ?? '', 'utf8');
    expect(aria).toContain('- heading "Fixture"');
    expect(aria).toContain('- button "Show details"');
    // Only the app: not the caption shots draws over it.
    expect(aria).not.toContain('Press a button that is not there');
    expect(pass?.failure?.message).toBe(
      "locator.click: Timeout 1500ms exceeded.\nCall log:\n  - waiting for locator('#nope').first()",
    );
    expect(stderr).toContain('missing-target (step 3: click #nope)');
  });

  it('fails a flow that lands on a failWhen condition, with the console errors', () => {
    const { status, stdout } = shots('crashed@desktop', '--json');
    const result: RunResult = JSON.parse(stdout);
    const pass = result.passes[0];

    expect(status).toBe(1);
    expect(pass?.failure?.message).toBe('the app error page rendered');
    expect(pass?.failure?.url).toMatch(/\/crashed\.html$/);
    expect(pass?.consoleErrors).toContain('render failed: items is undefined');
    expect(pass?.shots).toEqual([]);
  });

  it('exits 2 when a target matches nothing, before starting anything', () => {
    const { status, stderr } = shots('no-such-flow');

    expect(status).toBe(2);
    expect(stderr).toContain('no flow matches: no-such-flow');
  });

  it('exits 2 on a shot the flow does not take, naming the ones it does', () => {
    const { status, stderr } = shots('journey/checkout');

    expect(status).toBe(2);
    expect(stderr).toContain(
      'journey has no shot called checkout (have: home, details, about)',
    );
  });
});

describe('shotta --agent', () => {
  it('prints only the report: 1x shots in tiles, kept apart from review output', () => {
    const { status, stdout, stderr } = shots('journey@desktop', '--agent');
    const result: RunResult = JSON.parse(stdout);
    const pass = result.passes[0];
    const dir = 'agent/journey/desktop';

    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(pass?.video).toBeNull();
    expect(pass?.storyboard.map(relative)).toEqual([`${dir}/storyboard.png`]);
    // The home page is taller than a tile; the about page is not.
    expect(pass?.shots.map((shot) => shot.tiles.map(relative))).toEqual([
      [`${dir}/01-home.1.png`, `${dir}/01-home.2.png`],
      [
        `${dir}/fill-in-the-form/02-details.1.png`,
        `${dir}/fill-in-the-form/02-details.2.png`,
      ],
      [`${dir}/read-the-small-print/03-about.png`],
    ]);
    for (const shot of pass?.shots ?? []) {
      for (const tile of shot.tiles) expect(existsSync(tile)).toBe(true);
    }
    // What the earlier, full-size run wrote for a person is still there.
    expect(
      existsSync(
        path.join(fixture, '.shotta/review/journey/phone/journey.webm'),
      ),
    ).toBe(true);
  });

  it('runs several targets side by side and reports them in a stable order', () => {
    const { status, stdout } = shots(
      'still',
      'journey/details@phone',
      'crashed@desktop',
      'journey/home@desktop',
      '--agent',
      '--workers',
      '4',
    );
    const result: RunResult = JSON.parse(stdout);

    expect(status).toBe(1);
    expect(
      result.passes.map(
        (pass) =>
          `${pass.flow}@${pass.profile} ${pass.shots.length} ${pass.ok}`,
      ),
    ).toEqual([
      'crashed@desktop 0 false',
      'journey@desktop 1 true',
      'journey@phone 2 true',
      'still@desktop 3 true',
      'still@phone 3 true',
    ]);
  });
});

describe('shotta snap', () => {
  it('shoots routes without a flow file, naming each shot for its route', () => {
    const { status, stdout } = shots(
      'snap',
      '/',
      '/about.html',
      '--profiles',
      'desktop',
      '--json',
    );
    const result: RunResult = JSON.parse(stdout);
    const pass = result.passes[0];

    expect(status).toBe(0);
    expect(pass?.flow).toBe('snap');
    expect(pass?.video).toBeNull();
    expect(pass?.shots.map((shot) => relative(shot.file))).toEqual([
      'review/snap/desktop/01-index.png',
      'review/snap/desktop/02-about-html.png',
    ]);
  });

  it('shoots one element on a route, with the page around it, given --of', () => {
    const { status, stdout } = shots(
      'snap',
      '/shell.html',
      '--of',
      '#row-3',
      '--pad',
      '8',
      '--name',
      'component',
      '--profiles',
      'desktop',
      '--agent',
    );
    const shot = (JSON.parse(stdout) as RunResult).passes[0]?.shots[0];
    const { width, height } = PNG.sync.read(readFileSync(shot?.file ?? ''));

    expect(status).toBe(0);
    expect(shot?.area).toBe('element');
    // A row is 600 by 60.
    expect(`${width}x${height}`).toBe('616x76');
    // Padding is the page around something: it needs the something.
    expect(shots('snap', '/shell.html', '--pad', '8').status).toBe(2);
  });

  it('runs steps given as JSON on stdin, project steps included', () => {
    const steps = [
      { goto: '/' },
      { theme: 'dark' },
      { annotate: 'Open the details', steps: [{ click: '#toggle' }] },
      { wait: '#details.open' },
      { shot: 'open', shows: 'The details paragraph is visible' },
    ];
    const { status, stdout } = shotsWith(
      JSON.stringify(steps),
      'snap',
      '--steps',
      '-',
      '--name',
      'details',
      '--profiles',
      'phone',
      '--json',
    );
    const result: RunResult = JSON.parse(stdout);

    expect(status).toBe(0);
    expect(result.passes[0]?.shots.map((shot) => relative(shot.file))).toEqual([
      'review/details/phone/01-open.png',
    ]);
  });

  it('signs in first, and tells the page the colour scheme of its profile', () => {
    const sees = (profile: string, scheme: string): number | null =>
      shots(
        'snap',
        '--agent',
        '--name',
        `scheme-${profile}-${scheme}`,
        '--profiles',
        profile,
        '--steps',
        JSON.stringify([
          { goto: '/' },
          { wait: 'html[data-user=ada]' },
          { wait: `html[data-scheme=${scheme}]` },
        ]),
      ).status;

    expect(sees('desktop', 'light')).toBe(0);
    expect(sees('phone', 'dark')).toBe(0);
    expect(sees('phone', 'light')).toBe(1);
  });

  it('exits 2 on steps that are not steps, saying which', () => {
    const { status, stderr } = shots(
      'snap',
      '--steps',
      '[{"goto":"/"},{"clik":"#toggle"}]',
    );

    expect(status).toBe(2);
    expect(stderr).toContain('steps[1]: not a step: {"clik":"#toggle"}');
    expect(stderr).toContain('theme');
  });
});

describe('the app server', () => {
  const origin = (result: RunResult): string =>
    new URL(result.passes[0]?.failure?.url ?? '').origin;
  const crashed = (...args: string[]): RunResult =>
    JSON.parse(shots('crashed@desktop', '--json', ...args).stdout);

  it('is left up by one run and used by the next, until stopped', () => {
    const first = crashed();
    const second = crashed();
    expect(origin(second)).toBe(origin(first));

    expect(shots('stop').stdout).toContain('stopped the app');
    expect(shots('stop').stdout).toContain('no app was running');

    const third = crashed();
    expect(origin(third)).not.toBe(origin(first));
  });

  it('stops by itself once no run has used it for a while', async () => {
    const state = path.join(fixture, '.shotta-idle', 'server.json');
    const first = crashed('--config', 'idle.config.ts');
    expect(existsSync(state)).toBe(true);
    const keeper: number = JSON.parse(readFileSync(state, 'utf8')).keeper;

    await sleep(4000);

    expect(existsSync(state)).toBe(false);
    expect(() => process.kill(keeper, 0)).toThrow();
    // And it is no longer answering.
    await expect(fetch(origin(first))).rejects.toThrow();
  });
});

describe('shotta --base-url', () => {
  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });

  it('runs against the app it is given and manages none of its own', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const app = spawn('node', ['server.mjs'], {
      cwd: fixture,
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      for (let tries = 0; tries < 40; tries += 1) {
        if (
          await fetch(url).then(
            () => true,
            () => false,
          )
        )
          break;
        await sleep(100);
      }
      const { status, stdout, stderr } = shots(
        'crashed@desktop',
        '--base-url',
        url,
        '--out',
        '.shotta-url',
        '--json',
      );
      const result: RunResult = JSON.parse(stdout);

      expect(status).toBe(1);
      expect(new URL(result.passes[0]?.failure?.url ?? '').origin).toBe(url);
      // Nothing was started, so nothing was left up or written down.
      expect(stderr).not.toContain('starting');
      expect(existsSync(path.join(fixture, '.shotta-url/server.json'))).toBe(
        false,
      );
      // The app is the caller's: still up after the run.
      expect((await fetch(url)).ok).toBe(true);
    } finally {
      app.kill();
    }
  });

  it('exits 2 when nothing answers there, before running anything', async () => {
    const url = `http://127.0.0.1:${await freePort()}`;
    const { status, stderr } = shots('still', '--base-url', url);

    expect(status).toBe(2);
    expect(stderr).toContain(`nothing answers at ${url}`);
  });
});

describe('shotta export', () => {
  /** Width and height from a PNG's header. */
  const size = (file: string): { width: number; height: number } => {
    const header = readFileSync(file);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  };
  const exported = (file: string): string =>
    path.join(fixture, '.shotta-exported', file);

  it('writes each set of shots at its scale, under stable names', () => {
    const { status, stdout } = shots('export', '--json');
    const result: ExportResult = JSON.parse(stdout);

    expect(status).toBe(0);
    expect(result.missing).toEqual([]);
    expect(
      result.files.map((file) => [
        file.export,
        file.address,
        path.relative(fixture, file.file),
      ]),
    ).toEqual([
      [
        'docs',
        'journey/home@desktop',
        '.shotta-exported/docs/journey.home.desktop.png',
      ],
      [
        'docs',
        'still/heading@desktop',
        '.shotta-exported/docs/still.heading.desktop.png',
      ],
      [
        'docs',
        'still/heading@phone',
        '.shotta-exported/docs/still.heading.phone.png',
      ],
      ['hero', 'still/fold@phone', '.shotta-exported/hero.png'],
      ['hero', 'still/fold@desktop', '.shotta-exported/hero.jpg'],
      [
        'web',
        'still/fold@desktop',
        '.shotta-exported/web/still.fold.desktop.webp',
      ],
    ]);

    // The whole page of an 800-wide profile, at the export's 2x.
    const home = size(exported('docs/journey.home.desktop.png'));
    expect(home.width).toBe(1600);
    expect(home.height).toBeGreaterThan(1200);
    // One element, not the page around it.
    const heading = size(exported('docs/still.heading.desktop.png'));
    expect(heading.height).toBeLessThan(200);
    // What was on screen, at the phone's own density.
    expect(size(exported('hero.png'))).toEqual({ width: 1179, height: 1977 });

    // Written as what each was asked to be, by the browser that shot it.
    const starts = (file: string, at: number, bytes: string): boolean =>
      readFileSync(exported(file))
        .subarray(at, at + bytes.length)
        .toString('latin1') === bytes;
    expect(starts('hero.jpg', 0, '\xff\xd8\xff')).toBe(true);
    expect(starts('web/still.fold.desktop.webp', 0, 'RIFF')).toBe(true);
    expect(starts('web/still.fold.desktop.webp', 8, 'WEBP')).toBe(true);

    // Shot in scratch output of its own, not over anyone's review or agent files.
    expect(relative(result.runs[0]?.outDir ?? '')).toBe('export');
  });

  it('writes only the exports named', () => {
    const { status, stdout } = shots('export', 'hero', '--json');
    const result: ExportResult = JSON.parse(stdout);

    expect(status).toBe(0);
    expect([...new Set(result.files.map((file) => file.export))]).toEqual([
      'hero',
    ]);
  });

  it('exits 2 on an export that is not configured, naming those that are', () => {
    const { status, stderr } = shots('export', 'press-kit');

    expect(status).toBe(2);
    expect(stderr).toContain(
      'no export called press-kit (have: docs, hero, web)',
    );
  });
});

describe('shotta --tmp', () => {
  it('writes to a throwaway directory without losing track of the app', () => {
    const before: RunResult = JSON.parse(
      shots('crashed@desktop', '--json').stdout,
    );
    const { status, stdout } = shots('crashed@desktop', '--tmp', '--json');
    const result: RunResult = JSON.parse(stdout);
    const dir = path.dirname(result.outDir);
    try {
      expect(status).toBe(1);
      expect(realpathSync(dir).startsWith(realpathSync(tmpdir()))).toBe(true);
      expect(path.basename(dir)).toMatch(/^shotta-/);
      expect(existsSync(result.passes[0]?.failure?.screenshot ?? '')).toBe(
        true,
      );
      expect(result.passes[0]?.failure?.screenshot?.startsWith(dir)).toBe(true);
      // The same app as the run before it: none was started for this one, and
      // its bookkeeping stayed with the project.
      expect(new URL(result.passes[0]?.failure?.url ?? '').origin).toBe(
        new URL(before.passes[0]?.failure?.url ?? '').origin,
      );
      expect(existsSync(path.join(dir, 'server.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
