import { describe, expect, it } from 'vitest';

import type { ResolvedProfile } from './config.js';
import type { Flow } from './flow.js';
import { nearestFlows, parseTarget, planPasses } from './targets.js';

const profile = (name: string): ResolvedProfile => ({
  name,
  device: null,
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 1,
  colorScheme: null,
  hasTouch: false,
});
const desktop = profile('desktop');
const phone = profile('phone');
const tablet = profile('tablet');
const profiles = {
  profiles: [desktop, phone],
  available: [desktop, tablet, phone],
};

const flow = (name: string, shots: string[]): Flow => ({
  name,
  file: `/repo/src/${name}.shots.ts`,
  steps: shots.flatMap((shot) => [{ click: `#${shot}` }, { shot }]),
});
/** A journey through a layout only the larger screens have. */
const wide: Flow = {
  ...flow('wide', ['panel']),
  profiles: ['tablet', 'desktop'],
};
const flows = [
  flow('cart', ['empty', 'full']),
  flow('checkout', ['address', 'payment', 'done']),
  flow('checkout-guest', ['email']),
];

const planned = (...targets: string[]): string[] =>
  planPasses(flows, profiles, targets.map(parseTarget)).map(
    (pass) =>
      `${pass.flow.name}@${pass.profile.name}:${pass.flow.steps.length}`,
  );

describe('parseTarget', () => {
  it('reads each form of address', () => {
    expect(parseTarget('checkout')).toEqual({
      flow: 'checkout',
      shot: null,
      profile: null,
    });
    expect(parseTarget('checkout/payment@phone')).toEqual({
      flow: 'checkout',
      shot: 'payment',
      profile: 'phone',
    });
    expect(parseTarget('checkout@phone').profile).toBe('phone');
  });

  it('rejects anything else, saying what an address looks like', () => {
    expect(() => parseTarget('a/b/c')).toThrow(/not a target: a\/b\/c/);
    expect(() => parseTarget('@phone')).toThrow(/not a target/);
  });
});

describe('planPasses', () => {
  it('runs every flow at every default profile when nothing is asked for', () => {
    expect(planned()).toHaveLength(6);
  });

  it('takes a whole name over the flows that merely contain it', () => {
    expect(planned('checkout')).toEqual([
      'checkout@desktop:6',
      'checkout@phone:6',
    ]);
    expect(planned('check')).toHaveLength(4);
  });

  it('runs a flow only as far as the shot asked for', () => {
    expect(planned('checkout/address@desktop')).toEqual(['checkout@desktop:2']);
  });

  it('shares a pass between targets, running to the furthest shot', () => {
    expect(
      planned('checkout/address@desktop', 'checkout/payment@desktop'),
    ).toEqual(['checkout@desktop:4']);
    expect(planned('checkout/address@desktop', 'checkout@desktop')).toEqual([
      'checkout@desktop:6',
    ]);
  });

  it('reaches a configured profile that is not run by default', () => {
    expect(planned('cart@tablet')).toEqual(['cart@tablet:4']);
  });

  it('keeps flows and profiles in their own order, whatever order was asked', () => {
    expect(planned('checkout@phone', 'cart@phone', 'cart@desktop')).toEqual([
      'cart@desktop:4',
      'cart@phone:4',
      'checkout@phone:6',
    ]);
  });

  it('runs a flow with profiles of its own at those, in the order configured', () => {
    const at = (config: object, ...targets: string[]): string[] =>
      planPasses(
        [flows[0] as Flow, wide],
        { ...profiles, ...config },
        targets.map(parseTarget),
      ).map((pass) => `${pass.flow.name}@${pass.profile.name}`);

    expect(at({})).toEqual([
      'cart@desktop',
      'cart@phone',
      'wide@desktop',
      'wide@tablet',
    ]);
    expect(at({}, 'wide/panel')).toEqual(['wide@desktop', 'wide@tablet']);
    // Asked for by name, any configured profile will do.
    expect(at({}, 'wide@phone')).toEqual(['wide@phone']);
    // The command line narrows: only the phone leaves this flow nothing.
    expect(at({ profiles: [phone], profilesChosen: true })).toEqual([
      'cart@phone',
    ]);
    expect(at({ profiles: [tablet], profilesChosen: true }, 'wide')).toEqual([
      'wide@tablet',
    ]);
  });

  it('refuses a flow whose own profiles are not configured ones', () => {
    const plan = (own: unknown) => () =>
      planPasses([{ ...wide, profiles: own as string[] }], profiles, []);

    expect(plan(['watch'])).toThrow(
      'wide: unknown profile: watch (have: desktop, tablet, phone)',
    );
    expect(plan('desktop')).toThrow(
      'wide: profiles takes a list of profile names',
    );
    expect(plan([])).toThrow('wide: profiles takes a list of profile names');
  });

  it('says what is there when a target names something that is not', () => {
    expect(() => planned('basket')).toThrow('no flow matches: basket');
    expect(() => planned('cart/half')).toThrow(
      'cart has no shot called half (have: empty, full)',
    );
    expect(() => planned('cart@watch')).toThrow(
      'unknown profile: watch (have: desktop, tablet, phone)',
    );
    expect(() => planned('c/empty')).toThrow(/matches several flows/);
  });
});

describe('nearestFlows', () => {
  const at = (file: string) => ({ file });
  const all = [
    at('/repo/src/app.shots.ts'),
    at('/repo/src/portfolio/portfolio.shots.ts'),
    at('/repo/src/portfolio/export/export.shots.ts'),
    at('/repo/src/settings/settings.shots.ts'),
  ];
  const near = (target: string, isDirectory = false): string[] =>
    nearestFlows(all, target, { isDirectory, root: '/repo/src' }).map((f) =>
      f.file.replace('/repo/src/', ''),
    );

  it('finds the flows beside a file', () => {
    expect(near('/repo/src/portfolio/table.component.ts')).toEqual([
      'portfolio/portfolio.shots.ts',
    ]);
  });

  it('climbs to the nearest directory that has any', () => {
    expect(near('/repo/src/portfolio/cards/risk/pill.component.ts')).toEqual([
      'portfolio/portfolio.shots.ts',
    ]);
    expect(near('/repo/src/shared/button.ts')).toEqual(['app.shots.ts']);
  });

  it('takes everything inside a directory', () => {
    expect(near('/repo/src/portfolio', true)).toEqual([
      'portfolio/portfolio.shots.ts',
      'portfolio/export/export.shots.ts',
    ]);
  });

  it('finds nothing outside where flows are searched for', () => {
    expect(near('/repo/tools/build.ts')).toEqual([]);
  });
});
