/**
 * The project's configuration and its resolution against the command line.
 *
 * `resolveConfig` is a pure function so it can be tested without a browser:
 * the caller passes in what Playwright knows about device presets.
 */
import type { Page } from 'playwright';

import { type CustomSteps, RESERVED_STEP_KEYS, type Selector } from './flow.js';
import { parseTarget, type Target } from './targets.js';

/** A viewport profile as written in the config file. */
export interface ProfileConfig {
  /** A Playwright device preset name, e.g. `iPhone 15`. */
  device?: string;
  /** Overrides the preset's viewport, or stands alone for a custom profile. */
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  /** What the page is told the system prefers, for an app with a dark theme. */
  colorScheme?: 'light' | 'dark';
}

export interface ServerConfig {
  /**
   * Shell command that starts the app. `{port}` is replaced with a free port,
   * which is also exported to the command as `PORT`.
   */
  command: string;
  /** Where the app answers once it is up. Default `http://localhost:{port}`. */
  url?: string;
  /** How long to wait for it to answer, in ms. Default 180000. */
  readyTimeout?: number;
  /**
   * How long the app stays up after a run last used it, in ms, so the next
   * run — or one alongside — skips the startup. Default 600000. Set 0 for an
   * app that does not pick up source changes by itself: it is then started and
   * stopped with every run.
   */
  keepAlive?: number;
}

/** A condition that fails a flow wherever it appears, e.g. an error boundary. */
export interface FailWhen {
  selector: Selector;
  /** What to report. Say what to check, not just what was seen. */
  message?: string;
}

/**
 * What each of the project's own steps does: one handler per member of
 * {@link CustomSteps}, given the page and the value the step was written with.
 */
export type StepHandlers = {
  [K in keyof CustomSteps]: (
    page: Page,
    value: CustomSteps[K],
  ) => Promise<void>;
};

/**
 * What a pass does before its flow's first step, in the fresh browser context
 * every pass gets: signing in, say.
 */
export type Setup = (
  page: Page,
  pass: {
    /** Where the app is, without a trailing slash. */
    baseUrl: string;
    /** The name of the profile this pass runs at. */
    profile: string;
  },
) => Promise<void>;

/** The handlers as the runner sees them, once the step names are only strings. */
export type AnyStepHandlers = Record<
  string,
  (page: Page, value: unknown) => Promise<void>
>;

/**
 * A set of shots written out under stable names, for use outside the project's
 * scratch output: a docs site, a marketing page, a README.
 */
export interface ExportConfig {
  /** The directory the files are written to. */
  dir: string;
  /** Device scale factor to shoot at. Default: each profile's own. */
  scale?: number;
  /**
   * The shots, each `flow/shot` or `flow/shot@profile`. As a list, files are
   * named `<flow>.<shot>.<profile>.png`. As a map of file name → address, each
   * address must come to one profile.
   */
  shots: string[] | Record<string, string>;
}

export interface ResolvedExport {
  name: string;
  dir: string;
  scale: number | null;
  shots: { address: string; target: Target; file: string | null }[];
}

export interface ShotsConfig {
  /**
   * Directory searched, recursively, for `*.shots.ts` flows. Default `.`, the
   * whole project, so a flow can sit beside the code it shows.
   */
  flows?: string;
  /** Where shots and videos are written. Default `.shotta`. */
  outDir?: string;
  /** Pause between steps in ms. Default 200. */
  pace?: number;
  /** Record journey videos. Default true. */
  video?: boolean;
  /** Write a storyboard — a contact sheet of the journey's steps. Default true. */
  storyboard?: boolean;
  /** How long one step may take to find and act on its target, in ms. Default 30000. */
  actionTimeout?: number;
  /**
   * How many passes run at once when none is being recorded. Default: half the
   * machine's cores, at most 4. Set 1 if passes share state outside the browser.
   */
  workers?: number;
  profiles?: Record<string, ProfileConfig>;
  /** Profiles to run, in order. Default: every profile, in the order written. */
  run?: string[];
  /** An app that is already running. Wins over `server`. */
  baseUrl?: string;
  /** How to start the app when no `baseUrl` is given. */
  server?: ServerConfig;
  /** Set before the app boots, on every page — e.g. a flag that turns mocking on. */
  localStorage?: Record<string, string>;
  /** CSS selectors hidden in every shot and video, e.g. dev-only overlays. */
  hide?: string[];
  /**
   * Requests that never go quiet (pollers, telemetry), so settling ignores
   * them. A string matches anywhere in the URL.
   */
  ignoreRequests?: (string | RegExp)[];
  /** Checked after every step. */
  failWhen?: FailWhen[];
  /**
   * Steps of the project's own, usable in any flow as `{ <name>: <value> }`.
   * They are functions, so they need a `.ts` or `.js` config.
   */
  steps?: StepHandlers;
  /**
   * Run once per pass, before its first step and before any recording starts.
   * Every pass begins in a browser with no cookies and no storage, so an app
   * behind a sign-in is signed in to here — which is also what lets `shotta
   * snap` shoot its routes. A function, so it needs a `.ts` or `.js` config.
   */
  setup?: Setup;
  /** Named sets of shots for `shotta export`. */
  exports?: Record<string, ExportConfig>;
}

/** Overrides from the command line. Any key left out defers to the file. */
export interface ConfigOverrides {
  profiles?: string[];
  outDir?: string;
  video?: boolean;
  pace?: number;
  baseUrl?: string;
  workers?: number;
  /** Device scale factor for every profile, whatever each one configures. */
  scale?: number;
  /**
   * Output sized for a model to read rather than a person: 1x density, tall
   * pages cut into tiles, and no video. An explicit `scale` or `video` wins.
   */
  agent?: boolean;
}

/**
 * The device presets available to a profile. Touch comes from the preset
 * itself rather than its name, so the caller passes what Playwright reports.
 */
export type KnownDevices = Record<string, { hasTouch: boolean }>;

export interface ResolvedProfile {
  name: string;
  device: string | null;
  viewport: { width: number; height: number } | null;
  deviceScaleFactor: number | null;
  colorScheme: 'light' | 'dark' | null;
  /** True for device presets that emulate touch, which tap rather than click. */
  hasTouch: boolean;
}

export interface ResolvedConfig {
  flows: string;
  outDir: string;
  /**
   * Where shotta keeps track of the app it is keeping up. Always the project's
   * own output directory: sending one run's output elsewhere must not make it
   * lose sight of the app, and start another.
   */
  stateDir: string;
  pace: number;
  video: boolean;
  storyboard: boolean;
  actionTimeout: number;
  workers: number;
  /** The profiles a run uses unless a flow or a target names others. */
  profiles: ResolvedProfile[];
  /**
   * True when the command line chose `profiles`. A flow with profiles of its
   * own then runs only at those of them that were chosen.
   */
  profilesChosen: boolean;
  /** Every configured profile, in the order written. */
  available: ResolvedProfile[];
  /**
   * The directory under `outDir` this run writes to. Agent output is kept
   * apart, so looking at a screen never overwrites what a person will open.
   */
  root: 'review' | 'agent' | 'export';
  baseUrl: string | null;
  server: Required<ServerConfig> | null;
  localStorage: Record<string, string>;
  hide: string[];
  ignoreRequests: (string | RegExp)[];
  failWhen: FailWhen[];
  steps: AnyStepHandlers;
  setup: Setup | null;
  exports: ResolvedExport[];
  /** Shots taller than this many image pixels are also cut into tiles; null for never. */
  tileHeight: number | null;
}

/**
 * The long edge a vision model reads at full detail. A taller image is scaled
 * down to fit, which turns a full-page shot's text to mush.
 */
export const AGENT_TILE_HEIGHT = 1568;

const DESKTOP: ProfileConfig = {
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 2,
};

/** Used for anything the config file leaves out, so the tool works without one. */
export const DEFAULT_CONFIG = {
  flows: '.',
  outDir: '.shotta',
  pace: 200,
  video: true,
  storyboard: true,
  actionTimeout: 30_000,
  profiles: { desktop: DESKTOP } as Record<string, ProfileConfig>,
  server: {
    url: 'http://localhost:{port}',
    readyTimeout: 180_000,
    keepAlive: 600_000,
  },
};

const KNOWN_KEYS: Record<keyof ShotsConfig, true> = {
  flows: true,
  outDir: true,
  pace: true,
  video: true,
  storyboard: true,
  actionTimeout: true,
  workers: true,
  profiles: true,
  run: true,
  baseUrl: true,
  server: true,
  localStorage: true,
  hide: true,
  ignoreRequests: true,
  failWhen: true,
  steps: true,
  setup: true,
  exports: true,
};

function resolveExport([name, config]: [string, ExportConfig]): ResolvedExport {
  const at = `exports.${name}`;
  if (typeof config.dir !== 'string' || config.dir === '') {
    throw new Error(`${at} needs a dir to write to`);
  }
  if (config.scale !== undefined && !(config.scale > 0)) {
    throw new Error(`${at}.scale must be a positive number`);
  }
  if (typeof config.shots !== 'object' || config.shots === null) {
    throw new Error(
      `${at} needs shots: a list of addresses, or file name → address`,
    );
  }
  const entries: [string | null, string][] = Array.isArray(config.shots)
    ? config.shots.map((address) => [null, address])
    : Object.entries(config.shots);
  if (entries.length === 0) throw new Error(`${at} has no shots`);
  return {
    name,
    dir: config.dir,
    scale: config.scale ?? null,
    shots: entries.map(([file, address]) => {
      const target = parseTarget(address);
      if (target.shot === null) {
        throw new Error(
          `${at}: ${address} names a flow; an export needs flow/shot`,
        );
      }
      if (file !== null && !/^[^/\\]+\.png$/.test(file)) {
        throw new Error(`${at}: ${file} must be a .png file name`);
      }
      return { address, target, file };
    }),
  };
}

/** Type helper for `shotta.config.ts`. */
export function defineConfig(config: ShotsConfig): ShotsConfig {
  return config;
}

export function resolveConfig({
  file,
  cli,
  knownDevices,
  cores = 2,
}: {
  file: ShotsConfig | null;
  cli: ConfigOverrides;
  knownDevices: KnownDevices;
  /** How many the machine has, for the default number of workers. */
  cores?: number;
}): ResolvedConfig {
  // A typo here would otherwise be a setting that silently does nothing.
  for (const key of Object.keys(file ?? {})) {
    if (!(key in KNOWN_KEYS)) {
      throw new Error(
        `unknown config key: ${key} (have: ${Object.keys(KNOWN_KEYS).join(', ')})`,
      );
    }
  }

  const agent = cli.agent === true;
  const scale = cli.scale ?? (agent ? 1 : undefined);
  if (scale !== undefined && !(scale > 0)) {
    throw new Error(`scale must be a positive number, not ${scale}`);
  }

  const steps = (file?.steps ?? {}) as AnyStepHandlers;
  for (const [name, handler] of Object.entries(steps)) {
    if (RESERVED_STEP_KEYS.includes(name)) {
      throw new Error(
        `a project step cannot be called ${name}: shotta uses it`,
      );
    }
    if (typeof handler !== 'function') {
      throw new Error(`steps.${name} must be a function`);
    }
  }
  if (file?.setup !== undefined && typeof file.setup !== 'function') {
    throw new Error('setup must be a function');
  }

  const profiles = file?.profiles ?? DEFAULT_CONFIG.profiles;
  const names = Object.keys(profiles);
  const wanted = cli.profiles ?? file?.run ?? names;

  const available = Object.entries(profiles).map(([name, profile]) => {
    if (profile.device === undefined && profile.viewport === undefined) {
      throw new Error(`profile ${name} needs a device or a viewport`);
    }
    const preset =
      profile.device === undefined ? null : knownDevices[profile.device];
    if (profile.device !== undefined && preset === undefined) {
      throw new Error(`unknown device: ${profile.device}`);
    }
    if (
      profile.colorScheme !== undefined &&
      profile.colorScheme !== 'light' &&
      profile.colorScheme !== 'dark'
    ) {
      throw new Error(
        `profile ${name}: colorScheme is light or dark, not ${profile.colorScheme}`,
      );
    }
    return {
      name,
      device: profile.device ?? null,
      viewport: profile.viewport ?? null,
      deviceScaleFactor: scale ?? profile.deviceScaleFactor ?? null,
      colorScheme: profile.colorScheme ?? null,
      hasTouch: preset?.hasTouch ?? false,
    };
  });

  const resolved = wanted.map((name) => {
    const profile = available.find((candidate) => candidate.name === name);
    if (profile === undefined) {
      throw new Error(`unknown profile: ${name} (have: ${names.join(', ')})`);
    }
    return profile;
  });

  const workers =
    cli.workers ??
    file?.workers ??
    Math.max(1, Math.min(4, Math.floor(cores / 2)));
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(
      `workers must be a whole number of 1 or more, not ${workers}`,
    );
  }

  if (file?.server !== undefined && !file.server.command) {
    throw new Error('server needs a command');
  }

  return {
    flows: file?.flows ?? DEFAULT_CONFIG.flows,
    outDir: cli.outDir ?? file?.outDir ?? DEFAULT_CONFIG.outDir,
    stateDir: file?.outDir ?? DEFAULT_CONFIG.outDir,
    pace: cli.pace ?? file?.pace ?? DEFAULT_CONFIG.pace,
    video: cli.video ?? (agent ? false : (file?.video ?? DEFAULT_CONFIG.video)),
    storyboard: file?.storyboard ?? DEFAULT_CONFIG.storyboard,
    actionTimeout: file?.actionTimeout ?? DEFAULT_CONFIG.actionTimeout,
    workers,
    profiles: resolved,
    profilesChosen: cli.profiles !== undefined,
    available,
    root: agent ? 'agent' : 'review',
    baseUrl: cli.baseUrl ?? file?.baseUrl ?? null,
    server:
      file?.server === undefined
        ? null
        : {
            command: file.server.command,
            url: file.server.url ?? DEFAULT_CONFIG.server.url,
            readyTimeout:
              file.server.readyTimeout ?? DEFAULT_CONFIG.server.readyTimeout,
            keepAlive: file.server.keepAlive ?? DEFAULT_CONFIG.server.keepAlive,
          },
    localStorage: file?.localStorage ?? {},
    hide: file?.hide ?? [],
    ignoreRequests: file?.ignoreRequests ?? [],
    failWhen: file?.failWhen ?? [],
    steps,
    setup: file?.setup ?? null,
    exports: Object.entries(file?.exports ?? {}).map(resolveExport),
    tileHeight: agent ? AGENT_TILE_HEIGHT : null,
  };
}
