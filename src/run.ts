/** The whole run: config, flows, server, browser, every pass. */
import {
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';

import { type Browser, chromium, devices } from 'playwright';

import {
  type ConfigOverrides,
  type ResolvedConfig,
  type ResolvedExport,
  resolveConfig,
} from './config.js';
import { type EncodeJob, EXTENSION, encodeImages, formatOf } from './encode.js';
import {
  checkSteps,
  type Flow,
  type FlowOptions,
  routesOf,
  shotsOf,
  walk,
} from './flow.js';
import { findFlows, loadConfig, loadFlow } from './load.js';
import type {
  CheckResult,
  ExportedFile,
  ExportResult,
  FlowSummary,
  PassResult,
  RunResult,
} from './report.js';
import { records, runFlow } from './run-flow.js';
import {
  ensureServer,
  type RunningServer,
  reachable,
  stopServer,
} from './server.js';
import {
  matchFlows,
  nearestFlows,
  type Pass,
  parseTarget,
  planPasses,
  profilesFor,
  type Target,
} from './targets.js';

interface CommonOptions extends ConfigOverrides {
  /** The project root: config, flows and output resolve against it. Default: the working directory. */
  cwd?: string;
  /** Path of a config file, instead of looking for one. */
  config?: string;
  /** Show the browser. Passes then run one at a time. */
  headed?: boolean;
  log?: (msg: string) => void;
}

export interface SelectOptions extends CommonOptions {
  /**
   * What to run: `flow`, `flow/shot`, `flow@profile` or `flow/shot@profile`.
   * A flow part that is not a flow's whole name selects every flow containing
   * it. None means every flow.
   */
  targets?: string[];
  /** Only the flows closest to this source file or directory. */
  near?: string;
  /** Only flows that navigate to a route starting with this. */
  route?: string;
}

export type RunOptions = SelectOptions;

export interface SnapOptions extends CommonOptions {
  /** Routes to load and shoot, one shot each. */
  paths?: string[];
  /**
   * A flow given as data instead: its steps, or `{ steps, shows?, video?, cursor?, pace?, profiles? }`.
   * Unchecked on purpose — this is what arrives as JSON, and it is validated here.
   */
  flow?: unknown;
  /** Names the output directory. Default `snap`. */
  name?: string;
  /**
   * With `paths`: shoot only this element on each route, rather than the
   * page. The quick look at a component that was just changed.
   */
  of?: string;
  /** With `of`: this many pixels of the page around the element as well. */
  pad?: number;
}

export interface ExportOptions extends CommonOptions {
  /** Which exports to write. Default: every one configured. */
  names?: string[];
}

/** Reports kept per output root; older ones are removed. */
const REPORTS_KEPT = 20;

async function configure(
  options: CommonOptions,
): Promise<{ cwd: string; config: ResolvedConfig }> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const loaded = await loadConfig(cwd, options.config);
  const knownDevices = Object.fromEntries(
    Object.entries(devices).map(([name, preset]) => [
      name,
      { hasTouch: preset.hasTouch === true },
    ]),
  );
  const config = resolveConfig({
    file: loaded?.config ?? null,
    cli: {
      profiles: options.profiles,
      outDir: options.outDir,
      video: options.video,
      pace: options.pace,
      baseUrl: options.baseUrl,
      workers: options.workers,
      scale: options.scale,
      agent: options.agent,
    },
    knownDevices,
    cores: availableParallelism(),
  });
  return { cwd, config };
}

/** The flows the options select, loaded and checked, with the targets parsed. */
async function select(
  cwd: string,
  config: ResolvedConfig,
  options: SelectOptions,
): Promise<{ flows: Flow[]; targets: Target[] }> {
  const flowsDir = path.resolve(cwd, config.flows);
  const targets = (options.targets ?? []).map(parseTarget);
  let files = await findFlows(flowsDir);
  if (files.length === 0) {
    throw new Error(
      `no flows found in ${config.flows} (expected <name>.shots.ts)`,
    );
  }

  if (options.near !== undefined) {
    const target = path.resolve(cwd, options.near);
    const isDirectory = await stat(target).then(
      (found) => found.isDirectory(),
      () => false,
    );
    files = nearestFlows(files, target, { isDirectory, root: flowsDir });
    if (files.length === 0) throw new Error(`no flows near ${options.near}`);
  }
  if (targets.length > 0) {
    // Only what was asked for is imported, so a broken flow elsewhere does
    // not block the run.
    const names = files.map((file) => file.name);
    const wanted = new Set(targets.flatMap((t) => matchFlows(names, t)));
    files = files.filter((file) => wanted.has(file.name));
  }

  let flows = await Promise.all(files.map(loadFlow));
  // A flow file is only as checked as the project's tooling makes it; a typo
  // in one should read as a typo, not as a step that did nothing.
  const custom = Object.keys(config.steps);
  for (const flow of flows) {
    try {
      checkSteps(flow.steps, custom);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`${path.relative(cwd, flow.file ?? flow.name)}: ${why}`);
    }
  }
  if (options.route !== undefined) {
    const route = options.route;
    flows = flows.filter((flow) =>
      routesOf(flow.steps).some((visited) => visited.startsWith(route)),
    );
    if (flows.length === 0) throw new Error(`no flow goes to ${route}`);
  }
  return { flows, targets };
}

/** The catalog: what flows there are and what each one shows, without running any. */
export async function listFlows(
  options: SelectOptions = {},
): Promise<FlowSummary[]> {
  const { cwd, config } = await configure(options);
  const { flows, targets } = await select(cwd, config, options);
  // Planning validates the targets; a listing is of whole flows all the same.
  planPasses(flows, config, targets);
  return flows.map((flow) => {
    const chapters: string[] = [];
    for (const { chapter } of walk(flow.steps)) {
      if (chapter !== null && !chapters.includes(chapter)) {
        chapters.push(chapter);
      }
    }
    return {
      name: flow.name,
      file: flow.file,
      shows: flow.shows ?? null,
      routes: routesOf(flow.steps),
      chapters,
      profiles: profilesFor(flow, config).map((profile) => profile.name),
      shots: shotsOf(flow.steps).map(({ name, shows }) => ({ name, shows })),
    };
  });
}

/** Run `task` over `items`, at most `limit` at a time. */
async function pool<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await task(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

async function writeReport(result: RunResult, id: string): Promise<void> {
  const dir = path.dirname(result.report);
  await mkdir(dir, { recursive: true });
  await writeFile(result.report, `${JSON.stringify(result, null, 2)}\n`);
  // Named by time, so the oldest sort first.
  const reports = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  for (const old of reports.sort().slice(0, -REPORTS_KEPT)) {
    if (old !== `${id}.json`) await rm(path.join(dir, old), { force: true });
  }
}

/**
 * Playwright keeps its browsers in one per-user cache, shared by every
 * checkout on the machine that uses the same Playwright version; this only
 * turns its page-long "not installed" banner into a line that says so.
 */
async function launchBrowser(headed: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless: !headed });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (!why.includes("Executable doesn't exist")) throw error;
    throw new Error(
      `the browser for this project's Playwright is not installed: run \`${headed ? 'playwright install chromium' : 'playwright install chromium-headless-shell'}\` (once per machine and Playwright version, not per checkout)`,
    );
  }
}

async function execute(
  cwd: string,
  config: ResolvedConfig,
  passes: Pass[],
  options: CommonOptions,
): Promise<RunResult> {
  const log = options.log ?? (() => {});
  const startedAt = new Date();
  const root = path.resolve(cwd, config.outDir);
  const outDir = path.join(root, config.root);
  const id = `${startedAt.toISOString().replace(/[-:.]/g, '')}-${process.pid}`;

  // Before the app: a machine without the browser should say so at once, not
  // after waiting for a server it then has no use for.
  const browser = await launchBrowser(options.headed === true);
  let server: RunningServer;
  try {
    if (config.baseUrl !== null) {
      // Given an app, shotta manages none: nothing is started, and one it left
      // up earlier is neither used nor touched.
      if (!(await reachable(config.baseUrl))) {
        throw new Error(`nothing answers at ${config.baseUrl}`);
      }
      server = { baseUrl: config.baseUrl, stop: async () => {} };
    } else if (config.server !== null) {
      server = await ensureServer(config.server, {
        cwd,
        outDir: path.resolve(cwd, config.stateDir),
        log,
      });
    } else {
      throw new Error(
        'nothing to run against: set `server` or `baseUrl` in the config, or pass --base-url',
      );
    }
  } catch (error) {
    await browser.close();
    throw error;
  }

  // A recording is only as smooth as the machine is idle, so recorded passes
  // run alone, after the rest have run side by side.
  const quiet = passes.filter(({ flow }) => !records(flow, config));
  const recorded = passes.filter(({ flow }) => records(flow, config));
  const workers = options.headed ? 1 : config.workers;
  const together = workers > 1 && quiet.length > 1;

  const results = new Map<Pass, PassResult>();
  try {
    try {
      const runPass = async (pass: Pass, live: boolean): Promise<void> => {
        // Side by side, each pass speaks once it is done; interleaved steps
        // of several flows would be unreadable.
        const lines: string[] = [];
        const say = live ? log : (msg: string) => void lines.push(msg);
        say(`▶ ${pass.flow.name} · ${pass.profile.name}`);
        const result = await runFlow(pass.flow, {
          browser,
          baseUrl: server.baseUrl,
          outDir,
          profile: pass.profile,
          config,
          log: say,
        });
        for (const shot of result.shots) {
          say(`  → ${path.relative(cwd, shot.file)}`);
        }
        for (const sheet of result.storyboard) {
          say(`  → ${path.relative(cwd, sheet)}`);
        }
        if (result.video !== null) {
          say(`  → ${path.relative(cwd, result.video)}`);
        }
        if (result.failure !== null) {
          say(`  ✗ ${result.failure.message.split('\n')[0]}`);
        }
        for (const line of lines) log(line);
        results.set(pass, result);
      };
      await pool(quiet, workers, (pass) => runPass(pass, !together));
      for (const pass of recorded) await runPass(pass, true);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }

  // In the order planned, however they finished.
  const ordered = passes.map((pass) => results.get(pass) as PassResult);
  const result: RunResult = {
    ok: ordered.every((pass) => pass.ok),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    outDir,
    report: path.join(outDir, 'runs', `${id}.json`),
    passes: ordered,
  };
  await writeReport(result, id);
  return result;
}

/**
 * Run what the targets ask for — every flow at every profile when there are
 * none. A failed pass never stops the others: a narrow profile is expected to
 * break views, and the list of what broke where is the point of the run.
 * Throws only when the run cannot start.
 */
export async function run(options: RunOptions = {}): Promise<RunResult> {
  const { cwd, config } = await configure(options);
  const { flows, targets } = await select(cwd, config, options);
  const passes = planPasses(flows, config, targets);
  if (passes.length === 0) {
    // Only a flow's own profiles can leave nothing: every flow selected is
    // for sizes the command line did not ask for.
    const asked = config.profiles.map((profile) => profile.name).join(', ');
    throw new Error(
      `nothing to run at ${asked}: ${flows
        .filter((flow) => flow.profiles !== undefined)
        .map((flow) => `${flow.name} runs at ${flow.profiles?.join(', ')}`)
        .join('; ')}`,
    );
  }
  return execute(cwd, config, passes, options);
}

/** A route as a shot name: `/portfolio/actions?tab=mine` → `portfolio-actions-tab-mine`. */
export function shotNameFor(route: string): string {
  const name = route
    .replace(/^https?:\/\//, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return name === '' ? 'index' : name;
}

/**
 * Look at the app without writing a flow file: shoot some routes, or run a
 * flow given as data. Videos are off unless asked for, since this is for
 * looking, not showing.
 */
export async function snap(options: SnapOptions): Promise<RunResult> {
  const { cwd, config } = await configure({
    ...options,
    video: options.video ?? false,
  });

  const name = options.name ?? 'snap';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`a flow name must be kebab-case: ${name}`);
  }
  const paths = options.paths ?? [];
  if (paths.length > 0 === (options.flow !== undefined)) {
    throw new Error(
      'snap takes routes to shoot, or steps to run — one of them',
    );
  }

  if (options.pad !== undefined && options.of === undefined) {
    throw new Error('--pad is the page around an element: it needs --of');
  }
  if (options.of !== undefined && paths.length === 0) {
    throw new Error(
      '--of is for routes; in steps, say it on the shot: { "shot": …, "of": … }',
    );
  }

  let definition: FlowOptions;
  if (paths.length > 0) {
    const area =
      options.of === undefined
        ? {}
        : {
            of: options.of,
            ...(options.pad === undefined ? {} : { pad: options.pad }),
          };
    definition = {
      steps: checkSteps(
        paths.flatMap((route) => [
          { goto: route },
          { shot: shotNameFor(route), ...area },
        ]),
      ),
    };
  } else {
    const given = options.flow;
    if (typeof given !== 'object' || given === null) {
      throw new Error('a flow is an array of steps, or an object with "steps"');
    }
    const { steps, ...rest } = (
      Array.isArray(given) ? { steps: given } : given
    ) as Partial<FlowOptions>;
    const stray = Object.keys(rest).find(
      (key) => !['shows', 'video', 'cursor', 'pace', 'profiles'].includes(key),
    );
    if (stray !== undefined) throw new Error(`a flow has no "${stray}"`);
    definition = {
      ...rest,
      steps: checkSteps(steps, Object.keys(config.steps)),
    };
  }
  const flow: Flow = { ...definition, name, file: null };
  return execute(cwd, config, planPasses([flow], config, []), options);
}

/**
 * What an export asks for, set against the flows there are: the passes that
 * take its shots, and each shot with the profiles it is wanted at. Throws on
 * an address that names no flow, shot or profile, or one file for several.
 */
function planExport(
  entry: ResolvedExport,
  flows: Flow[],
  config: ResolvedConfig,
): {
  passes: Pass[];
  wanted: {
    flow: string;
    shot: string;
    profiles: string[];
    file: string | null;
  }[];
} {
  const passes = planPasses(
    flows,
    config,
    entry.shots.map((shot) => shot.target),
  );
  const flowNames = flows.map((flow) => flow.name);
  const wanted = entry.shots.map(({ address, target, file }) => {
    const flow = matchFlows(flowNames, target)[0] as string;
    const profiles =
      target.profile === null
        ? profilesFor(
            flows.find((candidate) => candidate.name === flow) as Flow,
            config,
          ).map((profile) => profile.name)
        : [target.profile];
    if (file !== null && profiles.length !== 1) {
      throw new Error(
        `exports.${entry.name}: ${file} is one file, but ${address} is shot at ${profiles.join(' and ')} — name the profile`,
      );
    }
    return { flow, shot: target.shot as string, profiles, file };
  });
  return { passes, wanted };
}

/**
 * Say what is wrong with the project's config, flows and exports, without a
 * browser or the app: everything a run would refuse to start over, for every
 * flow at once rather than the first. Never throws for what it finds.
 */
export async function check(options: CommonOptions = {}): Promise<CheckResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const result: CheckResult = {
    ok: false,
    flows: 0,
    shots: 0,
    exports: 0,
    problems: [],
  };
  const note = (file: string | null, error: unknown): void => {
    result.problems.push({
      file,
      message: error instanceof Error ? error.message : String(error),
    });
  };

  let config: ResolvedConfig;
  try {
    ({ config } = await configure(options));
  } catch (error) {
    // Nothing else can be read without it.
    note(null, error);
    return result;
  }

  const flows: Flow[] = [];
  try {
    const files = await findFlows(path.resolve(cwd, config.flows));
    if (files.length === 0) {
      throw new Error(
        `no flows found in ${config.flows} (expected <name>.shots.ts)`,
      );
    }
    const custom = Object.keys(config.steps);
    for (const file of files) {
      try {
        const flow = await loadFlow(file);
        checkSteps(flow.steps, custom);
        profilesFor(flow, config);
        flows.push(flow);
      } catch (error) {
        note(file.file, error);
      }
    }
  } catch (error) {
    note(null, error);
  }

  for (const entry of config.exports) {
    try {
      planExport(entry, flows, config);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      note(
        null,
        why.startsWith('exports.') ? why : `exports.${entry.name}: ${why}`,
      );
    }
  }

  result.flows = flows.length;
  result.shots = flows.reduce(
    (count, flow) => count + shotsOf(flow.steps).length,
    0,
  );
  result.exports = config.exports.length;
  result.ok = result.problems.length === 0;
  return result;
}

/**
 * Write the configured exports: shoot each one's shots at its scale, then copy
 * them out under their stable names. Shooting happens in scratch output of its
 * own, so an export never disturbs what a person or an agent last looked at,
 * and a shot that could not be taken leaves the file already there untouched.
 */
export async function exportShots(
  options: ExportOptions = {},
): Promise<ExportResult> {
  const log = options.log ?? (() => {});
  const { config: base } = await configure(options);
  if (base.exports.length === 0) {
    throw new Error('no exports are configured: add `exports` to the config');
  }
  const have = base.exports.map((entry) => entry.name);
  const names = options.names?.length ? options.names : have;
  const stranger = names.find((name) => !have.includes(name));
  if (stranger !== undefined) {
    throw new Error(`no export called ${stranger} (have: ${have.join(', ')})`);
  }

  const result: ExportResult = { ok: true, files: [], missing: [], runs: [] };
  for (const name of names) {
    const entry = base.exports.find(
      (e) => e.name === name,
    ) as (typeof base.exports)[number];
    const resolved = await configure({
      ...options,
      agent: false,
      video: false,
      scale: entry.scale ?? options.scale,
    });
    const { cwd } = resolved;
    const config: ResolvedConfig = {
      ...resolved.config,
      storyboard: false,
      root: 'export',
    };

    const { flows } = await select(cwd, config, {
      targets: entry.shots.map((shot) => shot.address),
    });
    // Everything that can be wrong with the request is, before a browser opens.
    const { passes, wanted } = planExport(entry, flows, config);

    log(`▷ export ${name} → ${entry.dir}`);
    const run = await execute(cwd, config, passes, options);
    result.runs.push(run);
    const dir = path.resolve(cwd, entry.dir);
    await mkdir(dir, { recursive: true });
    const encode: EncodeJob[] = [];
    for (const { flow, shot, profiles, file } of wanted) {
      for (const profile of profiles) {
        const address = `${flow}/${shot}@${profile}`;
        const taken = run.passes
          .find((pass) => pass.flow === flow && pass.profile === profile)
          ?.shots.find((candidate) => candidate.name === shot);
        if (taken === undefined) {
          result.missing.push({ export: name, address });
          continue;
        }
        // A file's own name says what it is; the list form's all share one.
        const format =
          file === null ? entry.format : (formatOf(file) ?? entry.format);
        const written: ExportedFile = {
          export: name,
          address,
          file: path.join(
            dir,
            file ?? `${flow}.${shot}.${profile}.${EXTENSION[format]}`,
          ),
        };
        if (format === 'png') {
          await copyFile(taken.file, written.file);
        } else {
          encode.push({
            from: taken.file,
            to: written.file,
            format,
            quality: entry.quality,
          });
        }
        result.files.push(written);
        log(`  → ${path.relative(cwd, written.file)}`);
      }
    }
    if (encode.length > 0) {
      // The shots are PNGs; the browser that took them writes the rest.
      const browser = await launchBrowser(false);
      try {
        await encodeImages(browser, encode);
      } finally {
        await browser.close();
      }
    }
  }
  result.ok = result.missing.length === 0;
  return result;
}

/**
 * Stop the app an earlier run left up.
 * @returns whether there was one
 */
export async function stop(options: CommonOptions = {}): Promise<boolean> {
  const { cwd, config } = await configure(options);
  return stopServer(path.resolve(cwd, config.stateDir));
}
