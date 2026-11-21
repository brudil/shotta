import { describe, expect, it } from 'vitest';

import {
  type ActionStep,
  checkSteps,
  describeStep,
  hasMotion,
  routesOf,
  type Step,
  shotsOf,
  stepsThrough,
  walk,
} from './flow.js';

describe('walk', () => {
  it('flattens chapters, tagging each step with the chapter it sits in', () => {
    const steps: Step[] = [
      { goto: '/' },
      { annotate: 'Open the menu', steps: [{ click: 'text=Menu' }] },
      { shot: 'done' },
    ];

    expect([...walk(steps)]).toEqual([
      { step: { goto: '/' }, chapter: null },
      { step: { click: 'text=Menu' }, chapter: 'Open the menu' },
      { step: { shot: 'done' }, chapter: null },
    ]);
  });
});

describe('hasMotion', () => {
  it('is false for a flow that only loads a route and shoots it', () => {
    expect(
      hasMotion([{ goto: '/' }, { wait: 'main' }, { shot: 'ready' }]),
    ).toBe(false);
  });

  it('is true once a step inside a chapter moves something', () => {
    expect(
      hasMotion([
        { goto: '/' },
        { annotate: 'Open', steps: [{ click: 'text=Open' }] },
      ]),
    ).toBe(true);
  });
});

describe('describeStep', () => {
  it('names a run step by its label', () => {
    expect(describeStep({ run: async () => {}, label: 'seed the cart' })).toBe(
      'run seed the cart',
    );
    expect(describeStep({ run: async () => {} })).toBe('run');
  });

  it('quotes typed text so whitespace is visible', () => {
    expect(describeStep({ type: 'a b', into: '#name' })).toBe(
      'type "a b" into #name',
    );
  });
});

describe('describeStep, for a project step', () => {
  it('names it with its value, cut short', () => {
    const step = { login: { as: 'admin' } } as unknown as ActionStep;

    expect(describeStep(step)).toBe('login {"as":"admin"}');
  });
});

describe('checkSteps', () => {
  it('passes a flow written as data, chapters and all', () => {
    const steps = [
      { goto: '/' },
      { type: 'Ada', into: '#name', delay: 10 },
      { annotate: 'Save', steps: [{ click: 'text=Save' }, { shot: 'saved' }] },
      { scroll: 400 },
      { wait: '#done' },
    ];

    expect(checkSteps(steps)).toBe(steps);
  });

  it('says where a misspelt step is and what it could have been', () => {
    expect(() => checkSteps([{ goto: '/' }, { clik: '#save' }])).toThrow(
      'steps[1]: not a step: {"clik":"#save"} (have: goto, click, hover, type, scroll, press, wait, shot, run)',
    );
  });

  it('points inside a chapter', () => {
    expect(() =>
      checkSteps([{ annotate: 'Save', steps: [{ click: '#a' }, { shot: 7 }] }]),
    ).toThrow(/^steps\[0\]\.steps\[1\]: shot takes a name/);
  });

  it('rejects a key the step does not take', () => {
    expect(() => checkSteps([{ click: '#a', into: '#b' }])).toThrow(
      'steps[0]: a click step has no "into"',
    );
  });

  it('requires a field to type into', () => {
    expect(() => checkSteps([{ type: 'Ada' }])).toThrow(
      'steps[0]: type needs "into", the field\'s selector',
    );
  });

  it('rejects a shot name that would not make a filename', () => {
    expect(() => checkSteps([{ shot: 'a/b' }])).toThrow(/shot takes a name/);
  });

  it('rejects two steps in one object', () => {
    expect(() => checkSteps([{ click: '#a', shot: 'b' }])).toThrow(
      /steps\[0\]: more than one step/,
    );
  });

  it('accepts a project step only once the project has named it', () => {
    const steps = [{ login: { as: 'admin' } }];

    expect(() => checkSteps(steps)).toThrow(/not a step/);
    expect(checkSteps(steps, ['login'])).toBe(steps);
  });

  it('rejects a chapter inside a chapter', () => {
    expect(() =>
      checkSteps([{ annotate: 'A', steps: [{ annotate: 'B', steps: [] }] }]),
    ).toThrow('steps[0].steps[0]: a chapter cannot hold another chapter');
  });
});

describe('stepsThrough', () => {
  const steps: Step[] = [
    { goto: '/' },
    { shot: 'home' },
    {
      annotate: 'Save',
      steps: [{ click: '#save' }, { shot: 'saved' }, { click: '#undo' }],
    },
    { goto: '/about' },
    { shot: 'about' },
  ];

  it('stops after the shot asked for, cutting its chapter short', () => {
    expect(stepsThrough(steps, ['saved'])).toEqual([
      { goto: '/' },
      { shot: 'home' },
      { annotate: 'Save', steps: [{ click: '#save' }, { shot: 'saved' }] },
    ]);
  });

  it('runs as far as the last of several', () => {
    expect(stepsThrough(steps, ['home', 'saved'])).toHaveLength(3);
    expect(stepsThrough(steps, ['about'])).toEqual(steps);
  });
});

describe('what a flow shows', () => {
  const steps: Step[] = [
    { goto: '/cart' },
    { shot: 'cart', shows: 'Two items and a total' },
    { annotate: 'Pay', steps: [{ goto: '/pay' }, { shot: 'paid' }] },
    { goto: '/cart' },
  ];

  it('lists its shots with what each claims', () => {
    expect(shotsOf(steps)).toEqual([
      { name: 'cart', shows: 'Two items and a total', chapter: null },
      { name: 'paid', shows: null, chapter: 'Pay' },
    ]);
  });

  it('lists its routes once each', () => {
    expect(routesOf(steps)).toEqual(['/cart', '/pay']);
  });

  it('accepts shows on a shot and nowhere else', () => {
    expect(() => checkSteps([{ shot: 'a', shows: 'b' }])).not.toThrow();
    expect(() => checkSteps([{ shot: 'a', shows: 3 }])).toThrow(
      'steps[0]: shows takes a sentence',
    );
    expect(() => checkSteps([{ click: '#a', shows: 'b' }])).toThrow(
      'steps[0]: a click step has no "shows"',
    );
  });
});

describe('what a shot is of', () => {
  it('can be one element or the viewport, but not both', () => {
    expect(() =>
      checkSteps([
        { shot: 'card', of: '[data-testid=card]' },
        { shot: 'fold', viewport: true },
      ]),
    ).not.toThrow();
    expect(() => checkSteps([{ shot: 'a', of: '#a', viewport: true }])).toThrow(
      'steps[0]: a shot is of an element or of the viewport, not both',
    );
    expect(() => checkSteps([{ shot: 'a', of: '' }])).toThrow(
      'steps[0]: of takes the selector of the element to shoot',
    );
  });

  it('has a name no other shot in the flow has, since it is its address', () => {
    expect(() =>
      checkSteps([
        { shot: 'open' },
        { annotate: 'Again', steps: [{ click: '#a' }, { shot: 'open' }] },
      ]),
    ).toThrow('steps[1].steps[1]: this flow already has a shot called open');
  });
});
