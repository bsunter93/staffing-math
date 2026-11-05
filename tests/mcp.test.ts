/*
 * The server as a client sees it, over all three ways it can be reached: in memory, over
 * Streamable HTTP, and by spawning the built bundle over stdio the way Claude Desktop does.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from 'node:http';
import { buildServer } from '../src/server';
import { startHttp } from '../src/http';
import { options } from '../scripts/build.mjs';

const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { type: string; text: string }[])[0].text;

async function inMemoryClient() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([buildServer().connect(a), client.connect(b)]);
  return client;
}

describe('over MCP', () => {
  it('lists three read-only tools with input and output schemas', async () => {
    const c = await inMemoryClient();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['required_fte', 'hiring_plan', 'erlang_staffing']);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.outputSchema).toBeDefined();
      expect(t.description!.length).toBeGreaterThan(100);
    }
    expect(c.getInstructions()).toContain('Tell the user which inputs were assumed');
  });

  it('answers each tool with text and structured content that matches its output schema', async () => {
    const c = await inMemoryClient();
    await c.listTools(); // the client validates structuredContent against outputSchema once it has them
    const fte = await c.callTool({ name: 'required_fte', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3 } });
    expect(text(fte)).toContain('Answer: 33.61 FTE, so 34 people.');
    expect((fte.structuredContent as { people: number }).people).toBe(34);

    const plan = await c.callTool({ name: 'hiring_plan', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3, monthly_growth: 0.05 } });
    expect(text(plan)).toContain('Answer: open 30 requisitions over 12 months');

    const q = await c.callTool({ name: 'erlang_staffing', arguments: { contacts_per_hour: 200, handle_time_seconds: 300 } });
    expect((q.structuredContent as { agents: number }).agents).toBe(21);
  });

  it('puts the answer and every caveat in structuredContent, for hosts that pass only that', async () => {
    const c = await inMemoryClient();
    await c.listTools();
    const plan = await c.callTool({ name: 'hiring_plan', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3, monthly_growth: 0.05 } });
    const sc = plan.structuredContent as { answer: string; notes: string[] };
    expect(sc.answer).toBe('Open 30 requisitions over 12 months, 4 of them in month 1.');
    expect(sc.notes.join(' ')).toContain('Month 2 is short and new hires can\'t fix that');
    expect(sc.notes.join(' ')).toContain('are for hires who count in months 13 and 14');
    expect(sc.notes.join(' ')).toContain('Assumed, not given:');
    const fte = await c.callTool({ name: 'required_fte', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3 } });
    expect((fte.structuredContent as { answer: string }).answer).toBe('33.61 FTE, so 34 people.');
    const q = await c.callTool({ name: 'erlang_staffing', arguments: { contacts_per_hour: 200, handle_time_seconds: 300 } });
    expect((q.structuredContent as { notes: string[] }).notes[0]).toContain('Erlang C assumes nobody hangs up');
  });

  it('rounds numbers in structuredContent: 2 decimals from 1 up, 4 below', async () => {
    const c = await inMemoryClient();
    await c.listTools();
    const r = await c.callTool({ name: 'hiring_plan', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3, monthly_growth: 0.05, annual_attrition: 0.3 } });
    const nums: number[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'number') nums.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(r.structuredContent);
    for (const x of nums) {
      const decimals = (String(x).split('.')[1] ?? '').length;
      expect(decimals).toBeLessThanOrEqual(Math.abs(x) >= 1 ? 2 : 4);
    }
    const m4 = (r.structuredContent as { months: { weekly_volume: number; fte_needed: number }[] }).months[3];
    expect(m4.weekly_volume).toBe(4630.5);
    expect(m4.fte_needed).toBe(38.91);
  });

  it('turns a percent passed as a whole number into a readable error', async () => {
    const c = await inMemoryClient();
    const r = await c.callTool({ name: 'required_fte', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 30 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('shrinkage is a fraction: 0.30 means 30%.');
  });

  it('returns input conflicts as tool errors the model can read and fix', async () => {
    const c = await inMemoryClient();
    const r = await c.callTool({ name: 'hiring_plan', arguments: { weekly_volume: 4000, weekly_volume_by_month: [4000], minutes_per_case: 12 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not both');
  });
});

describe('over Streamable HTTP', () => {
  let http: Server;
  let url: URL;
  beforeAll(async () => {
    http = await startHttp(0, '127.0.0.1');
    url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  it('serves the same tools statelessly', async () => {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(url));
    expect((await c.listTools()).tools).toHaveLength(3);
    const r = await c.callTool({ name: 'hiring_plan', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3, monthly_growth: 0.05 } });
    expect((r.structuredContent as { total_reqs: number }).total_reqs).toBe(30);
    await c.close();
  });

  it('answers GET / with a plain description and rejects GET /mcp', async () => {
    const root = await fetch(new URL('/', url));
    expect(await root.text()).toContain('Staffing Math MCP server');
    expect((await fetch(url)).status).toBe(405);
  });
});

describe('the built bundle', () => {
  it('dist/staffing-math.mjs is what the source builds to (run npm run build if this fails)', async () => {
    const out = await build({ ...options, write: false });
    const hash = (t: string) => createHash('sha256').update(t).digest('hex');
    expect(hash(out.outputFiles![0].text)).toBe(hash(readFileSync('dist/staffing-math.mjs', 'utf8')));
  });

  it('runs over stdio the way Claude Desktop launches it', async () => {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/staffing-math.mjs'], stderr: 'ignore' }));
    const r = await c.callTool({ name: 'required_fte', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3 } });
    expect(text(r)).toContain('Answer: 33.61 FTE, so 34 people.');
    await c.close();
  }, 20_000);
});
