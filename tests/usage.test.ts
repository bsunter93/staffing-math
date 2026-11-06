/*
 * Usage counting on the hosted server: what gets counted, that inputs never leave, that it is
 * off without a store, and that a broken store never touches an answer. The store is faked;
 * no network involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { clientFrom, count, eventsFrom, label, stats, usageStore } from '../src/usage';
import { handleFetch } from '../src/fetch';

const STORE = { url: 'https://store.example', token: 't0ken' };
const BASE = 'https://staffing-math.example';
const ARGS = { weekly_volume: 4321, minutes_per_case: 12, shrinkage: 0.3, monthly_growth: 0.05 };

function post(body: unknown, ua = 'openai-mcp/1.0.0'): Request {
  return new Request(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify(body) });
}

/** A fake Upstash REST store that records every pipeline it receives. */
function fakeStore() {
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body });
    const cmds = JSON.parse(body) as unknown[][];
    return Response.json(cmds.map((c) => (c[0] === 'HGETALL' ? { result: ['openai-mcp|tool:hiring_plan', '3'] } : { result: 1 })));
  });
  return { fn, calls };
}

describe('what counts', () => {
  it('labels clients by the first product token of the User-Agent', () => {
    expect(clientFrom('openai-mcp/1.0.0')).toBe('openai-mcp');
    expect(clientFrom('Anthropic/ClaudeAI')).toBe('anthropic');
    expect(clientFrom('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mozilla');
    expect(clientFrom('node')).toBe('node');
    expect(clientFrom(null)).toBe('unknown');
    expect(label('Weird <script> name!!')).toBe('weirdscriptname');
    expect(label('x'.repeat(100))).toHaveLength(40);
  });

  it('turns JSON-RPC methods into counter names and ignores everything else', () => {
    expect(eventsFrom({ method: 'initialize', params: { clientInfo: { name: 'claude-ai' } } })).toEqual({ events: ['initialize'], clientInfo: ['claude-ai'] });
    expect(eventsFrom({ method: 'tools/call', params: { name: 'hiring_plan', arguments: ARGS } }).events).toEqual(['tool:hiring_plan']);
    expect(eventsFrom({ method: 'tools/call', params: { name: 'rm -rf' } }).events).toEqual(['tool:other']);
    expect(eventsFrom([{ method: 'tools/list' }, { method: 'resources/read' }, { method: 'notifications/initialized' }]).events).toEqual(['tools_list', 'view']);
    expect(eventsFrom('nonsense').events).toEqual([]);
  });

  it('reads the store from either name Vercel uses, and is off without one', () => {
    expect(usageStore({})).toBeNull();
    expect(usageStore({ KV_REST_API_URL: 'https://a.example/', KV_REST_API_TOKEN: 'k' })).toEqual({ url: 'https://a.example', token: 'k' });
    expect(usageStore({ UPSTASH_REDIS_REST_URL: 'https://b.example', UPSTASH_REDIS_REST_TOKEN: 'u' })).toEqual({ url: 'https://b.example', token: 'u' });
  });
});

describe('count()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds one per day, client and tool, and sends no inputs', async () => {
    const s = fakeStore();
    vi.stubGlobal('fetch', s.fn);
    await count(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hiring_plan', arguments: ARGS } }), STORE, new Date('2026-11-05T12:00:00Z'));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe('https://store.example/pipeline');
    expect(s.calls[0].auth).toBe('Bearer t0ken');
    expect(JSON.parse(s.calls[0].body)).toEqual([
      ['HINCRBY', 'sm:day:2026-11-05', 'openai-mcp|tool:hiring_plan', 1],
      ['HINCRBY', 'sm:total', 'openai-mcp|tool:hiring_plan', 1],
    ]);
    expect(s.calls[0].body).not.toContain('4321');
    expect(s.calls[0].body).not.toContain('weekly_volume');
  });

  it('does nothing without a store, or when nothing countable was asked', async () => {
    const s = fakeStore();
    vi.stubGlobal('fetch', s.fn);
    await count(post({ method: 'tools/call', params: { name: 'hiring_plan' } }), null);
    await count(post({ method: 'notifications/initialized' }), STORE);
    expect(s.calls).toHaveLength(0);
  });

  it('never throws when the store is down or the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('store down'); }));
    await expect(count(post({ method: 'tools/call', params: { name: 'hiring_plan' } }), STORE)).resolves.toBeUndefined();
    const bad = new Request(`${BASE}/mcp`, { method: 'POST', body: 'not json' });
    await expect(count(bad, STORE)).resolves.toBeUndefined();
  });
});

describe('the hosted handler', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env.KV_REST_API_URL = STORE.url; process.env.KV_REST_API_TOKEN = STORE.token; });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  async function client() {
    const c = new Client({ name: 'test-client', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: (url, init) => handleFetch(new Request(url, init)),
    }));
    return c;
  }

  it('counts a real client session and still answers the example', async () => {
    const s = fakeStore();
    vi.stubGlobal('fetch', s.fn);
    const c = await client();
    const r = await c.callTool({ name: 'hiring_plan', arguments: ARGS });
    expect((r.structuredContent as { total_reqs: number }).total_reqs).toBeGreaterThan(0);
    await c.close();
    const sent = s.calls.map((x) => x.body).join('\n');
    expect(sent).toContain('|initialize');
    expect(sent).toContain('|tool:hiring_plan');
    expect(sent).toContain('"sm:clientinfo","test-client"');
    expect(sent).not.toContain('4321');
  });

  it('answers even when the store is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('store down'); }));
    const c = await client();
    const r = await c.callTool({ name: 'required_fte', arguments: { weekly_volume: 4000, minutes_per_case: 12 } });
    expect((r.structuredContent as { people: number }).people).toBe(34);
    await c.close();
  });

  it('serves the counts at /stats, and says when counting is off', async () => {
    const s = fakeStore();
    vi.stubGlobal('fetch', s.fn);
    const res = await handleFetch(new Request(`${BASE}/stats`));
    expect(res.status).toBe(200);
    const body = await res.json() as Awaited<ReturnType<typeof stats>>;
    expect(body.total).toEqual({ 'openai-mcp|tool:hiring_plan': 3 });
    expect(Object.keys(body.days).length).toBeGreaterThan(0);
    delete process.env.KV_REST_API_URL;
    expect((await handleFetch(new Request(`${BASE}/stats`))).status).toBe(503);
  });
});
