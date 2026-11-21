/**
 * Flow definitions.
 *
 * A flow is a scripted journey through the app. `shot` steps checkpoint a
 * full-page screenshot; the whole journey is also recorded as a video. An
 * `annotate` span names a chapter, which is captioned in the video and groups
 * that chapter's shots into a subdirectory.
 *
 * Files are named `<name>.shots.ts` and default-export {@link defineFlow}; the
 * flow's name is the file stem. Every step but `run` is plain data, so a flow
 * can equally be written as JSON.
 */
import type { Page } from 'playwright';

/** A Playwright selector string, e.g. `text=Load more`, `role=button[name="Clear"]`. */
export type Selector = string;

/**
 * Steps a project adds, as step name → the value the step takes. Empty here;
 * a project fills it in beside the handlers in its config:
 *
 * ```ts
 * declare module 'shotta' {
 *   interface CustomSteps { login: { as: string } }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: projects add members by declaration merging
export interface CustomSteps {}

type CustomStep = {
  [K in keyof CustomSteps]: { [P in K]: CustomSteps[K] };
}[keyof CustomSteps];

export type BuiltinStep =
  /** Navigate. Relative paths resolve against the app's base URL. */
  | { goto: string }
  | { click: Selector }
  | { hover: Selector }
  /** Type `type` into `into`, one key at a time. */
  | { type: string; into: Selector; delay?: number }
  /** A selector scrolls that element into view; a number scrolls by that many pixels. */
  | { scroll: Selector | number }
  | { press: string }
  /**
   * A selector waits for that element, which is a real precondition. A number is a
   * timing guess and a sign that settling missed something.
   */
  | { wait: Selector | number }
  /**
   * Checkpoint a screenshot — of the full page unless `of` or `viewport` says
   * otherwise — named for the state it shows, uniquely within the flow. `shows`
   * says what a reader should find in it: the claim the shot is there to back.
   */
  | {
      shot: string;
      shows?: string;
      /** Shoot only this element, rather than the whole page. */
      of?: Selector;
      /** Shoot only what is on screen, rather than the whole page. */
      viewport?: boolean;
    }
  /**
   * Anything the other steps cannot say, with the Playwright page in hand.
   * `label` names the step in the log and the run report.
   */
  | { run: (page: Page) => Promise<void>; label?: string };

export type ActionStep = BuiltinStep | CustomStep;

/** A named chapter. Captioned in the video for the length of its steps. */
export interface Chapter {
  annotate: string;
  steps: ActionStep[];
}

export type Step = ActionStep | Chapter;

export interface FlowOptions {
  /** One line on what this flow is there to show, for whoever is choosing one. */
  shows?: string;
  /** Pause between steps in ms while recording. Defaults to the configured pace. */
  pace?: number;
  /**
   * Record `journey.webm`. By default a flow is recorded only when something
   * moves in it — a step that clicks, hovers, types, scrolls, presses or runs
   * code — since a flow that only loads a route and checkpoints it is fully
   * described by its shots. Set this to force the decision either way;
   * `--no-video` still wins. A recording starts at the first ready frame, not
   * at the blank page.
   */
  video?: boolean;
  /**
   * Draw the cursor and animate pointer travel. Default true. Touch profiles
   * never draw one: a tap is marked by a ring instead.
   */
  cursor?: boolean;
  /**
   * The profiles this flow runs at, in place of the config's `run`: for a
   * journey that only exists at some sizes, such as one through a layout a
   * phone does not have. Names of configured profiles. A target can still ask
   * for any profile by name (`flow@phone`).
   */
  profiles?: string[];
  steps: Step[];
}

/** Marker the runner checks so a stray default export fails loudly. */
export interface FlowDefinition extends FlowOptions {
  __shotsFlow: true;
}

/** A definition plus the name the runner took from the filename. */
export interface Flow extends FlowOptions {
  name: string;
  /** Absolute path of the file that defined it; null for a flow given as data. */
  file: string | null;
}

export function defineFlow(options: FlowOptions): FlowDefinition {
  return { ...options, __shotsFlow: true };
}

/** In the order a step is checked for them. */
const BUILTIN_KINDS = [
  'goto',
  'click',
  'hover',
  'type',
  'scroll',
  'press',
  'wait',
  'shot',
  'run',
] as const;

type BuiltinKind = (typeof BUILTIN_KINDS)[number];

/** Keys that mean something on a step, so a project's step cannot take them. */
export const RESERVED_STEP_KEYS: readonly string[] = [
  ...BUILTIN_KINDS,
  'into',
  'delay',
  'label',
  'annotate',
  'steps',
];

/** The keys a step of each kind may carry beside the kind itself. */
const EXTRA_KEYS: Partial<Record<BuiltinKind, string[]>> = {
  type: ['into', 'delay'],
  shot: ['shows', 'of', 'viewport'],
  run: ['label'],
};

/** A shot's name becomes a filename. */
const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Flatten a flow's steps, tagging each with its chapter title (or null). */
export function* walk(
  steps: Step[],
  chapter: string | null = null,
): Generator<{ step: ActionStep; chapter: string | null }> {
  for (const step of steps) {
    if ('annotate' in step) yield* walk(step.steps, step.annotate);
    else yield { step, chapter };
  }
}

/**
 * Which step this is: a built-in's name, or else the project step it names.
 * Assumes a step that {@link checkSteps} has passed.
 */
export function stepKind(step: ActionStep): string {
  const builtin = BUILTIN_KINDS.find((kind) => kind in step);
  return builtin ?? Object.keys(step)[0] ?? '';
}

function brief(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** One line naming a step, for the log and the run report. */
export function describeStep(step: ActionStep): string {
  if ('goto' in step) return `goto ${step.goto}`;
  if ('click' in step) return `click ${step.click}`;
  if ('hover' in step) return `hover ${step.hover}`;
  if ('type' in step)
    return `type ${JSON.stringify(step.type)} into ${step.into}`;
  if ('scroll' in step) return `scroll ${step.scroll}`;
  if ('press' in step) return `press ${step.press}`;
  if ('wait' in step) return `wait ${step.wait}`;
  if ('shot' in step) return `shot ${step.shot}`;
  if ('run' in step) {
    return step.label === undefined ? 'run' : `run ${step.label}`;
  }
  const kind = stepKind(step);
  return `${kind} ${brief((step as Record<string, unknown>)[kind])}`;
}

/** Steps that move something. A flow with none of them has nothing to watch. */
const MOTION_STEPS = ['click', 'hover', 'type', 'scroll', 'press', 'run'];

/**
 * Whether a flow does anything a viewer would watch. Loading a route and
 * checkpointing it is fully described by the shots, so recording it would only
 * produce a few seconds of a still page.
 */
export function hasMotion(steps: Step[]): boolean {
  for (const { step } of walk(steps)) {
    if (MOTION_STEPS.some((key) => key in step)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkAction(step: unknown, at: string, custom: string[]): void {
  if (!isRecord(step)) throw new Error(`${at}: a step must be an object`);
  const known = [...BUILTIN_KINDS, ...custom];
  const kinds = Object.keys(step).filter((key) => known.includes(key));
  if (kinds.length !== 1) {
    const problem = kinds.length === 0 ? 'not a step' : 'more than one step';
    throw new Error(
      `${at}: ${problem}: ${brief(step)} (have: ${known.join(', ')})`,
    );
  }
  const kind = kinds[0] as string;
  const allowed = [kind, ...(EXTRA_KEYS[kind as BuiltinKind] ?? [])];
  const stray = Object.keys(step).find((key) => !allowed.includes(key));
  if (stray !== undefined) {
    throw new Error(`${at}: a ${kind} step has no "${stray}"`);
  }
  if (custom.includes(kind)) return;

  const value = step[kind];
  const string = typeof value === 'string' && value !== '';
  const expect = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`${at}: ${kind} takes ${what}`);
  };
  switch (kind as BuiltinKind) {
    case 'goto':
      expect(string, 'a path or URL');
      break;
    case 'click':
    case 'hover':
      expect(string, 'a selector');
      break;
    case 'type':
      expect(typeof value === 'string', 'the text to type');
      if (typeof step.into !== 'string' || step.into === '') {
        throw new Error(`${at}: type needs "into", the field's selector`);
      }
      if (step.delay !== undefined && typeof step.delay !== 'number') {
        throw new Error(`${at}: delay takes a number of ms`);
      }
      break;
    case 'scroll':
    case 'wait':
      expect(string || typeof value === 'number', 'a selector or a number');
      break;
    case 'press':
      expect(string, 'a key, e.g. "Escape"');
      break;
    case 'shot':
      expect(
        typeof value === 'string' && SHOT_NAME.test(value),
        'a name of letters, digits, ".", "_" and "-"',
      );
      if (step.shows !== undefined && typeof step.shows !== 'string') {
        throw new Error(`${at}: shows takes a sentence`);
      }
      if (
        step.of !== undefined &&
        (typeof step.of !== 'string' || step.of === '')
      ) {
        throw new Error(`${at}: of takes the selector of the element to shoot`);
      }
      if (step.viewport !== undefined && typeof step.viewport !== 'boolean') {
        throw new Error(`${at}: viewport takes true or false`);
      }
      if (step.of !== undefined && step.viewport === true) {
        throw new Error(
          `${at}: a shot is of an element or of the viewport, not both`,
        );
      }
      break;
    case 'run':
      expect(typeof value === 'function', 'a function');
      if (step.label !== undefined && typeof step.label !== 'string') {
        throw new Error(`${at}: label takes a string`);
      }
      break;
  }
}

/**
 * Check steps that came from outside the type system — a JSON flow, or a
 * TypeScript one nobody type-checked — and say where the first mistake is.
 * `custom` names the project's own steps, whose values are theirs to check.
 */
export function checkSteps(steps: unknown, custom: string[] = []): Step[] {
  if (!Array.isArray(steps)) throw new Error('steps must be an array');
  // A shot is addressed as flow/shot, so its name has to be the only one.
  const shots = new Set<string>();
  const unique = (step: unknown, at: string): void => {
    if (!isRecord(step) || typeof step.shot !== 'string') return;
    if (shots.has(step.shot)) {
      throw new Error(
        `${at}: this flow already has a shot called ${step.shot}`,
      );
    }
    shots.add(step.shot);
  };
  steps.forEach((step, index) => {
    const at = `steps[${index}]`;
    if (isRecord(step) && 'annotate' in step) {
      if (typeof step.annotate !== 'string' || step.annotate === '') {
        throw new Error(`${at}: annotate takes the chapter's title`);
      }
      if (!Array.isArray(step.steps)) {
        throw new Error(`${at}: a chapter needs "steps", an array`);
      }
      const stray = Object.keys(step).find(
        (key) => key !== 'annotate' && key !== 'steps',
      );
      if (stray !== undefined) {
        throw new Error(`${at}: a chapter has no "${stray}"`);
      }
      step.steps.forEach((inner, innerIndex) => {
        const innerAt = `${at}.steps[${innerIndex}]`;
        if (isRecord(inner) && 'annotate' in inner) {
          throw new Error(`${innerAt}: a chapter cannot hold another chapter`);
        }
        checkAction(inner, innerAt, custom);
        unique(inner, innerAt);
      });
    } else {
      checkAction(step, at, custom);
      unique(step, at);
    }
  });
  return steps as Step[];
}

/** The shots a flow takes, in order. */
export function shotsOf(
  steps: Step[],
): { name: string; shows: string | null; chapter: string | null }[] {
  const shots = [];
  for (const { step, chapter } of walk(steps)) {
    if ('shot' in step) {
      shots.push({ name: step.shot, shows: step.shows ?? null, chapter });
    }
  }
  return shots;
}

/** The routes a flow navigates to, in order, without repeats. */
export function routesOf(steps: Step[]): string[] {
  const routes: string[] = [];
  for (const { step } of walk(steps)) {
    if ('goto' in step && !routes.includes(step.goto)) routes.push(step.goto);
  }
  return routes;
}

/**
 * The steps up to and including the last of the named shots: all a run needs
 * when those shots are what was asked for. A chapter cut short keeps its title.
 */
export function stepsThrough(steps: Step[], shots: string[]): Step[] {
  let remaining = 0;
  for (const { step } of walk(steps)) {
    if ('shot' in step && shots.includes(step.shot)) remaining += 1;
  }
  if (remaining === 0) return steps;

  const kept: Step[] = [];
  const keep = (step: ActionStep, into: ActionStep[] | Step[]): boolean => {
    into.push(step);
    if ('shot' in step && shots.includes(step.shot)) remaining -= 1;
    return remaining > 0;
  };
  for (const step of steps) {
    if ('annotate' in step) {
      const inner: ActionStep[] = [];
      kept.push({ annotate: step.annotate, steps: inner });
      for (const action of step.steps) {
        if (!keep(action, inner)) return kept;
      }
    } else if (!keep(step, kept)) {
      return kept;
    }
  }
  return kept;
}
