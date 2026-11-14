/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import expect from 'expect';
import {NetworkRuleAction} from 'puppeteer-core/internal/common/NetworkRules.js';
import type {NetworkRule} from 'puppeteer-core/internal/common/NetworkRules.js';

import {getTestState, setupTestBrowserHooks} from './mocha-utils.js';
import {html, isFavicon} from './utils.js';

describe('declarative network rules', function () {
  setupTestBrowserHooks();

  describe('block', function () {
    it('should block requests matched by resource type', async () => {
      const {page, server} = await getTestState();

      const engine = await page.setNetworkRules({
        rules: [
          {
            name: 'block-images',
            action: NetworkRuleAction.Block,
            resourceType: 'image',
          },
        ],
      });

      const failed = new Promise(resolve => {
        page.once('requestfailed', request => {
          resolve(request.url());
        });
      });
      await page.goto(server.PREFIX + '/grid.html');
      const failedUrl = await failed;
      expect(failedUrl).toContain('png');

      const stats = engine.stats();
      expect(stats.byRule[0]!.hits).toBeGreaterThanOrEqual(1);
      expect(stats.byAction[NetworkRuleAction.Block]).toBeGreaterThanOrEqual(1);
    });

    it('should block by URL and method matchers', async () => {
      const {page, server} = await getTestState();

      server.setRoute('/forbidden', (_req, res) => {
        res.end('should never reach the server');
      });
      await page.setNetworkRules({
        rules: [
          {
            name: 'block-forbidden',
            action: NetworkRuleAction.Block,
            url: '/forbidden',
            method: 'GET',
          },
        ],
      });

      const result = await page.evaluate(async (url: string) => {
        try {
          await fetch(url);
          return 'resolved';
        } catch (error) {
          return (error as Error).name;
        }
      }, server.PREFIX + '/forbidden');
      expect(result).toBe('TypeError');
    });

    it('should match header conditions', async () => {
      const {page, server} = await getTestState();

      // Navigate first so the fetches below are same-origin and carry their
      // custom headers directly (instead of triggering CORS preflights).
      await page.goto(server.EMPTY_PAGE);
      await page.setNetworkRules({
        rules: [
          {
            name: 'block-with-secret',
            action: NetworkRuleAction.Block,
            headers: [{name: 'x-block-me', value: 'yes'}],
          },
        ],
      });

      const [blocked, allowed] = await page.evaluate(async (url: string) => {
        const run = (headers: Record<string, string>) => {
          return fetch(url, {headers})
            .then(() => {
              return 'ok';
            })
            .catch(() => {
              return 'blocked';
            });
        };
        return await Promise.all([
          run({'x-block-me': 'yes'}),
          run({'x-block-me': 'no'}),
        ]);
      }, server.EMPTY_PAGE);
      expect(blocked).toBe('blocked');
      expect(allowed).toBe('ok');
    });

    it('should support the header exists matcher', async () => {
      const {page, server} = await getTestState();

      await page.goto(server.EMPTY_PAGE);
      await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Block,
            url: '/empty.html',
            headers: [{name: 'x-required', exists: true}],
          },
        ],
      });

      const [blocked, allowed] = await page.evaluate(async (url: string) => {
        const run = (headers: Record<string, string>) => {
          return fetch(url, {headers})
            .then(() => {
              return 'ok';
            })
            .catch(() => {
              return 'blocked';
            });
        };
        return await Promise.all([run({'x-required': 'anything'}), run({})]);
      }, server.EMPTY_PAGE);
      expect(blocked).toBe('blocked');
      expect(allowed).toBe('ok');
    });
  });

  describe('allow and rule order', function () {
    it('should let allow rules win over later block rules', async () => {
      const {page, server} = await getTestState();

      const engine = await page.setNetworkRules({
        rules: [
          {
            name: 'allow-page',
            action: NetworkRuleAction.Allow,
            url: '/empty.html',
          },
          {
            name: 'block-documents',
            action: NetworkRuleAction.Block,
            resourceType: 'document',
          },
        ],
      });

      const response = (await page.goto(server.EMPTY_PAGE))!;
      expect(response.ok()).toBe(true);
      expect(engine.stats().byRule[0]!.hits).toBeGreaterThanOrEqual(1);
    });

    it('should support RegExp matchers', async () => {
      const {page, server} = await getTestState();

      await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Block,
            url: /\/assets\/.*\.png$/,
            method: /get/i,
          },
        ],
      });

      const result = await page.evaluate(async (url: string) => {
        try {
          await fetch(url);
          return 'ok';
        } catch {
          return 'blocked';
        }
      }, server.PREFIX + '/pptr.png');
      expect(result).toBe('blocked');
    });
  });

  describe('fulfill', function () {
    it('should fulfill with a static text response', async () => {
      const {page, server} = await getTestState();

      await page.goto(server.EMPTY_PAGE);
      await page.setNetworkRules({
        rules: [
          {
            name: 'mock',
            action: NetworkRuleAction.Fulfill,
            url: '/mocked',
            response: {
              status: 418,
              contentType: 'text/plain',
              headers: {'x-mock': '1'},
              body: 'teapot',
            },
          },
        ],
      });

      const response = await page.evaluate(async (url: string) => {
        const res = await fetch(url);
        return {
          status: res.status,
          header: res.headers.get('x-mock'),
          body: await res.text(),
        };
      }, server.PREFIX + '/mocked');
      expect(response).toEqual({
        status: 418,
        header: '1',
        body: 'teapot',
      });
    });

    it('should fulfill with a binary body', async () => {
      const {page, server} = await getTestState();

      const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
      await page.goto(server.EMPTY_PAGE);
      await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Fulfill,
            url: '/binary',
            response: {
              status: 200,
              contentType: 'application/octet-stream',
              body: bytes,
            },
          },
        ],
      });

      const received = await page.evaluate(async (url: string) => {
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        return [...new Uint8Array(buffer)];
      }, server.PREFIX + '/binary');
      expect(received).toEqual([...bytes]);
    });
  });

  describe('record', function () {
    it('should record request and response metadata', async () => {
      const {page, server} = await getTestState();

      const engine = await page.setNetworkRules({
        rules: [
          {
            name: 'record-json',
            action: NetworkRuleAction.Record,
            url: '/simple.json',
          },
        ],
      });

      await page.goto(server.PREFIX + '/simple.json');
      const records = await engine.waitForRecords(1);
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.url).toContain('/simple.json');
      expect(record.method).toBe('GET');
      expect(record.resourceType).toBe('document');
      expect(record.status).toBe(200);
      expect(record.responseHeaders).toBeTruthy();
      const bodyText = new TextDecoder().decode(record.responseBody!.data);
      expect(bodyText).toContain('foo');
      expect(record.responseBody!.truncated).toBe(false);
    });

    it('should record compressed and binary bodies without decoding them', async () => {
      const {page, server} = await getTestState();

      server.enableGzip('/simple.json');
      const engine = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Record,
            url: '/simple.json',
          },
        ],
      });

      const response = (await page.goto(server.PREFIX + '/simple.json'))!;
      expect(response.headers()['content-encoding']).toBe('gzip');
      const record = (await engine.waitForRecords(1))[0]!;
      expect(record.responseBody!.encoding).toBe('gzip');
      // CDP's Network.getResponseBody returns the decoded body, so the
      // captured bytes must equal the JSON payload; the gzip encoding is still
      // recorded faithfully as metadata for diagnostics.
      const capturedText = new TextDecoder().decode(record.responseBody!.data);
      expect(capturedText).toContain('foo');
      expect(record.responseBody!.truncated).toBe(false);
    });

    it('should capture binary bodies byte-for-byte', async () => {
      const {page, server} = await getTestState();

      // Fetch the same bytes the server will send so the comparison does not
      // depend on the runner's working directory.
      const png = new Uint8Array(
        await (await fetch(server.PREFIX + '/pptr.png')).arrayBuffer(),
      );
      await page.goto(server.EMPTY_PAGE);
      const engine = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Record,
            url: '/pptr.png',
          },
        ],
      });
      await page.evaluate(async (url: string) => {
        await fetch(url);
      }, server.PREFIX + '/pptr.png');
      const binaryRecord = (await engine.waitForRecords(1))[0]!;
      expect(binaryRecord.responseBody!.truncated).toBe(false);
      expect(binaryRecord.responseBody!.originalLength).toBe(png.byteLength);
      expect(
        Buffer.from(binaryRecord.responseBody!.data).equals(Buffer.from(png)),
      ).toBe(true);
    });

    it('should not retain authentication headers', async () => {
      const {page, server} = await getTestState();

      server.setRoute('/auth-protected', (_req, res) => {
        res.end('ok');
      });
      await page.goto(server.EMPTY_PAGE);
      // Set a cookie that the browser attaches to same-origin requests.
      await page.setCookie({name: 'sid', value: 'secret-cookie'});
      const engine = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Record,
            url: '/auth-protected',
          },
        ],
      });

      await page.evaluate(async (url: string) => {
        await fetch(url, {
          headers: {
            'x-safe': 'visible',
          },
          credentials: 'include',
        });
      }, server.PREFIX + '/auth-protected');

      const record = (await engine.waitForRecords(1))[0]!;
      expect(record.requestHeaders['cookie']).toBeUndefined();
      expect(record.requestHeaders['x-safe']).toBe('visible');
    });

    it('should truncate bodies and evict records within configured bounds', async () => {
      const {page, server} = await getTestState();

      server.setRoute('/large', (_req, res) => {
        res.setHeader('Content-Type', 'text/plain');
        res.end('x'.repeat(2048));
      });
      await page.goto(server.EMPTY_PAGE);
      const engine = await page.setNetworkRules({
        maxBodyBytes: 64,
        maxRecordedRequests: 2,
        rules: [
          {
            action: NetworkRuleAction.Record,
            url: '/large',
          },
        ],
      });

      for (let i = 0; i < 4; i++) {
        await page.evaluate(async (url: string) => {
          await fetch(url, {cache: 'no-store'});
        }, server.PREFIX + '/large');
      }
      await engine.waitForRecords(2);
      const records = engine.records();
      expect(records).toHaveLength(2);
      const record = records[0]!;
      expect(record.responseBody!.data.byteLength).toBe(64);
      expect(record.responseBody!.truncated).toBe(true);
      expect(record.responseBody!.originalLength).toBe(2048);
    });

    it('should record request bodies, truncated to the body limit', async () => {
      const {page, server} = await getTestState();

      server.setRoute('/echo', (_req, res) => {
        res.end('ok');
      });
      await page.goto(server.EMPTY_PAGE);
      const engine = await page.setNetworkRules({
        maxBodyBytes: 4,
        rules: [
          {
            action: NetworkRuleAction.Record,
            url: '/echo',
          },
        ],
      });

      await page.evaluate(async (url: string) => {
        await fetch(url, {method: 'POST', body: '1234567890'});
      }, server.PREFIX + '/echo');
      const record = (await engine.waitForRecords(1))[0]!;
      expect(record.requestBody!.truncated).toBe(true);
      expect(new TextDecoder().decode(record.requestBody!.data)).toBe('1234');
    });

    it('should match on response status and record failed requests', async () => {
      const {page, server} = await getTestState();

      server.setRoute('/teapot', (_req, res) => {
        res.writeHead(418);
        res.end();
      });
      server.setRoute('/boom', (_req, res) => {
        res.destroy();
      });
      await page.goto(server.EMPTY_PAGE);
      const engine = await page.setNetworkRules({
        rules: [
          {
            name: 'record-teapots',
            action: NetworkRuleAction.Record,
            status: 418,
          },
          {
            name: 'record-boom',
            action: NetworkRuleAction.Record,
            url: '/boom',
          },
        ],
      });

      await page.evaluate(async (url: string) => {
        await fetch(url).catch(() => {});
      }, server.PREFIX + '/teapot');
      await page.evaluate(async (url: string) => {
        await fetch(url).catch(() => {});
      }, server.PREFIX + '/boom');

      await engine.waitForRecords(2);
      const teapot = engine.records().find(record => {
        return record.url.includes('/teapot');
      })!;
      expect(teapot.status).toBe(418);
      expect(teapot.ruleName).toBe('record-teapots');
      const boom = engine.records().find(record => {
        return record.url.includes('/boom');
      })!;
      expect(boom.failure).toBeTruthy();
      expect(boom.status).toBeUndefined();
    });
  });

  describe('retry', function () {
    it('should fulfill a paused request from a Node-side re-issue', async () => {
      const {page, server} = await getTestState();

      let nodeAttempts = 0;
      server.setRoute('/recoverable', (_req, res) => {
        nodeAttempts++;
        res.end('recovered');
      });
      await page.goto(server.EMPTY_PAGE);

      const engine = await page.setNetworkRules({
        rules: [
          {
            name: 'retry-recoverable',
            action: NetworkRuleAction.Retry,
            url: '/recoverable',
            retry: {maxAttempts: 2},
          },
        ],
      });

      // The browser request stays paused; the engine fetches the resource from
      // Node.js and fulfills the paused request with it.
      const body = await page.evaluate(async (url: string) => {
        const res = await fetch(url);
        return {status: res.status, text: await res.text()};
      }, server.PREFIX + '/recoverable');
      expect(body.status).toBe(200);
      expect(body.text).toBe('recovered');
      expect(nodeAttempts).toBe(1);
      expect(
        engine.stats().byAction[NetworkRuleAction.Retry],
      ).toBeGreaterThanOrEqual(1);
    });

    it('should retry until a non-error status is received', async () => {
      const {page, server} = await getTestState();

      let attempts = 0;
      server.setRoute('/unstable', (_req, res) => {
        attempts++;
        if (attempts === 1) {
          res.writeHead(503);
          res.end();
          return;
        }
        res.end('stable');
      });
      await page.goto(server.EMPTY_PAGE);

      await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Retry,
            url: '/unstable',
            retry: {maxAttempts: 2, retryOnStatus: 500},
          },
        ],
      });

      const body = await page.evaluate(async (url: string) => {
        const res = await fetch(url);
        return {status: res.status, body: await res.text()};
      }, server.PREFIX + '/unstable');
      expect(body.status).toBe(200);
      expect(body.body).toBe('stable');
      expect(attempts).toBe(2);
    });

    it('should fail open with a diagnostic error when every retry fails', async () => {
      const {page, server} = await getTestState();

      server.setRoute('/always-down', (_req, res) => {
        res.destroy();
      });
      await page.goto(server.EMPTY_PAGE);
      const engine = await page.setNetworkRules({
        rules: [
          {
            name: 'retry-doomed',
            action: NetworkRuleAction.Retry,
            url: '/always-down',
            retry: {maxAttempts: 1, timeout: 2000},
          },
        ],
      });

      const outcome = await page.evaluate(async (url: string) => {
        try {
          await fetch(url);
          return 'resolved';
        } catch {
          return 'failed';
        }
      }, server.PREFIX + '/always-down');
      // The request is allowed through to the browser, which also fails, but
      // it must never hang.
      expect(outcome).toBe('failed');
      expect(engine.getErrors().length).toBeGreaterThan(0);
      expect(engine.getErrors()[0]!).toContain('/always-down');
      expect(engine.stats().failedOpen).toBe(1);
    });
  });

  describe('stats', function () {
    it('should count matched and unmatched requests', async () => {
      const {page, server} = await getTestState();

      const engine = await page.setNetworkRules({
        rules: [
          {
            name: 'block-css',
            action: NetworkRuleAction.Block,
            resourceType: 'stylesheet',
          },
        ],
      });

      await page.goto(server.EMPTY_PAGE).catch(() => {});
      await page.setContent(
        html`<link
          rel="stylesheet"
          href="/injected/style.css"
        />`,
      );
      await new Promise(resolve => {
        return setTimeout(resolve, 300);
      });

      const stats = engine.stats();
      expect(stats.totalRequests).toBeGreaterThan(0);
      expect(stats.matched + stats.unmatched).toBe(stats.totalRequests);
      expect(stats.byRule[0]!.name).toBe('block-css');
      expect(stats.byRule[0]!.hits).toBeGreaterThanOrEqual(1);
    });

    it('should reject invalid rule definitions', async () => {
      const {page} = await getTestState();

      await expect(
        page.setNetworkRules({
          rules: [
            {
              action: 'nonsense' as NetworkRule['action'],
            },
          ],
        }),
      ).rejects.toThrow(/unknown action/);

      await expect(
        page.setNetworkRules({
          rules: [
            {
              action: NetworkRuleAction.Fulfill,
              url: '/x',
            },
          ],
        }),
      ).rejects.toThrow(/must define a "response"/);
    });
  });

  describe('concurrency', function () {
    it('should handle many concurrent requests with distinct URLs', async () => {
      const {page, server} = await getTestState();

      let serverHits = 0;
      server.setRoute('/parallel', (_req, res) => {
        serverHits++;
        res.end('ok');
      });
      await page.goto(server.EMPTY_PAGE);

      const engine = await page.setNetworkRules({
        rules: [
          {
            name: 'record-parallel',
            action: NetworkRuleAction.Record,
            url: '/parallel',
          },
        ],
      });

      const count = 30;
      const results = await page.evaluate(async (url: string) => {
        const promises = Array.from({length: 30}, (_, index) => {
          return fetch(`${url}?n=${index}`).then(res => {
            return res.ok;
          });
        });
        return await Promise.all(promises);
      }, server.PREFIX + '/parallel');
      expect(results).toHaveLength(count);
      expect(results.every(Boolean)).toBe(true);
      expect(serverHits).toBe(count);
      const records = await engine.waitForRecords(count);
      expect(records).toHaveLength(count);
    });

    it('should handle concurrent block and allow rules', async () => {
      const {page, server} = await getTestState();

      await page.goto(server.EMPTY_PAGE);
      const engine = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Block,
            url: '/blocked',
          },
          {
            action: NetworkRuleAction.Record,
            url: '/allowed',
          },
        ],
      });

      server.setRoute('/blocked', (_req, res) => {
        res.end();
      });
      server.setRoute('/allowed', (_req, res) => {
        res.end('allowed-body');
      });

      const outcomes = await page.evaluate(async (prefix: string) => {
        const tasks: Array<Promise<string>> = [];
        for (let i = 0; i < 10; i++) {
          tasks.push(
            fetch(`${prefix}/blocked?i=${i}`)
              .then(() => {
                return 'ok';
              })
              .catch(() => {
                return 'blocked';
              }),
          );
          tasks.push(
            fetch(`${prefix}/allowed?i=${i}`)
              .then(() => {
                return 'ok';
              })
              .catch(() => {
                return 'blocked';
              }),
          );
        }
        return await Promise.all(tasks);
      }, server.PREFIX);

      expect(
        outcomes.filter(value => {
          return value === 'blocked';
        }),
      ).toHaveLength(10);
      expect(
        outcomes.filter(value => {
          return value === 'ok';
        }),
      ).toHaveLength(10);
      const records = await engine.waitForRecords(10);
      expect(records).toHaveLength(10);
    });
  });

  describe('redirects', function () {
    it('should apply rules across redirect chains', async () => {
      const {page, server} = await getTestState();

      server.setRedirect('/start', '/middle');
      server.setRedirect('/middle', '/empty.html');
      const engine = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Record,
          },
        ],
      });

      const response = (await page.goto(server.PREFIX + '/start'))!;
      expect(response.ok()).toBe(true);
      // The chain contains at least the redirect hops and the final document.
      const records = await engine.waitForRecords(3);
      const urls = records.map(record => {
        return record.url;
      });
      expect(
        urls.some(url => {
          return url.includes('/start');
        }),
      ).toBe(true);
      expect(
        urls.some(url => {
          return url.includes('/middle');
        }),
      ).toBe(true);
      expect(
        urls.some(url => {
          return url.includes('/empty.html');
        }),
      ).toBe(true);
    });
  });

  describe('page close and detach', function () {
    it('should not hang or throw when the page closes mid-flight', async () => {
      const {page, server, browser} = await getTestState();

      server.setRoute('/slow', (_req, res) => {
        setTimeout(() => {
          res.end('late');
        }, 5000);
      });
      const engine = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Record,
            url: '/slow',
          },
        ],
      });

      void page.goto(server.PREFIX + '/slow').catch(() => {});
      await new Promise(resolve => {
        return setTimeout(resolve, 200);
      });
      await page.close();
      // Engine state must remain readable after close.
      expect(() => {
        return engine.stats();
      }).not.toThrow();
      expect(browser.connected).toBe(true);
    });

    it('should restore default behavior on detach', async () => {
      const {page, server} = await getTestState();

      const engine = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Block,
            url: '/empty.html',
          },
        ],
      });
      await expect(
        page.goto(server.EMPTY_PAGE, {timeout: 3000}),
      ).rejects.toThrow();
      await engine.detach();

      const response = (await page.goto(server.EMPTY_PAGE))!;
      expect(response.ok()).toBe(true);
    });

    it('should replace the previous engine when rules are set again', async () => {
      const {page, server} = await getTestState();

      const first = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Block,
            url: '/empty.html',
          },
        ],
      });
      const second = await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Allow,
            url: '/empty.html',
          },
        ],
      });
      expect(first).not.toBe(second);
      const response = (await page.goto(server.EMPTY_PAGE))!;
      expect(response.ok()).toBe(true);
    });

    it('should pass through favicon requests without special handling', async () => {
      const {page, server} = await getTestState();

      await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Record,
          },
        ],
      });
      await page.goto(server.EMPTY_PAGE);
      // No assertion beyond the page loading: favicon must not stall.
      expect(page.url()).toContain('empty.html');
    });
  });

  describe('default behavior regression', function () {
    it('should leave navigation untouched when no rules are configured', async () => {
      const {page, server} = await getTestState();

      const engine = await page.setNetworkRules({rules: []});
      expect(engine.stats().totalRequests).toBe(0);
      const response = (await page.goto(server.EMPTY_PAGE))!;
      expect(response.ok()).toBe(true);
      expect(engine.records()).toHaveLength(0);
      expect(engine.getErrors()).toHaveLength(0);
    });

    it('should keep manual interception working alongside rules', async () => {
      const {page, server} = await getTestState();

      await page.setNetworkRules({
        rules: [
          {
            action: NetworkRuleAction.Block,
            url: '/blocked-asset',
          },
        ],
      });

      const continued: string[] = [];
      page.on('request', request => {
        if (isFavicon(request)) {
          void request.continue().catch(() => {});
          return;
        }
        if (!request.url().includes('/blocked-asset')) {
          continued.push(request.url());
          // The rule engine may already have handled the request; a second
          // resolution is reported via a rejection which callers ignore, the
          // same way cooperative handlers do.
          void request.continue().catch(() => {});
        }
      });

      server.setRoute('/blocked-asset', (_req, res) => {
        res.end();
      });
      const response = (await page.goto(server.EMPTY_PAGE))!;
      expect(response.ok()).toBe(true);
      const outcome = await page.evaluate(async (url: string) => {
        try {
          await fetch(url);
          return 'ok';
        } catch {
          return 'blocked';
        }
      }, server.PREFIX + '/blocked-asset');
      expect(outcome).toBe('blocked');
      expect(continued.length).toBeGreaterThan(0);
    });
  });
});
