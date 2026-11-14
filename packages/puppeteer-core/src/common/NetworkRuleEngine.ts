/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {HTTPRequest} from '../api/HTTPRequest.js';
import type {HTTPResponse} from '../api/HTTPResponse.js';
import {PageEvent, type Page} from '../api/Page.js';
import {Deferred} from '../util/Deferred.js';

import {
  NetworkRuleAction,
  type NetworkRule,
  type NetworkRuleEngineOptions,
  type NetworkRuleRecord,
  type NetworkRuleRecordedBody,
  type NetworkRuleStats,
} from './NetworkRules.js';

const DEFAULT_MAX_RECORDED_REQUESTS = 100;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_MATCH_CACHE = 1000;
const DEFAULT_RETRY_ATTEMPTS = 1;
const DEFAULT_RETRY_STATUS = 500;
const DEFAULT_RETRY_TIMEOUT = 10_000;
const MAX_DIAGNOSTIC_ENTRIES = 100;
const BODY_CAPTURE_TIMEOUT = 10_000;
const BODY_READ_IDLE_TIMEOUT = 3_000;

/**
 * Headers that must never be retained by record rules because they carry
 * credentials or sensitive session material.
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

/**
 * Bounded insertion-ordered cache. The least recently used entry is evicted
 * once the capacity is reached.
 */
class LRUCache<K, V> {
  readonly capacity: number;
  #map = new Map<K, V>();

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.capacity) {
      const oldestKey = this.#map.keys().next().value as K | undefined;
      if (oldestKey !== undefined) {
        this.#map.delete(oldestKey);
      }
    }
    this.#map.set(key, value);
  }

  clear(): void {
    this.#map.clear();
  }
}

interface CompiledRule {
  index: number;
  rule: NetworkRule;
  name: string;
  hasHeaderMatcher: boolean;
  hasStatusMatcher: boolean;
  host?: string;
}

/**
 * A reusable, declarative network rule engine attached to a {@link Page}.
 *
 * @remarks
 *
 * Rules are evaluated in declaration order and the first matching rule wins.
 * Rule lookup uses indexes on method, resource type and URL host instead of
 * scanning every rule for every request; match results are additionally
 * memoized in bounded caches.
 *
 * Whenever the engine itself fails (for example a retry body exceeds the
 * memory bound), the request is allowed to proceed unchanged and the error is
 * retained in {@link NetworkRuleEngine.getErrors}.
 *
 * @public
 */
export class NetworkRuleEngine {
  #rules: NetworkRule[];
  #compiled: CompiledRule[] = [];
  readonly #maxRecordedRequests: number;
  readonly #maxBodyBytes: number;

  /** Per-request memo; entries are collected once the request is GC'd. */
  readonly #requestMemo = new WeakMap<HTTPRequest, number>();
  /** Requests already re-evaluated once the response status arrived. */
  readonly #responseEvaluated = new WeakSet<HTTPRequest>();
  /** LRU fast path, only used when no rule matches on headers. */
  readonly #keyCache: LRUCache<string, number>;
  readonly #hasHeaderRules: boolean;
  readonly #hasStatusRules: boolean;

  // Rule indexes keyed by the cheap match dimensions.
  readonly #byResourceType = new Map<string, Set<number>>();
  readonly #byMethod = new Map<string, Set<number>>();
  readonly #byHost = new Map<string, Set<number>>();
  readonly #noResourceType = new Set<number>();
  readonly #noMethod = new Set<number>();
  readonly #noHost = new Set<number>();

  #records: NetworkRuleRecord[] = [];
  readonly #pendingRecords = new WeakMap<HTTPRequest, NetworkRuleRecord>();
  readonly #inFlightRetries = new Set<AbortController>();

  #totalRequests = 0;
  #matched = 0;
  #unmatched = 0;
  #failedOpen = 0;
  readonly #ruleHits = new Map<number, number>();
  readonly #actionHits = new Map<string, number>();
  #errors: string[] = [];
  #lastError: string | null = null;

  #page: Page | null = null;
  #closed = false;
  #attached = false;

  constructor(options: NetworkRuleEngineOptions) {
    if (!options || !Array.isArray(options.rules)) {
      throw new TypeError('NetworkRuleEngine requires a "rules" array.');
    }
    this.#rules = options.rules;
    this.#maxRecordedRequests =
      options.maxRecordedRequests ?? DEFAULT_MAX_RECORDED_REQUESTS;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#keyCache = new LRUCache(
      options.maxMatchCacheEntries ?? DEFAULT_MAX_MATCH_CACHE,
    );
    if (this.#maxRecordedRequests < 1 || this.#maxBodyBytes < 1) {
      throw new RangeError(
        'maxRecordedRequests and maxBodyBytes must be positive numbers.',
      );
    }
    this.#compile();
    this.#hasHeaderRules = this.#compiled.some(rule => {
      return rule.hasHeaderMatcher;
    });
    this.#hasStatusRules = this.#compiled.some(rule => {
      return rule.hasStatusMatcher;
    });
  }

  #compile(): void {
    this.#rules.forEach((rule, index) => {
      if (!rule || typeof rule !== 'object') {
        throw new TypeError(`Rule at index ${index} is not an object.`);
      }
      if (!Object.values(NetworkRuleAction).includes(rule.action)) {
        throw new TypeError(
          `Rule at index ${index} has an unknown action "${String(rule.action)}".`,
        );
      }
      if (rule.action === NetworkRuleAction.Fulfill && !rule.response) {
        throw new TypeError(
          `Fulfill rule at index ${index}${rule.name ? ` ("${rule.name}")` : ''} must define a "response".`,
        );
      }
      if (rule.retry?.maxAttempts !== undefined && rule.retry.maxAttempts < 1) {
        throw new RangeError(
          `Retry rule at index ${index} requires maxAttempts >= 1.`,
        );
      }
      if (
        rule.status !== undefined &&
        (rule.action === NetworkRuleAction.Block ||
          rule.action === NetworkRuleAction.Fulfill ||
          rule.action === NetworkRuleAction.Retry)
      ) {
        throw new TypeError(
          `Rule at index ${index}: the "status" matcher is only supported ` +
            'with the "record" and "allow" actions, because response status ' +
            'is not known when the request is paused.',
        );
      }
      if (rule.url !== undefined && typeof rule.url !== 'string') {
        if (!(rule.url instanceof RegExp)) {
          throw new TypeError(
            `Rule at index ${index}: "url" must be a string or RegExp.`,
          );
        }
      }

      const compiled: CompiledRule = {
        index,
        rule,
        name: rule.name ?? `rule[${index}]`,
        hasHeaderMatcher:
          Array.isArray(rule.headers) && rule.headers.length > 0,
        hasStatusMatcher: rule.status !== undefined,
      };
      if (typeof rule.url === 'string') {
        try {
          compiled.host = new URL(rule.url).host;
        } catch {
          // The pattern is a path or substring, it cannot contribute a host.
        }
      }
      this.#compiled.push(compiled);

      if (rule.resourceType === undefined) {
        this.#noResourceType.add(index);
      } else {
        for (const type of this.#asArray(rule.resourceType)) {
          this.#add(this.#byResourceType, type, index);
        }
      }
      if (rule.method === undefined) {
        this.#noMethod.add(index);
      } else if (typeof rule.method === 'string') {
        this.#add(this.#byMethod, rule.method.toUpperCase(), index);
      }
      if (compiled.host === undefined) {
        this.#noHost.add(index);
      } else {
        this.#add(this.#byHost, compiled.host, index);
      }
    });
  }

  #add(map: Map<string, Set<number>>, key: string, index: number): void {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(index);
  }

  #asArray<T>(value: T | T[]): T[] {
    return Array.isArray(value) ? value : [value];
  }

  /**
   * Enables request interception on the page and starts applying the rules.
   * Safe to call once per engine instance.
   */
  async attach(page: Page): Promise<void> {
    if (this.#attached) {
      throw new Error('This NetworkRuleEngine is already attached.');
    }
    this.#page = page;
    this.#attached = true;
    page.on(PageEvent.Request, this.#onRequest);
    page.on(PageEvent.Response, this.#onResponse);
    page.on(PageEvent.RequestFailed, this.#onRequestFailed);
    page.on(PageEvent.Close, this.#onClose);
    await page.setRequestInterception(true);
  }

  /**
   * Stops applying rules, aborts in-flight retries and restores the page's
   * default interception behavior.
   */
  async detach(): Promise<void> {
    const page = this.#page;
    if (!page || !this.#attached) {
      return;
    }
    this.#attached = false;
    this.#closed = true;
    page.off(PageEvent.Request, this.#onRequest);
    page.off(PageEvent.Response, this.#onResponse);
    page.off(PageEvent.RequestFailed, this.#onRequestFailed);
    page.off(PageEvent.Close, this.#onClose);
    for (const controller of this.#inFlightRetries) {
      controller.abort();
    }
    this.#inFlightRetries.clear();
    this.#keyCache.clear();
    try {
      await page.setRequestInterception(false);
    } catch (error) {
      // The page may already be closed; nothing to restore.
      this.#recordError(
        `Failed to disable request interception on detach: ${this.#errorMessage(error)}`,
      );
    }
    this.#page = null;
  }

  /**
   * Returns a snapshot of the hit counters.
   */
  stats(): NetworkRuleStats {
    const byRule = this.#compiled.map(compiled => {
      return {
        name: compiled.name,
        hits: this.#ruleHits.get(compiled.index) ?? 0,
      };
    });
    return {
      totalRequests: this.#totalRequests,
      matched: this.#matched,
      unmatched: this.#unmatched,
      failedOpen: this.#failedOpen,
      byRule,
      byAction: Object.fromEntries(this.#actionHits),
    };
  }

  /**
   * Returns a snapshot of the records produced by `record` rules. The array
   * never exceeds the configured `maxRecordedRequests`.
   */
  records(): NetworkRuleRecord[] {
    return [...this.#records];
  }

  /** Removes all retained records. */
  clearRecords(): void {
    this.#records = [];
  }

  /**
   * Resolves once at least `count` records have been published, or after the
   * given timeout. Useful in tests and scrapers that need to wait for the
   * asynchronous response/body capture to finish.
   */
  async waitForRecords(
    count = 1,
    timeout = 5000,
  ): Promise<NetworkRuleRecord[]> {
    const deadline = Date.now() + timeout;
    while (this.#records.length < count && Date.now() < deadline) {
      await new Promise(resolve => {
        return setTimeout(resolve, 20);
      });
      if (this.#closed && this.#records.length < count) {
        break;
      }
    }
    return this.records();
  }

  /**
   * Diagnostic messages collected while handling requests, oldest first.
   * Bounded to the last 100 entries.
   */
  getErrors(): string[] {
    return [...this.#errors];
  }

  /** The most recent diagnostic message, if any. */
  get lastError(): string | null {
    return this.#lastError;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  #onClose = (): void => {
    this.#closed = true;
    for (const controller of this.#inFlightRetries) {
      controller.abort();
    }
    this.#inFlightRetries.clear();
    this.#keyCache.clear();
  };

  #onRequest = async (request: HTTPRequest): Promise<void> => {
    if (this.#closed) {
      return;
    }
    this.#totalRequests++;
    const match = this.#matchRequest(request);
    if (match === undefined) {
      this.#unmatched++;
      await this.#safeContinue(request);
      return;
    }
    const [compiled] = match;
    this.#countHit(compiled);
    try {
      switch (compiled.rule.action) {
        case NetworkRuleAction.Block:
          await request.abort();
          return;
        case NetworkRuleAction.Allow:
          await this.#safeContinue(request);
          return;
        case NetworkRuleAction.Fulfill:
          await this.#fulfill(request, compiled.rule);
          return;
        case NetworkRuleAction.Record:
          this.#startRecord(request, compiled);
          await this.#safeContinue(request);
          return;
        case NetworkRuleAction.Retry:
          await this.#retry(request, compiled);
          return;
      }
    } catch (error) {
      this.#failOpen(request, compiled, error);
    }
  };

  #onResponse = async (response: HTTPResponse): Promise<void> => {
    if (this.#closed) {
      return;
    }
    const request = response.request();
    const pending = this.#pendingRecords.get(request);
    // Request-stage record rules already own this exchange, so status-gated
    // rules must not create a second record for it.
    const statusMatch = pending
      ? undefined
      : this.#matchResponse(request, response);
    if (!pending && !statusMatch) {
      return;
    }
    try {
      if (statusMatch) {
        const [compiled] = statusMatch;
        this.#countHit(compiled);
        this.#startRecord(request, compiled);
      }
      const record = this.#pendingRecords.get(request);
      if (record) {
        record.status = response.status();
        record.responseHeaders = this.#sanitizeHeaders(response.headers());
        const declaredLength = Number(record.responseHeaders['content-length']);
        record.responseBody = await this.#captureBody(
          response,
          record.responseHeaders['content-encoding'],
          Number.isFinite(declaredLength) ? declaredLength : undefined,
        );
        this.#publishRecord(request, record);
      }
    } catch (error) {
      const record = this.#pendingRecords.get(request);
      if (record) {
        record.error = this.#errorMessage(error);
        this.#publishRecord(request, record);
      }
      this.#recordError(
        `Failed to record response for ${request.url()}: ${this.#errorMessage(error)}`,
      );
    }
  };

  #onRequestFailed = async (request: HTTPRequest): Promise<void> => {
    if (this.#closed) {
      return;
    }
    const record = this.#pendingRecords.get(request);
    if (record) {
      record.failure = request.failure()?.errorText ?? 'unknown failure';
      this.#publishRecord(request, record);
    }
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async #fulfill(request: HTTPRequest, rule: NetworkRule): Promise<void> {
    const response = rule.response!;
    const headers: Record<string, string> = {...(response.headers ?? {})};
    // Chromium rejects `Fetch.fulfillRequest` for subresource fetches when
    // the synthesized response carries no CORS metadata. Since the response
    // is deliberately produced for this page, mirror the requesting origin
    // unless the rule already provides an explicit allow-origin header.
    const hasCorsHeader = Object.keys(headers).some(key => {
      return key.toLowerCase() === 'access-control-allow-origin';
    });
    if (!hasCorsHeader) {
      try {
        headers['access-control-allow-origin'] = new URL(request.url()).origin;
      } catch {
        headers['access-control-allow-origin'] = '*';
      }
    }
    await request.respond({
      status: response.status ?? 200,
      headers,
      contentType: response.contentType ?? 'text/plain',
      body: response.body ?? '',
    });
  }

  /**
   * Re-issues the request from Node.js while the browser request is paused.
   * If every attempt fails, the browser is allowed to make the request
   * natively. Bodies larger than the configured limit are not buffered.
   */
  async #retry(request: HTTPRequest, compiled: CompiledRule): Promise<void> {
    const options = compiled.rule.retry ?? {};
    const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    const retryOnStatus = options.retryOnStatus ?? DEFAULT_RETRY_STATUS;
    const timeout = options.timeout ?? DEFAULT_RETRY_TIMEOUT;
    const delay = options.delay ?? 0;

    const controller = new AbortController();
    this.#inFlightRetries.add(controller);
    let lastResponse: Response | null = null;
    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.#closed || controller.signal.aborted) {
          await this.#safeContinue(request);
          return;
        }
        if (delay > 0 && attempt > 1) {
          await this.#delay(delay, controller.signal);
        }
        const attemptController = new AbortController();
        const onParentAbort = (): void => {
          attemptController.abort();
        };
        controller.signal.addEventListener('abort', onParentAbort, {
          once: true,
        });
        const attemptTimer = setTimeout(() => {
          attemptController.abort();
        }, timeout);
        try {
          const response = await this.#fetchAttempt(
            request,
            attemptController.signal,
          );
          if (response.status < retryOnStatus) {
            lastResponse = response;
            break;
          }
          lastResponse = response;
          lastError = new Error(
            `Retry attempt ${attempt} received status ${response.status}`,
          );
          // Drain so the socket can be reused.
          await response.arrayBuffer().catch(() => {});
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(attemptTimer);
          controller.signal.removeEventListener('abort', onParentAbort);
        }
      }

      if (!lastResponse) {
        throw lastError instanceof Error
          ? lastError
          : new Error('All retry attempts failed without a response.');
      }

      const buffer = new Uint8Array(await lastResponse.arrayBuffer());
      if (buffer.byteLength > this.#maxBodyBytes) {
        throw new Error(
          `Retried response body (${buffer.byteLength} bytes) exceeds maxBodyBytes (${this.#maxBodyBytes}); falling back to the native request.`,
        );
      }
      const headers: Record<string, string> = {};
      lastResponse.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-encoding') {
          headers[key] = value;
        }
      });
      await request.respond({
        status: lastResponse.status,
        headers,
        contentType: lastResponse.headers.get('content-type') ?? 'text/plain',
        body: buffer,
      });
    } catch (error) {
      this.#recordError(
        `Retry failed for ${request.url()}: ${this.#errorMessage(error)}`,
      );
      this.#failOpen(request, compiled, error, /* alreadyCounted */ true);
    } finally {
      this.#inFlightRetries.delete(controller);
    }
  }

  async #fetchAttempt(
    request: HTTPRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers())) {
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'content-length') {
        // The runtime sets these itself.
        continue;
      }
      headers[key] = value;
    }
    // Retries may follow a destroyed connection. Forbid keep-alive so the
    // runtime opens a fresh socket instead of reusing a pooled dead one.
    headers['connection'] = 'close';
    const init: RequestInit = {
      method: request.method(),
      headers,
      signal,
      // Never follow redirects silently: report each final status honestly.
      redirect: 'follow',
    };
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      const postData = await request.fetchPostData().catch(() => {
        return undefined;
      });
      if (postData !== undefined) {
        init.body = postData;
      }
    }
    return await fetch(request.url(), init);
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  #startRecord(request: HTTPRequest, compiled: CompiledRule): void {
    const record: NetworkRuleRecord = {
      ruleName: compiled.rule.name,
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      requestHeaders: this.#sanitizeHeaders(request.headers()),
      timestamp: Date.now(),
    };
    const postData = request.postData();
    if (postData !== undefined) {
      record.requestBody = this.#truncate(
        new TextEncoder().encode(postData),
        undefined,
      );
    }
    this.#pendingRecords.set(request, record);
  }

  #publishRecord(request: HTTPRequest, record: NetworkRuleRecord): void {
    this.#pendingRecords.delete(request);
    if (this.#records.length >= this.#maxRecordedRequests) {
      this.#records.shift();
    }
    this.#records.push(record);
  }

  /**
   * Captures a response body without ever buffering more than
   * `maxBodyBytes`. The streaming path is preferred because, under request
   * interception, `HTTPResponse.content()` can wait on a body-loaded signal
   * that never arrives for some subresources; the dedicated response stream
   * does not depend on it. Every path is bounded by a timeout so a stalled
   * body cannot block the record from being published.
   */
  async #captureBody(
    response: HTTPResponse,
    encoding: string | undefined,
    declaredLength?: number,
  ): Promise<NetworkRuleRecordedBody | undefined> {
    try {
      const body = await this.#withTimeout(
        this.#readBoundedBody(response, declaredLength),
        BODY_CAPTURE_TIMEOUT,
      );
      return this.#truncate(body, encoding, declaredLength);
    } catch (error) {
      this.#recordError(`Body capture failed: ${this.#errorMessage(error)}`);
      return undefined;
    }
  }

  async #readBoundedBody(
    response: HTTPResponse,
    declaredLength?: number,
  ): Promise<Uint8Array> {
    const stream = await response.stream();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    // Read one byte beyond the cap so truncation can be detected, then stop
    // pulling: the rest of the stream is cancelled and never buffered.
    const limit = this.#maxBodyBytes + 1;
    try {
      for (;;) {
        // Bound every individual read: some intercepted CDP streams deliver
        // all their bytes but never signal the end of stream, so an unbounded
        // `read()` would hang forever. An idle timeout treats a quiet stream
        // as complete once at least one byte (or a known-length body) arrived.
        const {done, value} = await this.#withTimeout(
          reader.read(),
          BODY_READ_IDLE_TIMEOUT,
        );
        if (done) {
          break;
        }
        const remaining = limit - total;
        if (remaining <= 0) {
          break;
        }
        const chunk =
          value.byteLength > remaining ? value.subarray(0, remaining) : value;
        chunks.push(chunk);
        total += chunk.byteLength;
        // Stop as soon as the buffering cap or the declared body length is
        // reached; the remaining stream is cancelled below.
        if (
          total >= limit ||
          (declaredLength !== undefined && total >= declaredLength)
        ) {
          break;
        }
      }
      return this.#concat(chunks, total);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  #concat(chunks: Uint8Array[], total: number): Uint8Array {
    if (chunks.length === 1) {
      return chunks[0]!;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  #truncate(
    data: Uint8Array,
    encoding: string | undefined,
    declaredLength?: number,
  ): NetworkRuleRecordedBody {
    const originalLength = data.byteLength;
    if (originalLength <= this.#maxBodyBytes) {
      return {data, truncated: false, originalLength, encoding};
    }
    // The streaming reader stops at maxBodyBytes + 1. Prefer the declared
    // Content-Length as the true size; otherwise report the observed bytes as
    // a lower bound.
    return {
      data: data.subarray(0, this.#maxBodyBytes),
      truncated: true,
      originalLength:
        declaredLength !== undefined && declaredLength > this.#maxBodyBytes
          ? declaredLength
          : originalLength,
      encoding,
    };
  }

  #sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
        result[key] = value;
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  /**
   * Returns the first matching rule index for a request that has not received
   * a response yet. Rules whose only discriminator is the response status are
   * excluded.
   */
  #matchRequest(request: HTTPRequest): [CompiledRule] | undefined {
    const memoized = this.#requestMemo.get(request);
    if (memoized !== undefined) {
      return this.#resultFor(memoized);
    }
    if (!this.#hasHeaderRules) {
      const key = `${request.method()}\n${request.resourceType()}\n${request.url()}`;
      const cached = this.#keyCache.get(key);
      if (cached !== undefined) {
        this.#requestMemo.set(request, cached);
        return this.#resultFor(cached);
      }
      const result = this.#evaluate(request, undefined);
      const index = result
        ? result[0].index
        : this.#statusRuleCouldMatch(request)
          ? -2
          : -1;
      this.#keyCache.set(key, index);
      this.#requestMemo.set(request, index);
      return result;
    }
    const result = this.#evaluate(request, undefined);
    this.#requestMemo.set(
      request,
      result ? result[0].index : this.#statusRuleCouldMatch(request) ? -2 : -1,
    );
    return result;
  }

  #matchResponse(
    request: HTTPRequest,
    response: HTTPResponse,
  ): [CompiledRule] | undefined {
    if (this.#responseEvaluated.has(request) || !this.#hasStatusRules) {
      return undefined;
    }
    this.#responseEvaluated.add(request);
    return this.#evaluate(request, response.status());
  }

  #statusRuleCouldMatch(request: HTTPRequest): boolean {
    if (!this.#hasStatusRules) {
      return false;
    }
    return this.#candidates(request).some(index => {
      return this.#compiled[index]!.hasStatusMatcher;
    });
  }

  #resultFor(index: number): [CompiledRule] | undefined {
    return index < 0 ? undefined : [this.#compiled[index]!];
  }

  /**
   * Narrows the rule set through the method/resourceType/host indexes and
   * only runs the URL and header matchers against the remaining candidates.
   */
  #evaluate(
    request: HTTPRequest,
    status: number | undefined,
  ): [CompiledRule] | undefined {
    const candidates = this.#candidates(request);
    for (const index of candidates) {
      const compiled = this.#compiled[index]!;
      const rule = compiled.rule;
      // Rules gated on the response status cannot run while the request is
      // still paused; they are re-evaluated from the response handler.
      if (status === undefined && compiled.hasStatusMatcher) {
        continue;
      }
      if (rule.url && !this.#matchesUrl(rule.url, request.url())) {
        continue;
      }
      if (
        rule.headers &&
        !this.#matchesHeaders(rule.headers, request.headers())
      ) {
        continue;
      }
      if (status !== undefined && rule.status !== undefined) {
        if (!this.#matchesStatus(rule.status, status)) {
          continue;
        }
      }
      return [compiled];
    }
    return undefined;
  }

  #candidates(request: HTTPRequest): number[] {
    let candidates: Set<number> | undefined;

    const typeBucket = this.#byResourceType.get(request.resourceType());
    candidates = this.#union(typeBucket, this.#noResourceType);

    const methodBucket = this.#byMethod.get(request.method().toUpperCase());
    candidates = this.#intersect(
      candidates,
      this.#union(methodBucket, this.#noMethod),
    );

    let host: string | undefined;
    try {
      host = new URL(request.url()).host;
    } catch {
      host = undefined;
    }
    if (host !== undefined) {
      const hostBucket = this.#byHost.get(host);
      candidates = this.#intersect(
        candidates,
        this.#union(hostBucket, this.#noHost),
      );
    } else {
      candidates = this.#intersect(candidates, this.#noHost);
    }
    return [...candidates].sort((a, b) => {
      return a - b;
    });
  }

  #union(
    specific: Set<number> | undefined,
    fallback: Set<number>,
  ): Set<number> {
    if (!specific) {
      return new Set(fallback);
    }
    return new Set([...specific, ...fallback]);
  }

  #intersect(left: Set<number>, right: Set<number>): Set<number> {
    const result = new Set<number>();
    for (const value of left) {
      if (right.has(value)) {
        result.add(value);
      }
    }
    return result;
  }

  #matchesUrl(pattern: string | RegExp, url: string): boolean {
    return typeof pattern === 'string'
      ? url.includes(pattern)
      : pattern.test(url);
  }

  #matchesHeaders(
    matchers: NonNullable<NetworkRule['headers']>,
    headers: Record<string, string>,
  ): boolean {
    const lowerCased = new Map<string, string>();
    for (const [key, value] of Object.entries(headers)) {
      lowerCased.set(key.toLowerCase(), value);
    }
    for (const matcher of matchers) {
      const value = lowerCased.get(matcher.name.toLowerCase());
      if (matcher.exists) {
        if (value === undefined) {
          return false;
        }
        continue;
      }
      if (value === undefined || matcher.value === undefined) {
        return false;
      }
      if (typeof matcher.value === 'string') {
        if (value.toLowerCase() !== matcher.value.toLowerCase()) {
          return false;
        }
      } else if (!matcher.value.test(value)) {
        return false;
      }
    }
    return true;
  }

  #matchesStatus(
    pattern: NonNullable<NetworkRule['status']>,
    status: number,
  ): boolean {
    for (const entry of this.#asArray(pattern)) {
      if (typeof entry === 'number') {
        if (entry === status) {
          return true;
        }
      } else if (status >= entry[0]! && status <= entry[1]!) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #countHit(compiled: CompiledRule): void {
    this.#matched++;
    this.#ruleHits.set(
      compiled.index,
      (this.#ruleHits.get(compiled.index) ?? 0) + 1,
    );
    const action = compiled.rule.action;
    this.#actionHits.set(action, (this.#actionHits.get(action) ?? 0) + 1);
  }

  async #safeContinue(request: HTTPRequest): Promise<void> {
    try {
      await request.continue();
    } catch (error) {
      const message = this.#errorMessage(error);
      // Redirects, memory-cache hits and page close can finalize a request
      // before the engine resolves it. That is expected and must not pollute
      // the diagnostic error list; only unexpected failures are recorded.
      if (!message.includes('already handled')) {
        this.#recordError(`Could not continue ${request.url()}: ${message}`);
      }
    }
  }

  #failOpen(
    request: HTTPRequest,
    compiled: CompiledRule,
    error: unknown,
    alreadyCounted = false,
  ): void {
    this.#failedOpen++;
    if (!alreadyCounted) {
      // Undo the match accounting because the rule did not actually run.
      this.#matched = Math.max(0, this.#matched - 1);
      this.#ruleHits.set(
        compiled.index,
        Math.max(0, (this.#ruleHits.get(compiled.index) ?? 1) - 1),
      );
      const action = compiled.rule.action;
      this.#actionHits.set(
        action,
        Math.max(0, (this.#actionHits.get(action) ?? 1) - 1),
      );
    }
    this.#recordError(
      `Rule "${compiled.name}" failed for ${request.url()}: ${this.#errorMessage(error)}`,
    );
    void request.continue().catch(() => {});
  }

  #recordError(message: string): void {
    this.#lastError = message;
    this.#errors.push(message);
    if (this.#errors.length > MAX_DIAGNOSTIC_ENTRIES) {
      this.#errors.shift();
    }
  }

  #errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  async #withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out after ${timeout} ms`));
      }, timeout);
    });
    try {
      return await Deferred.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  #delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        },
        {once: true},
      );
    });
  }
}
