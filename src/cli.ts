#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';

import type { RunResult } from './report.js';
import { listFlows, run, snap, stop } from './run.js';

const HELP = `shots [run] [target…]     run flows: all of them, or the targets
shots list [target…]      the catalog: each flow, what it shows, its routes and shots
shots snap <route…>       screenshot routes without writing a flow
shots snap --steps <src>  run steps given as JSON: a file, - for stdin, or the JSON itself
shots stop                stop the app an earlier run left up

A target is flow, flow/shot, flow@profile or flow/shot@profile. A flow part
that is not a flow's whole name selects every flow containing it; with a shot,
the flow runs only as far as that shot. Several targets run side by side.

Output goes to <out>/review/<flow>/<profile>/ — checkpoint PNGs, a storyboard
and a journey video — or to <out>/agent/… with --agent. Each run's report is
written beside them under runs/.

  --near <path>       only the flows closest to this source file or directory
  --route <prefix>    only flows that navigate to a route starting with this
  --profiles <names>  comma-separated profiles to run (default: all configured)
  --agent             output for a model to read: 1x images, tall pages cut into
                      tiles, no video, and only the JSON report on stdout
  --scale <n>         device scale factor for every profile, e.g. 3 for print
  --workers <n>       passes to run at once when none is being recorded
  --no-video          skip journey.webm
  --video             record it even where the config or snap would not
  --headed            show the browser
  --out <dir>         output directory (default .shots)
  --base-url <url>    use an already-running app instead of starting one
  --config <file>     config file (default: shots.config.{ts,js,json}, or in .config/)
  --json              print the report as JSON on stdout; progress goes to stderr
  --name <name>       snap: the flow name its output goes under (default snap)
  -h, --help

Exits 0 when every pass succeeded, 1 when any failed, 2 when the run could not start.
Requires: playwright install chromium-headless-shell`;

const COMMANDS = ['run', 'list', 'snap', 'stop'] as const;
type Command = (typeof COMMANDS)[number];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    // `parseArgs` has no negation support, so the documented `--no-video` has to
    // be its own option rather than a false value for `--video`.
    'no-video': { type: 'boolean', default: false },
    video: { type: 'boolean', default: false },
    agent: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    // No defaults: only an explicit flag may override the config file.
    profiles: { type: 'string' },
    scale: { type: 'string' },
    workers: { type: 'string' },
    out: { type: 'string' },
    'base-url': { type: 'string' },
    config: { type: 'string' },
    near: { type: 'string' },
    route: { type: 'string' },
    steps: { type: 'string' },
    name: { type: 'string' },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

// An app started for this run alone is torn down by an exit hook, which a
// signal's default handling would skip.
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const named = COMMANDS.find((command) => command === positionals[0]);
const command: Command = named ?? 'run';
const args = named === undefined ? positionals : positionals.slice(1);

// An agent pays for every line it reads, so it gets the report and nothing else.
const json = values.json || values.agent;
const log = values.agent
  ? () => {}
  : json
    ? (msg: string) => console.error(msg)
    : (msg: string) => console.log(msg);

const number = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

const common = {
  config: values.config,
  profiles: values.profiles?.split(',').map((name) => name.trim()),
  outDir: values.out,
  // Absent flags defer to the config file; present, each forces its answer.
  video: values['no-video'] ? false : values.video ? true : undefined,
  baseUrl: values['base-url'],
  scale: number(values.scale),
  workers: number(values.workers),
  agent: values.agent,
  headed: values.headed,
  log,
};
const selection = {
  ...common,
  targets: args,
  near: values.near,
  route: values.route,
};

/** Steps from `--steps`: the JSON itself, a file holding it, or `-` for stdin. */
async function readSteps(source: string): Promise<unknown> {
  const inline = /^\s*[[{]/.test(source);
  const from = inline ? '--steps' : source === '-' ? 'stdin' : source;
  const raw = inline
    ? source
    : source === '-'
      ? await text(process.stdin)
      : await readFile(source, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${from} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function report(result: RunResult): never {
  if (json) console.log(JSON.stringify(result, null, 2));

  const failed = result.passes.filter((pass) => !pass.ok);
  if (failed.length > 0 && !values.agent) {
    console.error(`\n${failed.length} failed:`);
    const profiles = [...new Set(failed.map((pass) => pass.profile))];
    for (const profile of profiles) {
      console.error(`  ${profile}`);
      for (const pass of failed.filter((p) => p.profile === profile)) {
        const failure = pass.failure;
        const where = failure
          ? ` (step ${failure.step}: ${failure.action})`
          : '';
        console.error(
          `    ${pass.flow}${where}: ${failure?.message.split('\n')[0] ?? 'failed'}`,
        );
      }
    }
  }
  process.exit(result.ok ? 0 : 1);
}

try {
  if (command === 'stop') {
    console.log(
      (await stop(common)) ? 'stopped the app' : 'no app was running',
    );
    process.exit(0);
  }

  if (command === 'list') {
    const flows = await listFlows(selection);
    if (json) {
      console.log(JSON.stringify(flows, null, 2));
    } else {
      for (const flow of flows) {
        const file = flow.file === null ? '' : path.relative('.', flow.file);
        console.log(`${flow.name}  ${file}`);
        if (flow.shows !== null) console.log(`  ${flow.shows}`);
        for (const shot of flow.shots) {
          const shows = shot.shows === null ? '' : ` — ${shot.shows}`;
          console.log(`  ${flow.name}/${shot.name}${shows}`);
        }
      }
    }
    process.exit(0);
  }

  if (command === 'snap') {
    report(
      await snap({
        ...common,
        paths: args,
        flow:
          values.steps === undefined
            ? undefined
            : await readSteps(values.steps),
        name: values.name,
      }),
    );
  }

  report(await run(selection));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
