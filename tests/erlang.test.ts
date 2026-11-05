import { describe, expect, it } from 'vitest';
import { erlangStaffing } from '../src/tools';

/*
 * An independent Erlang C, written the textbook way (a sum of a^k / k! terms), to check
 * the engine's recursion against. Fine up to a few hundred agents, which is where the
 * textbook form starts to overflow and the engine's form keeps going.
 */
function erlangCRef(n: number, a: number): number {
  let term = 1, sum = 0;
  for (let k = 0; k < n; k++) { sum += term; term = (term * a) / (k + 1); }
  const top = (term * n) / (n - a);
  return top / (sum + top);
}
const slRef = (n: number, a: number, aht: number, t: number) => 1 - erlangCRef(n, a) * Math.exp((-(n - a) * t) / aht);

describe('erlang_staffing', () => {
  it('reproduces the Simulator test: two agents of work, 15-minute handle time, 80% in 2 minutes needs 4', () => {
    // staffFor(2, 900, 120, 0.8) === 4 in the upstream pooled test. 8 an hour x 900 s / 3600 = 2 Erlangs.
    const r = erlangStaffing({ contacts_per_hour: 8, handle_time_seconds: 900, answer_within_seconds: 120, service_level: 0.8 }).structured;
    expect(r.offered_load_erlangs).toBe(2);
    expect(r.agents).toBe(4);
  });

  it('matches a textbook Erlang C on every answer across a grid', () => {
    for (const cph of [10, 60, 200, 750, 1500]) {
      for (const aht of [120, 300, 600]) {
        for (const [t, sl] of [[20, 0.8], [30, 0.9], [60, 0.7]] as const) {
          const r = erlangStaffing({ contacts_per_hour: cph, handle_time_seconds: aht, answer_within_seconds: t, service_level: sl }).structured;
          const a = (cph * aht) / 3600;
          expect(r.service_level_at_agents).toBeCloseTo(slRef(r.agents, a, aht, t), 9);
          expect(r.service_level_at_agents).toBeGreaterThanOrEqual(sl);
          expect(r.probability_of_waiting).toBeCloseTo(erlangCRef(r.agents, a), 9);
          if (r.agents - 1 > a) {
            expect(r.service_level_one_fewer).toBeCloseTo(slRef(r.agents - 1, a, aht, t), 9);
            expect(r.service_level_one_fewer!).toBeLessThan(sl);
          }
        }
      }
    }
  });

  it('200 contacts an hour at 5 minutes, 80% in 20 seconds: 21 agents, 30 people at 30% shrinkage', () => {
    const r = erlangStaffing({ contacts_per_hour: 200, handle_time_seconds: 300 });
    expect(r.structured.offered_load_erlangs).toBeCloseTo(16.6667, 4);
    expect(r.structured.agents).toBe(21);
    expect(r.structured.occupancy).toBeCloseTo(16.6667 / 21, 4);
    expect(r.structured.people_to_schedule).toBe(30);
    expect(r.text).toContain('Answer: 21 agents on the queue, 30 people scheduled.');
  });

  it('stays finite past the 170 agents where factorial spreadsheets overflow', () => {
    const r = erlangStaffing({ contacts_per_hour: 20000, handle_time_seconds: 300 }).structured;
    expect(r.agents).toBeGreaterThan(1666);
    expect(Number.isFinite(r.service_level_at_agents)).toBe(true);
    expect(r.service_level_at_agents).toBeGreaterThanOrEqual(0.8);
    expect(r.service_level_one_fewer!).toBeLessThan(0.8);
  });

  it('a tighter target never needs fewer agents', () => {
    const base = { contacts_per_hour: 300, handle_time_seconds: 240 };
    let prev = 0;
    for (const sl of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]) {
      const n = erlangStaffing({ ...base, service_level: sl }).structured.agents;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('marks its defaults as assumed', () => {
    const r = erlangStaffing({ contacts_per_hour: 200, handle_time_seconds: 300 }).structured;
    expect(r.inputs.filter((i) => i.source === 'assumed').map((i) => i.name)).toEqual(['answer within', 'service level target', 'shrinkage']);
  });
});
