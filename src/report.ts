/** What a run produced, in a shape a script or an agent can read. */

export interface ShotResult {
  /** The name the flow gave it. */
  name: string;
  /** What the flow says a reader should find in it, if it says. */
  shows: string | null;
  /** What it is a picture of: the whole page, what was on screen, or one element. */
  area: 'page' | 'viewport' | 'element';
  chapter: string | null;
  /** 1-based position of the `shot` step in the flow. */
  step: number;
  /** Absolute path of the PNG. */
  file: string;
  /**
   * With `--agent`, the same page top to bottom in pieces small enough for a
   * vision model to read at full detail; a page that already fits is its own
   * only tile. Empty otherwise.
   */
  tiles: string[];
}

export interface FailureResult {
  /** 1-based position of the step that failed; 0 if the flow never started. */
  step: number;
  /** The step as the log shows it, e.g. `click text=Save`. */
  action: string;
  chapter: string | null;
  message: string;
  /** Where the page was when it failed. */
  url: string;
  /** Absolute path of a viewport screenshot taken at the failure, if one could be. */
  screenshot: string | null;
  /**
   * Absolute path of the page's accessibility tree at the failure, as YAML:
   * the roles and names a selector could have matched.
   */
  aria: string | null;
}

/** A step the page was still busy after when the runner stopped waiting. */
export interface UnsettledStep {
  /** 1-based position of the step in the flow. */
  step: number;
  /** The step as the log shows it. */
  action: string;
  /**
   * What was still busy, e.g. `request /api/events?topic=all` or `aria-busy on
   * div.table`. A request named here belongs in the config's `ignoreRequests`.
   */
  waitingOn: string[];
}

/** One flow at one profile. */
export interface PassResult {
  flow: string;
  profile: string;
  ok: boolean;
  durationMs: number;
  shots: ShotResult[];
  /** Absolute path of `journey.webm`, or null when none was recorded. */
  video: string | null;
  /**
   * Absolute paths of the storyboard's pages, in order: the journey as a
   * contact sheet, one captioned frame per step that changed something. Empty
   * for a flow that only loads a route and shoots it.
   */
  storyboard: string[];
  /** Uncaught exceptions and `console.error` output from the page, oldest first. */
  consoleErrors: string[];
  /**
   * The steps the page never went quiet after, each costing the pass a full
   * settle timeout before it carried on. Empty when every step settled.
   */
  unsettled: UnsettledStep[];
  failure: FailureResult | null;
}

export interface RunResult {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  /** Absolute path of the directory this run wrote to. */
  outDir: string;
  /** Absolute path of this report on disk. */
  report: string;
  passes: PassResult[];
}

/** A flow as `--list` reports it. */
export interface FlowSummary {
  name: string;
  /** Null for a flow given as data rather than a file. */
  file: string | null;
  /** What the flow is there to show, if it says. */
  shows: string | null;
  /** The routes it navigates to. */
  routes: string[];
  chapters: string[];
  /** The profiles it runs at when a target names none: the run's, or its own. */
  profiles: string[];
  /** Each addressable as `<flow>/<shot>`. */
  shots: { name: string; shows: string | null }[];
}

/** What `shotta check` found, without running anything. */
export interface CheckResult {
  /** Nothing is wrong: every flow would load and every export could be shot. */
  ok: boolean;
  /** How many flows there are that loaded and passed. */
  flows: number;
  /** How many shots those flows take between them. */
  shots: number;
  /** How many exports are configured. */
  exports: number;
  problems: {
    /** Absolute path of the flow file at fault; null for the config or an export. */
    file: string | null;
    /** What is wrong, e.g. `steps[1]: not a step: {"clik":"#save"} (have: goto, …)`. */
    message: string;
  }[];
}

/** One file an export wrote. */
export interface ExportedFile {
  /** The export it belongs to. */
  export: string;
  /** The shot, in full: `flow/shot@profile`. */
  address: string;
  /** Absolute path of the file written. */
  file: string;
}

export interface ExportResult {
  /** Every shot asked for was taken and written. */
  ok: boolean;
  files: ExportedFile[];
  /** Shots that were asked for and could not be taken. */
  missing: { export: string; address: string }[];
  /** The run behind each export, in order: where to look when something is missing. */
  runs: RunResult[];
}
