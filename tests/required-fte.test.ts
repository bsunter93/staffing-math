import { describe, expect, it } from 'vitest';
import { requiredFte } from '../src/tools';
import { runTeam } from '../src/engine';

const example = { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3 };

describe('required_fte', () => {
  it('4,000 cases a week at 12 minutes with 30% shrinkage needs 33.61 FTE, so 34 people', () => {
    // By hand: 4000 x 12 / 60 = 800 hours; 40 x 0.7 x 0.85 = 23.8 hours; 800 / 23.8
    const r = requiredFte(example).structured;
    expect(r.weekly_work_hours).toBe(800);
    expect(r.planned_hours_per_fte_week).toBeCloseTo(23.8, 12);
    expect(r.fte).toBeCloseTo(800 / 23.8, 10);
    expect(r.people).toBe(34);
  });

  it('prints the same numbers it returns', () => {
    const { text } = requiredFte(example);
    expect(text).toContain('Answer: 33.61 FTE, so 34 people.');
    expect(text).toContain('4,000 cases x 12 min / 60 = 800.0 hours');
    expect(text).toContain('40 x (1 - 0.3) = 28.00 hours');
    expect(text).toContain('28.00 x 0.85 = 23.80 hours');
    expect(text).toContain('800.0 / 23.80 = 33.61');
  });

  it('marks defaults as assumed and given values as given', () => {
    const r = requiredFte(example).structured;
    const src = Object.fromEntries(r.inputs.map((i) => [i.name, i.source]));
    expect(src).toEqual({
      'weekly volume': 'given', 'minutes per case': 'given', shrinkage: 'given',
      'target occupancy': 'assumed', 'hours per FTE per week': 'assumed',
    });
    expect(requiredFte(example).text).toContain('Assumed, not given: target occupancy, hours per FTE per week.');
  });

  it('agrees with the engine across a grid of inputs', () => {
    for (const v of [1, 250, 4000, 123456]) {
      for (const min of [0.5, 7, 12, 45]) {
        for (const s of [0, 0.15, 0.35, 0.6]) {
          for (const occ of [0.6, 0.85, 1]) {
            const [row] = runTeam({ weeklyVolumeByMonth: [v], minutesPerCase: min, shrinkage: s, targetOccupancy: occ, hoursPerFteWeek: 37.5, currentFte: 0, annualAttrition: 0 });
            const byHand = (v * min / 60) / (37.5 * (1 - s) * occ);
            expect(row.requiredFte).toBeCloseTo(byHand, 9);
            expect(requiredFte({ weekly_volume: v, minutes_per_case: min, shrinkage: s, target_occupancy: occ, hours_per_fte_week: 37.5 }).structured.fte).toBeCloseTo(byHand, 9);
          }
        }
      }
    }
  });

  it('FTE is linear in handling time, and the per-minute figure says by how much', () => {
    const a = requiredFte({ ...example, minutes_per_case: 12 }).structured;
    const b = requiredFte({ ...example, minutes_per_case: 13 }).structured;
    expect(b.fte - a.fte).toBeCloseTo(a.fte_per_extra_minute, 10);
  });

  it('rounds up to whole people without counting float noise as a person', () => {
    // 2380 cases x 12 min = 476 hours; 476 / 23.8 = exactly 20 FTE
    expect(requiredFte({ ...example, weekly_volume: 2380 }).structured.people).toBe(20);
    expect(requiredFte({ ...example, weekly_volume: 2381 }).structured.people).toBe(21);
  });

  it('more shrinkage or lower occupancy never needs fewer people', () => {
    let prev = 0;
    for (let s = 0; s <= 0.9; s += 0.05) {
      const f = requiredFte({ ...example, shrinkage: s }).structured.fte;
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
    expect(requiredFte({ ...example, target_occupancy: 0.7 }).structured.fte)
      .toBeGreaterThan(requiredFte({ ...example, target_occupancy: 0.9 }).structured.fte);
  });
});
