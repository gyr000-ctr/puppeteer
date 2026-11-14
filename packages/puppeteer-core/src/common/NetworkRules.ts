/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ResourceType} from '../api/HTTPRequest.js';

/**
 * The action a {@link NetworkRule} takes when it matches a request.
 *
 * @public
 */
export enum NetworkRuleAction {
  /**
   * Abort the request (the browser observes a network failure).
   */
  Block = 'block',
  /**
   * Explicitly allow the request to proceed without further rule
   * processing.
   */
  Allow = 'allow',
  /**
   * Fulfill the request from a static response instead of contacting the
   * network.
   */
  Fulfill = 'fulfill',
  /**
   * Let the request proceed and record a bounded summary of the request and
   * response.
   */
  Record = 'record',
  /**
   * Re-issue the request from Node.js when the browser's attempt fails, and
   * fulfill the browser request with the recovered response.
   */
  Retry = 'retry',
}

/**
 * A URL matcher. A string matches if it is a substring of the request URL; a
 * regular expression matches if it tests the request URL.
 *
 * @public
 */
export type NetworkRuleUrlPattern = string | RegExp;

/**
 * A matcher for a single HTTP header. `exists` only checks presence, a string
 * value requires an exact (case-insensitive) match, and a regular expression
 * tests the header value.
 *
 * @public
 */
export interface NetworkRuleHeaderMatcher {
  name: string;
  value?: string | RegExp;
  exists?: boolean;
}

/**
 * The static response used by rules with the
 * {@link NetworkRuleAction.Fulfill} action.
 *
 * @public
 */
export interface NetworkRuleResponse {
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | Uint8Array;
}

/**
 * Options for the {@link NetworkRuleAction.Retry} action.
 *
 * @public
 */
export interface NetworkRuleRetryOptions {
  /**
   * Maximum number of re-issued attempts. Defaults to `1`.
   */
  maxAttempts?: number;
  /**
   * Retry not only on network failures but also when the response status is
   * greater than or equal to this code. Defaults to `500`.
   */
  retryOnStatus?: number;
  /**
   * Extra time per retry attempt before giving up and letting the original
   * response (or failure) reach the page. Defaults to `10000` milliseconds.
   */
  timeout?: number;
  /**
   * Delay before each retry attempt. Defaults to `0` milliseconds.
   */
  delay?: number;
}

/**
 * A declarative network rule.
 *
 * @remarks
 *
 * All matcher fields are optional; when several are present they are combined
 * with logical AND. Rules are evaluated in the order they were declared and
 * the first matching rule wins.
 *
 * @public
 */
export interface NetworkRule {
  /**
   * Optional human-readable name used in {@link NetworkRuleStats}.
   */
  name?: string;
  /**
   * What to do when the rule matches.
   */
  action: NetworkRuleAction;
  /**
   * Match against the request URL.
   */
  url?: NetworkRuleUrlPattern;
  /**
   * Match against the HTTP method (case-insensitive).
   */
  method?: string | RegExp;
  /**
   * Match against request headers. Every listed matcher must match (AND).
   */
  headers?: NetworkRuleHeaderMatcher[];
  /**
   * Match against the resource type perceived by the rendering engine.
   */
  resourceType?: ResourceType | ResourceType[];
  /**
   * Match against the status code of the received response. Only evaluated
   * once the response headers arrive; used by the `record` and `retry`
   * actions.
   */
  status?: number | Array<number | [number, number]>;
  /**
   * Required by {@link NetworkRuleAction.Fulfill}.
   */
  response?: NetworkRuleResponse;
  /**
   * Optional configuration for {@link NetworkRuleAction.Retry}.
   */
  retry?: NetworkRuleRetryOptions;
}

/**
 * Bounded body captured by a `record` rule.
 *
 * @public
 */
export interface NetworkRuleRecordedBody {
  /**
   * The captured bytes, truncated to the configured body limit.
   */
  data: Uint8Array;
  /**
   * Whether `data` was truncated because the body exceeded the limit.
   */
  truncated: boolean;
  /**
   * The original body length in bytes, when known.
   */
  originalLength?: number;
  /**
   * The `Content-Encoding` of the body. Bodies are stored as received on the
   * wire (for example, still gzip-compressed).
   */
  encoding?: string;
}

/**
 * One recorded exchange, produced by `record` rules.
 *
 * @remarks
 *
 * Authentication headers (`authorization`, `proxy-authorization`, `cookie`
 * and `set-cookie`) are never stored. Bodies are bounded by the configured
 * `maxBodyBytes` and the whole record set is bounded by `maxRecordedRequests`.
 *
 * @public
 */
export interface NetworkRuleRecord {
  ruleName?: string;
  url: string;
  method: string;
  resourceType: ResourceType;
  requestHeaders: Record<string, string>;
  status?: number;
  responseHeaders?: Record<string, string>;
  requestBody?: NetworkRuleRecordedBody;
  responseBody?: NetworkRuleRecordedBody;
  /**
   * Set when the request failed before a response was received.
   */
  failure?: string;
  /**
   * Set when an error prevented the rule engine from handling the request.
   * The request is always allowed to proceed in that case.
   */
  error?: string;
  timestamp: number;
}

/**
 * Per-rule and aggregate hit counters.
 *
 * @public
 */
export interface NetworkRuleStats {
  totalRequests: number;
  matched: number;
  unmatched: number;
  failedOpen: number;
  byRule: Array<{name: string; hits: number}>;
  byAction: Record<string, number>;
}

/**
 * Options for {@link Page.setNetworkRules}.
 *
 * @public
 */
export interface NetworkRuleEngineOptions {
  rules: NetworkRule[];
  /**
   * Maximum number of {@link NetworkRuleRecord | records} retained. When the
   * limit is reached the oldest records are evicted. Defaults to `100`.
   */
  maxRecordedRequests?: number;
  /**
   * Maximum number of bytes stored per recorded body. Larger bodies are
   * truncated. Defaults to `1048576` (1 MiB).
   */
  maxBodyBytes?: number;
  /**
   * Maximum number of entries in the per-request match-result cache.
   * Defaults to `1000`.
   */
  maxMatchCacheEntries?: number;
}
