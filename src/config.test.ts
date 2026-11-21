import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, resolveConfig } from './config.js';

const KNOWN_DEVICES = {
  'Desktop Chrome': { hasTouch: false },
  'iPad (gen 7)': { hasTouch: true },
  'iPhone 15': { hasTouch: true },
};

describe('resolveConfig', () => {
  it('falls back to the built-in defaults when there is no config file', () => {
    const resolved = resolveConfig({
      file: null,
      cli: {},
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.outDir).toBe(DEFAULT_CONFIG.outDir);
    expect(resolved.pace).toBe(DEFAULT_CONFIG.pace);
    expect(resolved.video).toBe(true);
    expect(resolved.profiles.map((profile) => profile.name)).toEqual([
      'desktop',
    ]);
  });

  it('runs the profiles the file asks for, in that order', () => {
    const resolved = resolveConfig({
      file: {
        profiles: {
          desktop: {
            viewport: { width: 1440, height: 1000 },
            deviceScaleFactor: 2,
          },
          phone: { device: 'iPhone 15' },
        },
        run: ['desktop', 'phone'],
      },
      cli: {},
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.profiles.map((profile) => profile.name)).toEqual([
      'desktop',
      'phone',
    ]);
    expect(resolved.profiles[0]?.viewport).toEqual({
      width: 1440,
      height: 1000,
    });
    expect(resolved.profiles[0]?.deviceScaleFactor).toBe(2);
    expect(resolved.profiles[0]?.hasTouch).toBe(false);
  });

  it('takes touch from the device preset so the runner taps instead of clicking', () => {
    const resolved = resolveConfig({
      file: { profiles: { phone: { device: 'iPhone 15' } }, run: ['phone'] },
      cli: {},
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.profiles[0]?.device).toBe('iPhone 15');
    expect(resolved.profiles[0]?.hasTouch).toBe(true);
  });

  it("carries a profile's colour scheme, and refuses one that is neither", () => {
    const withScheme = (colorScheme: string) =>
      resolveConfig({
        file: {
          profiles: {
            dark: { viewport: { width: 800, height: 600 }, colorScheme },
          },
        } as never,
        cli: {},
        knownDevices: KNOWN_DEVICES,
      });

    expect(withScheme('dark').profiles[0]?.colorScheme).toBe('dark');
    expect(() => withScheme('sepia')).toThrow(
      'profile dark: colorScheme is light or dark, not sepia',
    );
  });

  it('keeps the setup a pass runs before its first step', () => {
    const setup = async (): Promise<void> => {};

    expect(
      resolveConfig({ file: { setup }, cli: {}, knownDevices: KNOWN_DEVICES })
        .setup,
    ).toBe(setup);
    expect(
      resolveConfig({ file: {}, cli: {}, knownDevices: KNOWN_DEVICES }).setup,
    ).toBeNull();
    expect(() =>
      resolveConfig({
        file: { setup: 'sign in' } as never,
        cli: {},
        knownDevices: KNOWN_DEVICES,
      }),
    ).toThrow('setup must be a function');
  });

  it('leaves a desktop preset on the mouse path', () => {
    const resolved = resolveConfig({
      file: {
        profiles: { wide: { device: 'Desktop Chrome' } },
        run: ['wide'],
      },
      cli: {},
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.profiles[0]?.hasTouch).toBe(false);
  });

  it('lets the command line pick a subset of the configured profiles', () => {
    const resolved = resolveConfig({
      file: {
        profiles: {
          desktop: { viewport: { width: 1440, height: 1000 } },
          phone: { device: 'iPhone 15' },
        },
        run: ['desktop', 'phone'],
      },
      cli: { profiles: ['phone'] },
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.profiles.map((profile) => profile.name)).toEqual(['phone']);
  });

  it('lets the command line override the output directory and video', () => {
    const resolved = resolveConfig({
      file: { outDir: '.shotta', video: true },
      cli: { outDir: '/tmp/out', video: false },
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.outDir).toBe('/tmp/out');
    expect(resolved.video).toBe(false);
  });

  it('keeps the file settings when the command line says nothing', () => {
    const resolved = resolveConfig({
      file: { outDir: 'out/shots', pace: 50, video: false },
      cli: {},
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.outDir).toBe('out/shots');
    expect(resolved.pace).toBe(50);
    expect(resolved.video).toBe(false);
  });

  it('rejects a profile name that is not configured, listing the valid ones', () => {
    expect(() =>
      resolveConfig({
        file: {
          profiles: { desktop: { device: 'Desktop Chrome' } },
          run: ['desktop'],
        },
        cli: { profiles: ['watch'] },
        knownDevices: KNOWN_DEVICES,
      }),
    ).toThrow(/unknown profile: watch \(have: desktop\)/);
  });

  it('rejects a device preset Playwright does not know', () => {
    expect(() =>
      resolveConfig({
        file: { profiles: { phone: { device: 'iPhone 99' } }, run: ['phone'] },
        cli: {},
        knownDevices: KNOWN_DEVICES,
      }),
    ).toThrow(/unknown device: iPhone 99/);
  });

  it('rejects a profile that names neither a device nor a viewport', () => {
    expect(() =>
      resolveConfig({
        file: { profiles: { odd: {} }, run: ['odd'] },
        cli: {},
        knownDevices: KNOWN_DEVICES,
      }),
    ).toThrow(/profile odd needs a device or a viewport/);
  });
  it('rejects a config key it does not know, so a typo is not a silent no-op', () => {
    expect(() =>
      resolveConfig({
        file: { outdir: 'x' } as never,
        cli: {},
        knownDevices: KNOWN_DEVICES,
      }),
    ).toThrow(/unknown config key: outdir/);
  });

  it('fills in where the app answers and how long to wait for it', () => {
    const resolved = resolveConfig({
      file: { server: { command: 'serve --port {port}' } },
      cli: {},
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.server).toEqual({
      command: 'serve --port {port}',
      url: 'http://localhost:{port}',
      readyTimeout: 180_000,
      keepAlive: 600_000,
    });
  });

  it('lets a base URL from the command line win over the file', () => {
    const resolved = resolveConfig({
      file: { baseUrl: 'http://localhost:4200' },
      cli: { baseUrl: 'http://localhost:9000' },
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.baseUrl).toBe('http://localhost:9000');
  });
  it('sizes output for a model when asked: 1x, tiled, and no video', () => {
    const resolved = resolveConfig({
      file: {
        video: true,
        profiles: {
          desktop: {
            viewport: { width: 1440, height: 1000 },
            deviceScaleFactor: 2,
          },
          phone: { device: 'iPhone 15' },
        },
      },
      cli: { agent: true },
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.profiles.map((p) => p.deviceScaleFactor)).toEqual([1, 1]);
    expect(resolved.video).toBe(false);
    expect(resolved.tileHeight).toBe(1568);
  });

  it('lets an explicit scale or video win over what agent output implies', () => {
    const resolved = resolveConfig({
      file: null,
      cli: { agent: true, scale: 2, video: true },
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.profiles[0]?.deviceScaleFactor).toBe(2);
    expect(resolved.video).toBe(true);
  });

  it('applies a scale to every profile and never tiles on its own', () => {
    const resolved = resolveConfig({
      file: { profiles: { phone: { device: 'iPhone 15' } } },
      cli: { scale: 3 },
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.profiles[0]?.deviceScaleFactor).toBe(3);
    expect(resolved.tileHeight).toBeNull();
  });

  it('rejects a scale that is not a positive number', () => {
    expect(() =>
      resolveConfig({
        file: null,
        cli: { scale: Number('big') },
        knownDevices: KNOWN_DEVICES,
      }),
    ).toThrow(/scale must be a positive number/);
  });

  it('rejects a project step named after something shots already means', () => {
    expect(() =>
      resolveConfig({
        file: { steps: { click: async () => {} } } as never,
        cli: {},
        knownDevices: KNOWN_DEVICES,
      }),
    ).toThrow(/a project step cannot be called click/);
  });
  it('knows every configured profile, beyond the ones a run uses by default', () => {
    const resolved = resolveConfig({
      file: {
        profiles: {
          desktop: { viewport: { width: 1440, height: 1000 } },
          phone: { device: 'iPhone 15' },
        },
        run: ['desktop'],
      },
      cli: {},
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.profiles.map((p) => p.name)).toEqual(['desktop']);
    expect(resolved.available.map((p) => p.name)).toEqual(['desktop', 'phone']);
  });

  it('keeps agent output apart from what a person will open', () => {
    const resolve = (agent: boolean) =>
      resolveConfig({
        file: null,
        cli: { agent },
        knownDevices: KNOWN_DEVICES,
      });

    expect(resolve(false).root).toBe('review');
    expect(resolve(true).root).toBe('agent');
  });

  it('runs on half the cores, at most four at once, unless told', () => {
    const workers = (cores: number, cli = {}) =>
      resolveConfig({ file: null, cli, knownDevices: KNOWN_DEVICES, cores })
        .workers;

    expect(workers(1)).toBe(1);
    expect(workers(8)).toBe(4);
    expect(workers(16)).toBe(4);
    expect(workers(8, { workers: 1 })).toBe(1);
    expect(() => workers(8, { workers: 0 })).toThrow(/workers must be/);
  });

  it('leaves the app up for ten minutes unless the project says otherwise', () => {
    const keepAlive = (server: { command: string; keepAlive?: number }) =>
      resolveConfig({ file: { server }, cli: {}, knownDevices: KNOWN_DEVICES })
        .server?.keepAlive;

    expect(keepAlive({ command: 'serve' })).toBe(600_000);
    expect(keepAlive({ command: 'serve', keepAlive: 0 })).toBe(0);
  });
  it('reads an export as a list of addresses or as file name → address', () => {
    const resolved = resolveConfig({
      file: {
        exports: {
          docs: { dir: 'docs/img', scale: 2, shots: ['cart/full@desktop'] },
          hero: { dir: 'site', shots: { 'hero.png': 'cart/full@phone' } },
        },
      },
      cli: {},
      knownDevices: KNOWN_DEVICES,
    });

    expect(resolved.exports).toEqual([
      {
        name: 'docs',
        dir: 'docs/img',
        scale: 2,
        shots: [
          {
            address: 'cart/full@desktop',
            target: { flow: 'cart', shot: 'full', profile: 'desktop' },
            file: null,
          },
        ],
      },
      {
        name: 'hero',
        dir: 'site',
        scale: null,
        shots: [
          {
            address: 'cart/full@phone',
            target: { flow: 'cart', shot: 'full', profile: 'phone' },
            file: 'hero.png',
          },
        ],
      },
    ]);
  });

  it('rejects an export it could not write', () => {
    const withExport = (entry: object) => () =>
      resolveConfig({
        file: { exports: { docs: entry } } as never,
        cli: {},
        knownDevices: KNOWN_DEVICES,
      });

    expect(withExport({ shots: ['cart/full'] })).toThrow(
      'exports.docs needs a dir to write to',
    );
    expect(withExport({ dir: 'out', shots: ['cart'] })).toThrow(
      'exports.docs: cart names a flow; an export needs flow/shot',
    );
    expect(withExport({ dir: 'out', shots: [] })).toThrow(
      'exports.docs has no shots',
    );
    expect(
      withExport({ dir: 'out', shots: { 'img/hero.png': 'cart/full' } }),
    ).toThrow('exports.docs: img/hero.png must be a .png file name');
    expect(withExport({ dir: 'out', scale: 0, shots: ['cart/full'] })).toThrow(
      'exports.docs.scale must be a positive number',
    );
  });
});
