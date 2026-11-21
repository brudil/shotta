import { EventEmitter } from 'node:events';

import type { Page, Request } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trackNetwork } from './settle.js';

/** As much of a page as the tracker listens to. */
class FakePage extends EventEmitter {
  readonly frame = { url: () => this.url };
  url = 'http://app.test/';
  mainFrame() {
    return this.frame;
  }

  request(url: string, { type = 'fetch', navigation = false } = {}): Request {
    const request = {
      url: () => url,
      resourceType: () => type,
      isNavigationRequest: () => navigation,
      frame: () => this.frame,
    } as unknown as Request;
    this.emit('request', request);
    return request;
  }

  /** The main frame arrives at an address: a new document, or a pushState. */
  arrive(url: string): void {
    this.url = url;
    this.emit('framenavigated', this.frame);
  }
}

const QUIET_FOR = 500;

describe('trackNetwork', () => {
  let page: FakePage;
  const track = (ignore: (string | RegExp)[] = []) =>
    trackNetwork(page as unknown as Page, ignore);

  beforeEach(() => {
    vi.useFakeTimers();
    page = new FakePage();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is quiet once nothing has been in flight for a while', () => {
    const network = track();
    const items = page.request('http://app.test/api/items');
    vi.advanceTimersByTime(QUIET_FOR);

    expect(network.quiet()).toBe(false);
    expect(network.pending()).toEqual(['http://app.test/api/items']);

    page.emit('requestfinished', items);

    expect(network.quiet()).toBe(false);
    vi.advanceTimersByTime(QUIET_FOR);
    expect(network.quiet()).toBe(true);
  });

  it('never waits for a socket, an event stream or a request the project ignores', () => {
    const network = track(['/api/ping', /telemetry/]);
    page.request('ws://app.test/live', { type: 'websocket' });
    page.request('http://app.test/api/events', { type: 'eventsource' });
    page.request('http://app.test/api/ping');
    page.request('http://app.test/telemetry/beat');
    vi.advanceTimersByTime(QUIET_FOR);

    expect(network.quiet()).toBe(true);
  });

  it('stops waiting for what has outlasted a settle, and only for that', () => {
    const network = track();
    page.request('http://app.test/api/stream');
    vi.advanceTimersByTime(1_000);
    const since = Date.now();
    vi.advanceTimersByTime(1_000);
    page.request('http://app.test/api/items');

    network.abandon(since);

    expect(network.pending()).toEqual(['http://app.test/api/items']);
  });

  it('drops the requests of a document that has been replaced', () => {
    const network = track();
    // Begun as the page unloads: the browser reports no end for it.
    page.request('http://app.test/api/workspace');
    const next = page.request('http://app.test/about', {
      type: 'document',
      navigation: true,
    });
    page.arrive('http://app.test/about');

    expect(network.pending()).toEqual(['http://app.test/about']);

    page.emit('requestfinished', next);
    vi.advanceTimersByTime(QUIET_FOR);
    expect(network.quiet()).toBe(true);
  });

  it('follows a redirect to the document that arrives', () => {
    const network = track();
    page.request('http://app.test/api/workspace');
    page.request('http://app.test/auth?t=1', {
      type: 'document',
      navigation: true,
    });
    page.request('http://app.test/', { type: 'document', navigation: true });
    page.arrive('http://app.test/#top');

    expect(network.pending()).not.toContain('http://app.test/api/workspace');
  });

  it('keeps the requests in flight across a navigation within the document', () => {
    const network = track();
    const first = page.request('http://app.test/', {
      type: 'document',
      navigation: true,
    });
    page.arrive('http://app.test/');
    page.emit('requestfinished', first);
    // A click that fetches, then pushes a route.
    page.request('http://app.test/api/items');
    page.arrive('http://app.test/items');

    expect(network.pending()).toEqual(['http://app.test/api/items']);
  });
});
