/** Starting, sharing and stopping the app under test. */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ServerConfig } from './config.js';
import type { KeeperOptions, ServerState } from './keeper.js';

export interface RunningServer {
  baseUrl: string;
  /** Done with it. A kept-alive app stays up; one started for this run stops. */
  stop: () => Promise<void>;
}

const STATE_FILE = 'server.json';
const LOCK_FILE = 'server.lock';
const LOG_FILE = 'server.log';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/**
 * Whether anything is listening there at all. Any response counts: an app the
 * caller pointed at may well answer its root with a redirect or a 404.
 */
export async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Not ours to signal is still running.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Start the app for this run alone, on a free port, and stop it afterwards.
 */
async function startOwn(
  server: Required<ServerConfig>,
  { cwd, log }: { cwd: string; log: (msg: string) => void },
): Promise<RunningServer> {
  const port = await freePort();
  const command = server.command.replaceAll('{port}', String(port));
  const baseUrl = server.url.replaceAll('{port}', String(port));
  log(`starting: ${command}`);

  // The command runs through a shell, so the app is a grandchild at best.
  // Its own process group lets `stop` take the whole tree down.
  const group = process.platform !== 'win32';
  const child = spawn(command, {
    shell: true,
    cwd,
    detached: group,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port) },
  });
  const tail: string[] = [];
  const remember = (chunk: Buffer): void => {
    tail.push(...chunk.toString().split('\n'));
    if (tail.length > 40) tail.splice(0, tail.length - 40);
  };
  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const kill = (signal: NodeJS.Signals): void => {
    if (exited || child.pid === undefined) return;
    try {
      if (group) process.kill(-child.pid, signal);
      else execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } catch {
      // already gone
    }
  };
  // Covers an interrupted run, where `stop` is never reached.
  const onExit = (): void => kill('SIGKILL');
  process.once('exit', onExit);

  const stop = async (): Promise<void> => {
    process.off('exit', onExit);
    if (exited) return;
    kill('SIGTERM');
    await sleep(500);
    kill('SIGKILL');
  };

  const deadline = Date.now() + server.readyTimeout;
  while (!exited && Date.now() < deadline) {
    if (await answers(baseUrl)) return { baseUrl, stop };
    await sleep(250);
  }
  const why = exited ? 'exited before answering' : 'did not answer';
  await stop();
  throw new Error(
    `the app ${why} on ${baseUrl}\n--- output of: ${command} ---\n${tail.join('\n')}`,
  );
}

async function readState(file: string): Promise<ServerState | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Take the right to start the app, unless a live process already holds it. */
async function takeLock(file: string): Promise<boolean> {
  try {
    await writeFile(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    const holder = Number(await readFile(file, 'utf8').catch(() => ''));
    if (!alive(holder)) await rm(file, { force: true });
    return false;
  }
}

async function stopKeeper(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let waited = 0; alive(pid) && waited < 5000; waited += 100) {
    await sleep(100);
  }
}

async function logTail(file: string): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').slice(-40).join('\n');
}

/**
 * The app, up and answering. One that an earlier run left up for this project
 * is used as it is; otherwise it is started and left up in turn, so that runs
 * one after another — or side by side — pay for the startup once.
 *
 * Only an app `shotta` itself started is ever reused, and only while the
 * command that started it is still the configured one. A server the developer
 * has running is never touched: it may be another checkout or environment.
 */
export async function ensureServer(
  server: Required<ServerConfig>,
  {
    cwd,
    outDir,
    log,
  }: { cwd: string; outDir: string; log: (msg: string) => void },
): Promise<RunningServer> {
  if (server.keepAlive <= 0) return startOwn(server, { cwd, log });

  await mkdir(outDir, { recursive: true });
  const stateFile = path.join(outDir, STATE_FILE);
  const lockFile = path.join(outDir, LOCK_FILE);
  const logFile = path.join(outDir, LOG_FILE);

  const use = async (state: ServerState): Promise<RunningServer> => {
    // The keeper reads the state file's age as how long the app has sat idle.
    const touch = async (): Promise<void> => {
      const now = new Date();
      await utimes(stateFile, now, now).catch(() => {});
    };
    await touch();
    const beat = setInterval(touch, Math.min(15_000, server.keepAlive / 3));
    beat.unref();
    return {
      baseUrl: state.baseUrl,
      stop: async () => {
        clearInterval(beat);
        await touch();
      },
    };
  };

  let keeper: number | null = null;
  let locked = false;
  const deadline = Date.now() + server.readyTimeout;
  try {
    while (Date.now() < deadline) {
      const state = await readState(stateFile);
      if (state !== null) {
        if (!alive(state.keeper)) {
          await rm(stateFile, { force: true });
        } else if (state.template !== server.command || state.cwd !== cwd) {
          log('restarting the app: its command has changed');
          await stopKeeper(state.keeper);
          await rm(stateFile, { force: true });
        } else if (await answers(state.baseUrl)) {
          if (keeper === null) log(`using the app at ${state.baseUrl}`);
          return await use(state);
        } else {
          // Coming up, for us or for a run alongside.
          await sleep(250);
        }
        continue;
      }
      if (keeper !== null) {
        if (!alive(keeper)) {
          throw new Error(
            `the app exited before answering\n--- output of: ${server.command} ---\n${await logTail(logFile)}`,
          );
        }
        await sleep(100);
        continue;
      }
      locked = await takeLock(lockFile);
      if (!locked) {
        // A run alongside is starting it.
        await sleep(250);
        continue;
      }
      const port = await freePort();
      const options: KeeperOptions = {
        stateFile,
        logFile,
        template: server.command,
        command: server.command.replaceAll('{port}', String(port)),
        cwd,
        port,
        baseUrl: server.url.replaceAll('{port}', String(port)),
        keepAlive: server.keepAlive,
      };
      log(`starting: ${options.command}`);
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./keeper.js', import.meta.url)),
          JSON.stringify(options),
        ],
        { cwd, detached: true, stdio: 'ignore' },
      );
      child.unref();
      keeper = child.pid ?? null;
      if (keeper === null) throw new Error('could not start the app');
    }
    if (keeper !== null) await stopKeeper(keeper);
    throw new Error(
      `the app did not answer within ${server.readyTimeout}ms\n--- output of: ${server.command} ---\n${await logTail(logFile)}`,
    );
  } finally {
    if (locked) await rm(lockFile, { force: true });
  }
}

/**
 * Stop the app an earlier run left up.
 * @returns whether there was one
 */
export async function stopServer(outDir: string): Promise<boolean> {
  const stateFile = path.join(outDir, STATE_FILE);
  const state = await readState(stateFile);
  if (state === null) return false;
  const was = alive(state.keeper);
  await stopKeeper(state.keeper);
  await rm(stateFile, { force: true });
  return was;
}
