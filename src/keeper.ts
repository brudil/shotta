/**
 * Runs detached, outliving the `shots` that started it: owns the app server,
 * and stops it once no run has used it for a while. Not imported by anything;
 * `server.ts` spawns it with its options as one JSON argument.
 */
import { execFile, spawn } from 'node:child_process';
import {
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

export interface KeeperOptions {
  stateFile: string;
  logFile: string;
  /** The command as configured, before `{port}` was filled in: what a later run compares against. */
  template: string;
  command: string;
  cwd: string;
  port: number;
  baseUrl: string;
  keepAlive: number;
}

/** What a run finds on disk to decide whether an app is already up for it. */
export interface ServerState {
  keeper: number;
  template: string;
  cwd: string;
  baseUrl: string;
  startedAt: string;
}

const options: KeeperOptions = JSON.parse(process.argv[2] ?? '');

const log = openSync(options.logFile, 'w');
const group = process.platform !== 'win32';
// The command runs through a shell, so the app is a grandchild at best. Its
// own process group lets the whole tree be taken down together.
const child = spawn(options.command, {
  shell: true,
  cwd: options.cwd,
  detached: group,
  stdio: ['ignore', log, log],
  env: { ...process.env, PORT: String(options.port) },
});

const state: ServerState = {
  keeper: process.pid,
  template: options.template,
  cwd: options.cwd,
  baseUrl: options.baseUrl,
  startedAt: new Date().toISOString(),
};
writeFileSync(options.stateFile, `${JSON.stringify(state, null, 2)}\n`);

/** The state file still names this keeper: nobody has replaced it. */
function mine(): boolean {
  try {
    const current: ServerState = JSON.parse(
      readFileSync(options.stateFile, 'utf8'),
    );
    return current.keeper === process.pid;
  } catch {
    return false;
  }
}

function kill(signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (group) process.kill(-child.pid, signal);
    else execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } catch {
    // already gone
  }
}

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  if (mine()) rmSync(options.stateFile, { force: true });
  kill('SIGTERM');
  setTimeout(() => {
    kill('SIGKILL');
    process.exit(0);
  }, 500);
}

child.on('exit', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Every run touches the state file while it is using the app, so the file's
// age is how long the app has sat idle.
const poll = Math.max(250, Math.min(2000, options.keepAlive / 4));
setInterval(() => {
  try {
    const idle = Date.now() - statSync(options.stateFile).mtimeMs;
    if (!mine() || idle > options.keepAlive) stop();
  } catch {
    stop();
  }
}, poll);
