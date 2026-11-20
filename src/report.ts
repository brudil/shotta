/** What a run produced, in a shape a script or an agent can read. */

export interface ShotResult {
  /** The name the flow gave it. */
  name: string;
  /** What the flow says a reader should find in it, if it says. */
  shows: string | null;
  chapter: string | null;
  /** 1-based position of the `shot` step in the flow. */
  step: number;
  /** Absolute path of the full-page PNG. */
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
  /** Each addressable as `<flow>/<shot>`. */
  shots: { name: string; shows: string | null }[];
}
