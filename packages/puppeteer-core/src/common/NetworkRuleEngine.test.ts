/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import {describe, it} from 'node:test';

import expect from 'expect';

import {PageEvent} from '../api/Page.js';
import {EventEmitter} from '../common/EventEmitter.js';
import {NetworkRuleEngine} from '../common/NetworkRuleEngine.js';
import {
  NetworkRuleAction,
  type NetworkRuleEngineOptions,
} from '../common/NetworkRules.js';

class FakePage extends EventEmitter<Record<string, unknown>> {
  interceptionEnabled = false;

  async setRequestInterception(value: boolean): Promise<void> {
    this.interceptionEnabled = value;
  }
}

class FakeRequest {
  #url: string;
  #method: string;
  #resourceType: string;
  #headers: Record<string, string>;
  handled = false;
  aborted = false;
  continued = false;
  respondedWith: unknown;

  constructor(
    url: string,
    init: {
      method?: string;
      resourceType?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    this.#url = url;
    this.#method = init.method ?? 'GET';
    this.#resourceType = init.resourceType ?? 'other';
    this.#headers = init.headers ?? {};
  }

  url(): string {
    return this.#url;
  }

  method(): string {
    return this.#method;
  }

  resourceType(): string {
    return this.#resourceType;
  }

  headers(): Record<string, string> {
    return this.#headers;
  }

  postData(): string | undefined {
    return undefined;
  }

  async fetchPostData(): Promise<string | undefined> {
    return undefined;
  }

  failure(): {errorText: string} | null {
    return null;
  }

  async abort(): Promise<void> {
    this.handled = true;
    this.aborted = true;
  }

  async continue(): Promise<void> {
    if (this.handled) {
      throw new Error('Request is already handled!');
    }
    this.handled = true;
    this.continued = true;
  }

  async respond(response: unknown): Promise<void> {
    this.handled = true;
    this.respondedWith = response;
  }
}

class FakeResponse {
  #request: FakeRequest;
  #body: Uint8Array;

  constructor(request: FakeRequest, body = new TextEncoder().encode('body')) {
    this.#request = request;
    this.#body = body;
  }

  request(): FakeRequest {
    return this.#request;
  }

  status(): number {
    return 200;
  }

  headers(): Record<string, string> {
    return {
      'set-cookie': 'sid=def',
      'x-resp': 'yes',
      'content-length': String(this.#body.byteLength),
    };
  }

  async content(): Promise<Uint8Array> {
    return this.#body;
  }

  async stream(): Promise<ReadableStream<Uint8Array>> {
    const body = this.#body;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit in two chunks to exercise the chunk-assembly path.
        const midpoint = Math.max(1, Math.floor(body.byteLength / 2));
        controller.enqueue(body.subarray(0, midpoint));
        controller.enqueue(body.subarray(midpoint));
        controller.close();
      },
    });
  }
}

async function createEngine(
  rules: NetworkRuleEngineOptions['rules'],
  options: Partial<NetworkRuleEngineOptions> = {},
): Promise<{engine: NetworkRuleEngine; page: FakePage}> {
  const page = new FakePage();
  const engine = new NetworkRuleEngine({rules, ...options});
  await engine.attach(page as never);
  return {engine, page};
}

async function emitRequest(
  page: FakePage,
  request: FakeRequest,
): Promise<void> {
  // The engine binds an async listener; await the microtask queue it settles
  // through by wrapping the synchronous emit in a resolved promise chain.
  page.emit(PageEvent.Request, request as never);
  await new Promise(resolve => {
    return setImmediate(resolve);
  });
}

async function emitResponse(
  page: FakePage,
  response: FakeResponse,
): Promise<void> {
  page.emit(PageEvent.Response, response as never);
  await new Promise(resolve => {
    return setImmediate(resolve);
  });
}

describe('NetworkRuleEngine', () => {
  it('indexes rules so later rules do not run once an earlier one matches', async () => {
    const {engine, page} = await createEngine([
      {name: 'first', action: NetworkRuleAction.Allow, url: '/a'},
      {name: 'second', action: NetworkRuleAction.Block, url: '/a'},
    ]);
    const request = new FakeRequest('https://example.com/a');
    await emitRequest(page, request);
    expect(request.continued).toBe(true);
    expect(request.aborted).toBe(false);
    expect(engine.stats().byRule[0]!.hits).toBe(1);
    expect(engine.stats().byRule[1]!.hits).toBe(0);
  });

  it('narrows candidates by method, resource type and host indexes', async () => {
    const {engine, page} = await createEngine([
      {
        name: 'post-images',
        action: NetworkRuleAction.Block,
        method: 'POST',
        resourceType: 'image',
        url: 'https://cdn.example.com/pic',
      },
      {
        name: 'get-documents',
        action: NetworkRuleAction.Block,
        method: 'GET',
        resourceType: 'document',
      },
    ]);

    const wrongType = new FakeRequest('https://cdn.example.com/pic.png', {
      method: 'POST',
      resourceType: 'xhr',
    });
    await emitRequest(page, wrongType);
    expect(wrongType.continued).toBe(true);

    const wrongHost = new FakeRequest('https://evil.example.com/pic', {
      method: 'POST',
      resourceType: 'image',
    });
    await emitRequest(page, wrongHost);
    expect(wrongHost.continued).toBe(true);

    const matching = new FakeRequest('https://cdn.example.com/pic.png', {
      method: 'POST',
      resourceType: 'image',
    });
    await emitRequest(page, matching);
    expect(matching.aborted).toBe(true);
    expect(engine.stats().unmatched).toBe(2);
    expect(engine.stats().matched).toBe(1);
  });

  it('memoizes match results across repeated URLs without rescanning rules', async () => {
    const {engine, page} = await createEngine([
      {name: 'block', action: NetworkRuleAction.Block, url: '/same'},
    ]);
    for (let i = 0; i < 50; i++) {
      const request = new FakeRequest('https://example.com/same');
      await emitRequest(page, request);
      expect(request.aborted).toBe(true);
    }
    expect(engine.stats().byRule[0]!.hits).toBe(50);

    const other = new FakeRequest('https://example.com/different');
    await emitRequest(page, other);
    expect(other.continued).toBe(true);
    expect(engine.stats().unmatched).toBe(1);
  });

  it('counts every request and keeps unmatched traffic on the allow path', async () => {
    const {engine, page} = await createEngine(
      [
        {
          action: NetworkRuleAction.Record,
        },
      ],
      {maxMatchCacheEntries: 5, maxRecordedRequests: 3},
    );

    for (let i = 0; i < 20; i++) {
      const request = new FakeRequest(`https://example.com/r/${i}`);
      await emitRequest(page, request);
      expect(request.continued).toBe(true);
    }
    expect(engine.stats().totalRequests).toBe(20);
    expect(engine.stats().matched).toBe(20);
  });

  it('fails open and records a diagnostic when an action throws', async () => {
    const {engine, page} = await createEngine([
      {
        name: 'broken-fulfill',
        action: NetworkRuleAction.Fulfill,
        url: '/broken',
        response: {body: 'x'},
      },
    ]);
    const request = new FakeRequest('https://example.com/broken');
    request.respond = async () => {
      throw new Error('boom');
    };
    await emitRequest(page, request);
    expect(request.continued).toBe(true);
    expect(engine.stats().failedOpen).toBe(1);
    expect(engine.lastError).toContain('boom');
    expect(engine.getErrors()[0]!).toContain('broken-fulfill');
  });

  it('sanitizes sensitive headers from records', async () => {
    const {engine, page} = await createEngine([
      {action: NetworkRuleAction.Record, url: '/secret'},
    ]);
    const request = new FakeRequest('https://example.com/secret', {
      headers: {
        authorization: 'Bearer token',
        cookie: 'sid=abc',
        'x-ok': 'kept',
      },
    });
    await emitRequest(page, request);
    await emitResponse(page, new FakeResponse(request));
    const record = engine.records()[0]!;
    expect(record.requestHeaders['authorization']).toBeUndefined();
    expect(record.requestHeaders['cookie']).toBeUndefined();
    expect(record.requestHeaders['x-ok']).toBe('kept');
    expect(record.responseHeaders!['set-cookie']).toBeUndefined();
    expect(record.responseHeaders!['x-resp']).toBe('yes');
  });

  it('truncates recorded bodies to the configured byte limit', async () => {
    const {engine, page} = await createEngine(
      [{action: NetworkRuleAction.Record, url: '/large'}],
      {maxBodyBytes: 4},
    );
    const request = new FakeRequest('https://example.com/large');
    await emitRequest(page, request);
    await emitResponse(
      page,
      new FakeResponse(request, new TextEncoder().encode('1234567890')),
    );
    const record = engine.records()[0]!;
    expect(record.responseBody!.truncated).toBe(true);
    expect(record.responseBody!.data.byteLength).toBe(4);
    expect(record.responseBody!.originalLength).toBe(10);
  });

  it('aborts in-flight work and stops handling events on detach', async () => {
    const page = new FakePage();
    const engine = new NetworkRuleEngine({
      rules: [{action: NetworkRuleAction.Block, url: '/a'}],
    });
    await engine.attach(page as never);
    expect(page.interceptionEnabled).toBe(true);
    await engine.detach();
    expect(page.interceptionEnabled).toBe(false);
    expect(page.listenerCount(PageEvent.Request)).toBe(0);
    expect(page.listenerCount(PageEvent.Response)).toBe(0);
    expect(page.listenerCount(PageEvent.Close)).toBe(0);

    // Detaching again is a no-op.
    await engine.detach();
  });

  it('rejects engines without a rules array and non-positive bounds', () => {
    expect(() => {
      return new NetworkRuleEngine({} as NetworkRuleEngineOptions);
    }).toThrow();
    expect(() => {
      return new NetworkRuleEngine({rules: [], maxBodyBytes: 0});
    }).toThrow();
  });
});
