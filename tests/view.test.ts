/*
 * The plan view: its drawing logic in Node, and how the server offers it to hosts.
 * The view itself was checked in a browser host; see the README.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { hiringPlan } from '../src/tools';
import { buildServer, PLAN_VIEW_URI } from '../src/server';
import { changes, contextNote, controlsFor, geometry, shortLabel, summarize, type PlanResult } from '../src/view/model';
import { viewModule, VIEW_MODULE } from '../scripts/build.mjs';

const example = { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3, monthly_growth: 0.05 };
const plan = (a: Parameters<typeof hiringPlan>[0] = example) => hiringPlan(a).structured as PlanResult;

describe('plan view: words', () => {
  it('leads with the answer and names the short months', () => {
    const s = summarize(plan());
    expect(s.headline).toBe('Open 30 requisitions over 12 months');
    expect(s.sub).toBe('34 FTE on hand in month 1, 58 in month 12. Month 2 is short before the first hire can count.');
    expect(s.chart).toContain('Short in month 2.');
  });

  it('names the most overstaffed month', () => {
    const s = summarize(plan({ weekly_volume_by_month: [900, 1400, 800, 2000, 2000, 600, 3000], minutes_per_case: 25, annual_attrition: 0.2, time_to_hire_months: 1 }));
    expect(s.sub).toContain('Month 6 has 24.7 FTE more than it needs.');
    expect(s.chart).toContain('At least one FTE spare in months 3 and 6.');
  });

  it('says so when nothing needs hiring', () => {
    expect(summarize(plan({ weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3 })).headline).toBe('No requisitions needed over 12 months');
  });
});

describe('plan view: chart geometry', () => {
  const r = plan();
  const g = geometry(r.months, 640);

  it('draws one gap for each short month, between the two lines', () => {
    expect(g.gaps.map((x) => x.month)).toEqual([2]);
    expect(g.gaps[0].short).toBeCloseTo(1.29, 2);
    expect(g.gaps[0].h).toBeGreaterThan(0);
  });

  it('fills spare months between the lines, and only those', () => {
    const spiky = geometry(plan({ weekly_volume_by_month: [900, 1400, 800, 2000, 2000, 600, 3000], minutes_per_case: 25, annual_attrition: 0.2, time_to_hire_months: 1 }).months, 640);
    expect(spiky.spares.map((x) => x.month)).toEqual([3, 6]);
    for (const sp of spiky.spares) expect(sp.h).toBeGreaterThan(0);
    expect(g.spares).toEqual([]);
  });

  it('gives each month a column and a requisition bar, scaled to the busiest month', () => {
    expect(g.columns).toHaveLength(12);
    expect(g.reqBars.map((b) => b.value)).toEqual(r.months.map((m) => m.reqs_to_open));
    const tallest = Math.max(...g.reqBars.map((b) => b.h));
    expect(tallest).toBeCloseTo(g.bars.bottom - g.bars.top, 6);
  });

  it('keeps every point inside the plot, with the axis around the data rather than at zero', () => {
    const ys = [...g.neededPath.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(g.plot.top - 0.1);
      expect(y).toBeLessThanOrEqual(g.plot.bottom + 0.1);
    }
    expect(Number(g.yTicks[0].label)).toBeGreaterThan(0);
  });

  it('never prints the two end labels on top of each other', () => {
    expect(Math.abs(g.endLabels.needed.y - g.endLabels.onHand.y)).toBeGreaterThanOrEqual(14);
  });

  it('thins month labels on long plans and shortens them', () => {
    const long = geometry(plan({ ...example, months: 36 }).months, 640);
    expect(long.xLabels.length).toBeLessThanOrEqual(13);
    expect(shortLabel('Month 7')).toBe('7');
    expect(shortLabel('Nov 2027')).toBe('Nov');
  });
});

describe('plan view: controls', () => {
  it('offers the inputs a reader would change, set to what the plan used', () => {
    const c = controlsFor(plan());
    expect(c.map((x) => x.key)).toEqual(['monthly_growth', 'annual_attrition', 'time_to_hire_months', 'ramp_months', 'shrinkage', 'current_headcount']);
    expect(Object.fromEntries(c.map((x) => [x.key, x.value]))).toMatchObject({ monthly_growth: 0.05, annual_attrition: 0, current_headcount: 34 });
  });

  it('leaves out growth when the forecast was given month by month', () => {
    const c = controlsFor(plan({ weekly_volume_by_month: [100, 200, 300], minutes_per_case: 10 }));
    expect(c.map((x) => x.key)).not.toContain('monthly_growth');
  });

  it('widens a slider rather than clamping a value outside its usual range', () => {
    const c = controlsFor(plan({ ...example, monthly_growth: 0.3 }));
    expect(c.find((x) => x.key === 'monthly_growth')!.max).toBe(0.3);
  });

  it('lists what the reader changed and tells the model the new result with rerunnable arguments', () => {
    const original = controlsFor(plan());
    const moved = { annual_attrition: 0.25, time_to_hire_months: 2 };
    const changed = changes(original, moved);
    expect(changed).toEqual(['Annual attrition 25% (was 0%)']);
    const after = plan({ ...example, annual_attrition: 0.25 });
    const note = contextNote(after, changed, { ...example, annual_attrition: 0.25 });
    expect(note).toContain('Changed: Annual attrition 25% (was 0%).');
    expect(note).toContain(`Result now: Open ${after.total_reqs} requisitions over 12 months`);
    expect(note).toContain('"annual_attrition":0.25');
  });
});

describe('plan view: served to hosts', () => {
  async function client() {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test', version: '0' });
    await Promise.all([buildServer().connect(a), c.connect(b)]);
    return c;
  }

  it('hiring_plan points at the view; the other two tools have none', async () => {
    const { tools } = await (await client()).listTools();
    const meta = Object.fromEntries(tools.map((t) => [t.name, t._meta]));
    expect(meta.hiring_plan).toMatchObject({ ui: { resourceUri: PLAN_VIEW_URI } });
    expect(meta.required_fte?.ui).toBeUndefined();
    expect(meta.erlang_staffing?.ui).toBeUndefined();
  });

  it('serves one self-contained HTML file with the MCP Apps mime type', async () => {
    const c = await client();
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain(PLAN_VIEW_URI);
    const res = await c.readResource({ uri: PLAN_VIEW_URI });
    const item = res.contents[0] as { mimeType: string; text: string };
    expect(item.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(item.text).toMatch(/^<!doctype html>/);
    // Nothing loads from anywhere else, so the host's default sandbox is enough.
    expect(item.text).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import/i);
    expect(item.text).toContain('Try other numbers');
  });

  it('the generated view module is what the view source builds to (run npm run build if this fails)', async () => {
    const hash = (t: string) => createHash('sha256').update(t).digest('hex');
    expect(hash(await viewModule())).toBe(hash(readFileSync(VIEW_MODULE, 'utf8')));
  });
});
