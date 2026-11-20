/** Finding and loading the config file and the flow files. */
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ShotsConfig } from './config.js';
import type { Flow, FlowDefinition } from './flow.js';

const CONFIG_NAMES = ['ts', 'mts', 'js', 'mjs', 'json'].map(
  (extension) => `shots.config.${extension}`,
);
/** Looked up in order; the project root wins over `.config/`. */
const CONFIG_CANDIDATES = [
  ...CONFIG_NAMES,
  ...CONFIG_NAMES.map((name) => path.join('.config', name)),
];

const FLOW_FILE = /\.shots\.(ts|mts|js|mjs)$/;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The project's config, or null when it has none. TypeScript configs load
 * through Node's type stripping, so they must stay erasable syntax.
 */
export async function loadConfig(
  cwd: string,
  explicit?: string,
): Promise<{ file: string; config: ShotsConfig } | null> {
  let file: string | null = null;
  if (explicit !== undefined) {
    file = path.resolve(cwd, explicit);
    if (!(await exists(file))) throw new Error(`no config file at ${explicit}`);
  } else {
    for (const candidate of CONFIG_CANDIDATES) {
      const resolved = path.resolve(cwd, candidate);
      if (await exists(resolved)) {
        file = resolved;
        break;
      }
    }
  }
  if (file === null) return null;

  const shown = path.relative(cwd, file);
  let config: unknown;
  if (file.endsWith('.json')) {
    try {
      config = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `${shown} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    config = (await import(pathToFileURL(file).href)).default;
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(
      file.endsWith('.json')
        ? `${shown} must hold an object`
        : `${shown} must default-export defineConfig(...)`,
    );
  }
  return { file, config: config as ShotsConfig };
}

export interface FlowFile {
  name: string;
  /** Absolute. */
  file: string;
}

async function walk(dir: string, found: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Dependencies and dot-directories (output, VCS, caches) hold no flows of
    // the project's own, and can be very large.
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, found);
    else if (FLOW_FILE.test(entry.name)) found.push(full);
  }
}

/**
 * Every flow file under `flowsDir`, by name. Nothing is imported: a broken
 * file must not block a run that never asked for it.
 */
export async function findFlows(flowsDir: string): Promise<FlowFile[]> {
  const files: string[] = [];
  try {
    await walk(flowsDir, files);
  } catch {
    throw new Error(`flows directory not found: ${flowsDir}`);
  }
  const seen = new Map<string, string>();
  const flows: FlowFile[] = [];
  for (const file of files) {
    const shown = path.relative(flowsDir, file);
    const name = path.basename(file).replace(FLOW_FILE, '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`flow filename must be kebab-case: ${shown}`);
    }
    const clash = seen.get(name);
    if (clash !== undefined) {
      throw new Error(`two flows are named ${name}: ${clash} and ${shown}`);
    }
    seen.set(name, shown);
    flows.push({ name, file });
  }
  return flows.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export async function loadFlow({ name, file }: FlowFile): Promise<Flow> {
  const definition: FlowDefinition | undefined = (
    await import(pathToFileURL(file).href)
  ).default;
  if (definition?.__shotsFlow !== true) {
    throw new Error(
      `${path.basename(file)} must default-export defineFlow(...)`,
    );
  }
  const { __shotsFlow: _marker, ...options } = definition;
  return { ...options, name, file };
}
