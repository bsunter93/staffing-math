/*
 * The hosted build: api/index.mjs, the exact file Vercel runs, driven by a real MCP client
 * through its fetch handler. No network involved.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { vercelOptions } from '../scripts/build.mjs';
import hosted from '../api/index.mjs';

const handler = hosted as { fetch: (r: Request) => Promise<Response> };
const BASE = 'https://staffing-math.example';

async function client() {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  }));
  return c;
}

describe('hosted build (api/index.mjs)', () => {
  it('answers the example through a real MCP client', async () => {
    const c = await client();
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['required_fte', 'hiring_plan', 'erlang_staffing']);
    const r = await c.callTool({ name: 'hiring_plan', arguments: { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3, monthly_growth: 0.05 } });
    expect((r.structuredContent as { total_reqs: number }).total_reqs).toBe(30);
    const view = await c.readResource({ uri: 'ui://staffing-math/hiring-plan.html' });
    expect((view.contents[0] as { text: string }).text).toContain('Try other numbers');
    await c.close();
  });

  it('describes itself at /, refuses GET on /mcp, and sends CORS headers', async () => {
    const root = await handler.fetch(new Request(`${BASE}/`));
    expect(await root.text()).toContain('Staffing Math MCP server');
    expect((await handler.fetch(new Request(`${BASE}/mcp`))).status).toBe(405);
    expect((await handler.fetch(new Request(`${BASE}/nope`))).status).toBe(404);
    const pre = await handler.fetch(new Request(`${BASE}/mcp`, { method: 'OPTIONS' }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('api/index.mjs is what the source builds to (run npm run build if this fails)', async () => {
    const out = await build({ ...vercelOptions, write: false });
    const hash = (t: string) => createHash('sha256').update(t).digest('hex');
    expect(hash(out.outputFiles![0].text)).toBe(hash(readFileSync('api/index.mjs', 'utf8')));
  });

  it('Vercel routes every path to the function and uploads nothing else', () => {
    const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(v.rewrites).toEqual([{ source: '/(.*)', destination: '/api' }]);
    // A project Vercel guessed was Vite once failed every drop with "vite build exited with 127".
    expect(v.framework).toBeNull();
    expect(v.buildCommand).not.toMatch(/vite|npm/);
    // Vercel refuses an empty output directory, so the build leaves one small file in it.
    expect(v.outputDirectory).toBe('public');
    expect(v.buildCommand).toMatch(/> public\/robots\.txt/);
    const ignore = readFileSync('.vercelignore', 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    expect(ignore).toEqual(['/*', '!/api', '!/vercel.json']);
  });
});
