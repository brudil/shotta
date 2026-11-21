/**
 * Addresses: how a flow, a shot and a profile are named, everywhere.
 *
 *   checkout                      a flow, at every profile
 *   checkout/ready-to-pay         one shot of it: the flow runs only that far
 *   checkout@phone                a flow at one profile
 *   checkout/ready-to-pay@phone   one shot at one profile
 */
import type { ResolvedProfile } from './config.js';
import { type Flow, shotsOf, stepsThrough } from './flow.js';

export interface Target {
  flow: string;
  shot: string | null;
  profile: string | null;
}

/** One flow at one profile: the unit a run executes. */
export interface Pass {
  flow: Flow;
  profile: ResolvedProfile;
}

export function parseTarget(text: string): Target {
  const match = /^([^/@]+)(?:\/([^/@]+))?(?:@([^/@]+))?$/.exec(text);
  if (match === null) {
    throw new Error(
      `not a target: ${text} (expected flow, flow/shot, flow@profile or flow/shot@profile)`,
    );
  }
  return {
    flow: match[1] as string,
    shot: match[2] ?? null,
    profile: match[3] ?? null,
  };
}

export function formatTarget(target: Target): string {
  return `${target.flow}${target.shot === null ? '' : `/${target.shot}`}${target.profile === null ? '' : `@${target.profile}`}`;
}

/**
 * Which flow names a target's flow part selects: the flow of exactly that
 * name, or failing that every flow whose name contains it.
 */
export function matchFlows(names: string[], target: Target): string[] {
  if (names.includes(target.flow)) return [target.flow];
  return names.filter((name) => name.includes(target.flow));
}

/** The profiles a project has, and which of them a run uses. */
export interface Profiles {
  /** The profiles a run uses unless a flow or a target names others. */
  profiles: ResolvedProfile[];
  /** Every configured profile, in the order written. */
  available: ResolvedProfile[];
  /** True when the command line chose `profiles`. */
  profilesChosen?: boolean;
}

/**
 * The profiles a flow runs at when a target names none: the run's, or the
 * flow's own if it lists any, in the order configured. The command line
 * narrows either: a flow that is only for the desktop does not run when only
 * the phone was asked for.
 */
export function profilesFor(
  flow: Pick<Flow, 'name' | 'profiles'>,
  { profiles, available, profilesChosen = false }: Profiles,
): ResolvedProfile[] {
  const own = flow.profiles;
  if (own === undefined) return profiles;
  if (
    !Array.isArray(own) ||
    own.length === 0 ||
    own.some((name) => typeof name !== 'string')
  ) {
    throw new Error(`${flow.name}: profiles takes a list of profile names`);
  }
  const stranger = own.find(
    (name) => !available.some((profile) => profile.name === name),
  );
  if (stranger !== undefined) {
    throw new Error(
      `${flow.name}: unknown profile: ${stranger} (have: ${available.map((p) => p.name).join(', ')})`,
    );
  }
  return available.filter(
    (profile) =>
      own.includes(profile.name) &&
      (!profilesChosen || profiles.includes(profile)),
  );
}

/**
 * Turn what was asked for into the passes to run, in a stable order: flows as
 * discovered, profiles as configured. Targets naming the same flow and profile
 * share one pass, which runs as far as the furthest shot any of them wants.
 */
export function planPasses(
  flows: Flow[],
  config: Profiles,
  targets: Target[],
): Pass[] {
  const { available } = config;
  // Each flow's own profiles are checked whether or not a target uses them.
  const defaults = new Map(
    flows.map((flow) => [flow.name, profilesFor(flow, config)]),
  );
  if (targets.length === 0) {
    return flows.flatMap((flow) =>
      (defaults.get(flow.name) ?? []).map((profile) => ({ flow, profile })),
    );
  }

  const names = flows.map((flow) => flow.name);
  /** flow → profile → the shots wanted there, or null for the whole flow. */
  const wanted = new Map<string, Map<string, string[] | null>>();
  for (const target of targets) {
    const matched = matchFlows(names, target);
    if (matched.length === 0) {
      throw new Error(`no flow matches: ${formatTarget(target)}`);
    }
    if (target.shot !== null && matched.length > 1) {
      throw new Error(
        `${formatTarget(target)} names a shot but matches several flows: ${matched.join(', ')}`,
      );
    }
    let named: ResolvedProfile[] | null = null;
    if (target.profile !== null) {
      const profile = available.find((p) => p.name === target.profile);
      if (profile === undefined) {
        throw new Error(
          `unknown profile: ${target.profile} (have: ${available.map((p) => p.name).join(', ')})`,
        );
      }
      named = [profile];
    }
    for (const name of matched) {
      const profiles = named ?? defaults.get(name) ?? [];
      if (target.shot !== null) {
        const flow = flows.find((f) => f.name === name) as Flow;
        const have = shotsOf(flow.steps).map((shot) => shot.name);
        if (!have.includes(target.shot)) {
          throw new Error(
            `${name} has no shot called ${target.shot} (have: ${have.join(', ')})`,
          );
        }
      }
      const byProfile = wanted.get(name) ?? new Map<string, string[] | null>();
      wanted.set(name, byProfile);
      for (const profile of profiles) {
        const sofar = byProfile.get(profile.name);
        if (target.shot === null || sofar === null) {
          byProfile.set(profile.name, null);
        } else {
          byProfile.set(profile.name, [...(sofar ?? []), target.shot]);
        }
      }
    }
  }

  const passes: Pass[] = [];
  for (const flow of flows) {
    const byProfile = wanted.get(flow.name);
    if (byProfile === undefined) continue;
    for (const profile of available) {
      const shots = byProfile.get(profile.name);
      if (shots === undefined) continue;
      passes.push({
        flow:
          shots === null
            ? flow
            : { ...flow, steps: stepsThrough(flow.steps, shots) },
        profile,
      });
    }
  }
  return passes;
}

/**
 * The flows that sit closest to a source path: those inside it when it is a
 * directory that holds any, otherwise those in the nearest directory above it
 * that has flows of its own — the way a test is found for a file.
 * All paths absolute; `root` is where the search for flows began.
 */
export function nearestFlows<T extends { file: string }>(
  flows: T[],
  target: string,
  { isDirectory, root }: { isDirectory: boolean; root: string },
): T[] {
  const inside = (dir: string, file: string): boolean =>
    file.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
  const parent = (dir: string): string => dir.slice(0, dir.lastIndexOf('/'));

  if (isDirectory) {
    const within = flows.filter((flow) => inside(target, flow.file));
    if (within.length > 0) return within;
  }
  let dir = isDirectory ? target : parent(target);
  while (dir === root || inside(root, dir)) {
    const here = flows.filter((flow) => parent(flow.file) === dir);
    if (here.length > 0) return here;
    dir = parent(dir);
  }
  return [];
}
