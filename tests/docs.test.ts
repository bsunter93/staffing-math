/*
 * The README's worked example is copied from real tool output, and the house style bans
 * em dashes. Both are checked here so neither drifts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { erlangStaffing, hiringPlan, requiredFte } from '../src/tools';

const readme = readFileSync('README.md', 'utf8');
const EM_DASH = String.fromCharCode(0x2014);
const ask = { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3 };

function exampleLines(): string[] {
  const start = readme.indexOf('## Worked example');
  const end = readme.indexOf('The prompt didn\'t give');
  return readme.slice(start, end).split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('`') && !l.startsWith('```'));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', 'dist', 'api', '.git', 'verification'].includes(f) || f.endsWith('.generated.ts')) return [];
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('docs', () => {
  it('every line of the README worked example is real tool output', () => {
    const out = requiredFte(ask).text + '\n' + hiringPlan({ ...ask, monthly_growth: 0.05 }).text;
    for (const line of exampleLines()) expect(out).toContain(line);
  });

  it('the README rerun with real numbers says what the tool says', () => {
    const r = hiringPlan({ ...ask, monthly_growth: 0.05, current_headcount: 30, annual_attrition: 0.25, ramp_months: 1 }).structured;
    expect(r.total_reqs).toBe(53);
    expect(r.months[0].reqs_to_open).toBe(12);
    expect(r.months_short_before_hires_land).toEqual([1, 2, 3]);
    expect(readme).toContain('needs 53 requisitions instead of 30, 12 of them in month 1, and months 1 to 3 are short');
  });

  it('no em dashes in the repo or in anything the tools print', () => {
    const offenders = filesUnder('.').filter((f) => /\.(md|ts|mjs|json|sh|html)$/.test(f) && readFileSync(f, 'utf8').includes(EM_DASH));
    expect(offenders).toEqual([]);
    const outputs = [requiredFte(ask), hiringPlan({ ...ask, monthly_growth: 0.05, annual_attrition: 0.2, start_month: '2027-01' }), erlangStaffing({ contacts_per_hour: 200, handle_time_seconds: 300 })];
    for (const o of outputs) expect(o.text).not.toContain(EM_DASH);
  });
});

describe('release metadata', () => {
  it('package.json, the Claude plugin, the Desktop extension, the Gemini extension and the registry entry carry one version', () => {
    const v = (f: string) => JSON.parse(readFileSync(f, 'utf8')).version;
    expect(v('.claude-plugin/plugin.json')).toBe(v('package.json'));
    expect(v('manifest.json')).toBe(v('package.json'));
    expect(v('gemini-extension.json')).toBe(v('package.json'));
    expect(v('server.json')).toBe(v('package.json'));
  });
});
