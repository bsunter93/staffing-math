import { describe, expect, it } from 'vitest';
import { hiringPlan, InputError, type HiringPlanArgs } from '../src/tools';
import { annualToMonthlyRate, runTeam } from '../src/engine';

const example: HiringPlanArgs = { weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3, monthly_growth: 0.05 };
const fteFor = (weekly: number) => (weekly * 12 / 60) / 23.8;

describe('hiring_plan: the worked example', () => {
  const r = hiringPlan(example).structured;

  it('runs 12 months by default and FTE needed follows the compounding forecast', () => {
    expect(r.months).toHaveLength(12);
    r.months.forEach((m, i) => {
      expect(m.weekly_volume).toBeCloseTo(4000 * 1.05 ** i, 6);
      expect(m.fte_needed).toBeCloseTo(fteFor(4000 * 1.05 ** i), 6);
    });
    expect(r.fte_needed_last_month).toBeCloseTo(57.49, 2);
  });

  it('assumes current headcount is what month 1 needs, rounded up', () => {
    expect(r.months[0].fte_on_hand).toBe(34);
    expect(r.inputs.find((i) => i.name === 'current headcount')!.source).toBe('assumed');
  });

  it('opens 30 requisitions and ends with 58 people against 57.49 needed', () => {
    expect(r.total_reqs).toBe(30);
    expect(r.months[11].fte_on_hand).toBe(58);
  });

  it('plans the last two months for hires who count after the plan, assuming growth continues', () => {
    // Month 13 needs 4000 x 1.05^12 x 0.2 / 23.8 = 60.36 FTE against 58 on hand: 3 more, opened in month 11.
    expect(r.lookahead_months).toBe(2);
    expect(fteFor(4000 * 1.05 ** 12)).toBeCloseTo(60.36, 2);
    expect(r.months[10].reqs_to_open).toBe(3);
    expect(r.months[11].reqs_to_open).toBe(3);
    expect(hiringPlan(example).text).toContain('Requisitions opened in months 11 and 12 are for hires who count in months 13 and 14, assuming the 5% monthly growth continues.');
  });

  it('reports month 2 as short because a requisition opened now counts from month 3', () => {
    expect(r.first_month_hires_can_count).toBe(3);
    expect(r.months_short_before_hires_land).toEqual([2]);
    expect(hiringPlan(example).text).toContain('Month 2 is short and new hires can\'t fix that');
  });
});

describe('hiring_plan: what the solver guarantees', () => {
  const cases: HiringPlanArgs[] = [
    example,
    { ...example, current_headcount: 30, annual_attrition: 0.3, time_to_hire_months: 2, ramp_months: 1 },
    { ...example, monthly_growth: -0.03, annual_attrition: 0.45, current_headcount: 50 },
    { weekly_volume_by_month: [900, 1400, 800, 2000, 2000, 600, 3000], minutes_per_case: 25, annual_attrition: 0.2, time_to_hire_months: 1 },
    { ...example, months: 36, annual_attrition: 0.35, time_to_hire_months: 3, ramp_months: 2 },
    { ...example, current_headcount: 30, annual_attrition: 0.3, ramp_months: 1, hires_in_flight: [{ month: 1, count: 3 }, { month: 2, count: 2 }, { month: 6, count: 4 }] },
  ];

  it('from the first month a hire can count, FTE on hand always covers FTE needed', () => {
    for (const c of cases) {
      const r = hiringPlan(c).structured;
      const lead = r.first_month_hires_can_count - 1;
      for (const m of r.months.slice(lead)) expect(m.fte_on_hand).toBeGreaterThanOrEqual(m.fte_needed - 1e-9);
    }
  });

  it('never hires more than it needs: removing any one requisition leaves some month short', () => {
    for (const c of cases) {
      const r = hiringPlan(c).structured;
      const lead = r.first_month_hires_can_count - 1;
      const reqs = r.months.map((m) => m.reqs_to_open);
      const current = r.inputs.find((i) => i.name === 'current headcount')!.value as number;
      // The solver looks past the plan when growth is given; check over the same window.
      const extra = r.lookahead_months;
      const vols = [...r.months.map((m) => m.weekly_volume)];
      for (let k = 0; k < extra; k++) vols.push(vols[vols.length - 1] * (1 + (c.monthly_growth ?? 0)));
      reqs.push(...new Array(extra).fill(0));
      const landings = [...r.months.map((m) => m.in_flight), ...new Array(extra).fill(0)];
      reqs.forEach((k, i) => {
        if (k === 0) return;
        const fewer = reqs.slice(); fewer[i] -= 1;
        const rows = runTeam({
          weeklyVolumeByMonth: vols,
          minutesPerCase: c.minutes_per_case, shrinkage: c.shrinkage ?? 0.3, targetOccupancy: 0.85,
          hoursPerFteWeek: 40, currentFte: current, annualAttrition: c.annual_attrition ?? 0,
          reqsByMonth: fewer, leadTimeMonths: lead, landingsByMonth: landings,
        });
        expect(rows.slice(lead).some((row) => row.availableFte < row.requiredFte - 1e-9)).toBe(true);
      });
    }
  });

  it('requisitions are whole people, and each lands exactly lead months later', () => {
    for (const c of cases) {
      const r = hiringPlan(c).structured;
      const lead = r.first_month_hires_can_count - 1;
      r.months.forEach((m, i) => {
        expect(Number.isInteger(m.reqs_to_open)).toBe(true);
        expect(m.reqs_to_open).toBeGreaterThanOrEqual(0);
        expect(m.hires_counting).toBe((i >= lead ? r.months[i - lead].reqs_to_open : 0) + m.in_flight);
      });
    }
  });

  it('applies attrition at the engine\'s compounding monthly rate', () => {
    const r = hiringPlan({ ...example, current_headcount: 40, annual_attrition: 0.24 }).structured;
    const ma = annualToMonthlyRate(0.24);
    expect(1 - (1 - ma) ** 12).toBeCloseTo(0.24, 12);
    expect(r.months[0].expected_leavers).toBeCloseTo(40 * ma, 12);
    expect(r.months[0].fte_on_hand).toBeCloseTo(40 * (1 - ma), 12);
    expect(r.months[1].expected_leavers).toBeCloseTo(r.months[0].fte_on_hand * ma, 12);
  });

  it('ramp delays when a hire counts exactly as much as extra time to hire', () => {
    const a = hiringPlan({ ...example, annual_attrition: 0.2, time_to_hire_months: 2, ramp_months: 1 }).structured;
    const b = hiringPlan({ ...example, annual_attrition: 0.2, time_to_hire_months: 3, ramp_months: 0 }).structured;
    expect(a.months.map((m) => m.reqs_to_open)).toEqual(b.months.map((m) => m.reqs_to_open));
  });

  it('flat volume, no attrition and a team staffed for it needs no requisitions', () => {
    const r = hiringPlan({ weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3 }).structured;
    expect(r.total_reqs).toBe(0);
    expect(hiringPlan({ weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3 }).text).toContain('Answer: no requisitions needed over 12 months.');
  });

  it('a team overstaffed for its work hires nothing until attrition takes it below the line', () => {
    const r = hiringPlan({ weekly_volume: 4000, minutes_per_case: 12, shrinkage: 0.3, current_headcount: 40, annual_attrition: 0.3 }).structured;
    const firstReq = r.months.findIndex((m) => m.reqs_to_open > 0);
    expect(firstReq).toBeGreaterThan(0);
    expect(r.months[firstReq + 2].fte_on_hand).toBeGreaterThanOrEqual(r.months[firstReq + 2].fte_needed);
  });

  it('with a month-by-month forecast too short for any hire to land, it plans none and says why', () => {
    const r = hiringPlan({ weekly_volume_by_month: [4000, 4200, 4410], minutes_per_case: 12, shrinkage: 0.3, time_to_hire_months: 3 });
    expect(r.structured.total_reqs).toBe(0);
    expect(r.text).toContain('past the end of this 3-month plan');
  });

  it('with a growth rate and a plan shorter than time to hire, every requisition is for after the plan', () => {
    const r = hiringPlan({ ...example, months: 3, time_to_hire_months: 3 }).structured;
    expect(r.lookahead_months).toBe(3);
    expect(r.months.every((m) => m.hires_counting === 0)).toBe(true);
    expect(r.total_reqs).toBeGreaterThan(0);
  });

  it('a monthly array plans the same as the growth form, except it invents nothing past its last month', () => {
    const vols = Array.from({ length: 12 }, (_, i) => 4000 * 1.05 ** i);
    const a = hiringPlan(example).structured;
    const b = hiringPlan({ weekly_volume_by_month: vols, minutes_per_case: 12, shrinkage: 0.3 });
    expect(b.structured.months.slice(0, 10).map((m) => m.reqs_to_open)).toEqual(a.months.slice(0, 10).map((m) => m.reqs_to_open));
    expect(b.structured.months.slice(10).map((m) => m.reqs_to_open)).toEqual([0, 0]);
    expect(b.structured.lookahead_months).toBe(0);
    expect(b.text).toContain('No requisitions are planned in the last 2 months: those hires would count after month 12.');
  });

  it('labels months from start_month across a year boundary', () => {
    const r = hiringPlan({ ...example, months: 3, start_month: '2027-11' }).structured;
    expect(r.months.map((m) => m.label)).toEqual(['Nov 2027', 'Dec 2027', 'Jan 2028']);
    expect(hiringPlan({ ...example, months: 2 }).structured.months.map((m) => m.label)).toEqual(['Month 1', 'Month 2']);
  });
});

describe('hiring_plan: hires already in flight', () => {
  const base: HiringPlanArgs = { ...example, current_headcount: 30, annual_attrition: 0.3, ramp_months: 1 };
  const without = hiringPlan(base).structured;
  const withIn = hiringPlan({ ...base, hires_in_flight: [{ month: 1, count: 3 }, { month: 2, count: 2 }] }).structured;

  it('count as capacity from their own month, before any new requisition could land', () => {
    expect(withIn.months[0].in_flight).toBe(3);
    expect(withIn.months[1].in_flight).toBe(2);
    expect(withIn.months[0].fte_on_hand - without.months[0].fte_on_hand).toBeCloseTo(3, 9);
    expect(withIn.months[0].short_or_spare).toBeGreaterThan(without.months[0].short_or_spare);
  });

  it('are subtracted from what the plan has to open', () => {
    expect(withIn.total_reqs).toBeLessThan(without.total_reqs);
    expect(withIn.inputs.find((i) => i.name === 'hires in flight')!.shown).toBe('3 counting from month 1, 2 counting from month 2');
  });

  it('are named in the short-month note only when none were given', () => {
    expect(hiringPlan(base).text).toContain('give them as hires_in_flight');
    expect(hiringPlan({ ...base, hires_in_flight: [{ month: 1, count: 1 }] }).text).not.toContain('give them as hires_in_flight');
  });

  it('reject months outside the plan and partial people', () => {
    expect(() => hiringPlan({ ...base, hires_in_flight: [{ month: 13, count: 1 }] })).toThrow(/from 1 to 12/);
    expect(() => hiringPlan({ ...base, hires_in_flight: [{ month: 0, count: 1 }] })).toThrow(/count from month 1/);
    expect(() => hiringPlan({ ...base, hires_in_flight: [{ month: 2, count: 1.5 }] })).toThrow(/whole number of people/);
  });
});

describe('hiring_plan: what it says about assumed inputs and spare months', () => {
  it('when attrition is assumed, gives the plan at 15% and 30%, and those match a real run', () => {
    const r = hiringPlan(example);
    const at = (rate: number) => hiringPlan({ ...example, annual_attrition: rate }).structured.total_reqs;
    expect(r.structured.attrition_range).toEqual([
      { annual_attrition: 0.15, total_reqs: at(0.15) },
      { annual_attrition: 0.3, total_reqs: at(0.3) },
    ]);
    expect(r.text).toContain(`Attrition was assumed to be 0%. At 15% a year this plan needs ${at(0.15)} requisitions; at 30%, ${at(0.3)}.`);
  });

  it('gives no attrition range when attrition was given', () => {
    const r = hiringPlan({ ...example, annual_attrition: 0.2 });
    expect(r.structured.attrition_range).toEqual([]);
    expect(r.text).not.toContain('Attrition was assumed');
  });

  it('says out loud when current headcount was assumed to be fully staffed', () => {
    expect(hiringPlan(example).text).toContain('as if the team is fully staffed today');
    expect(hiringPlan({ ...example, current_headcount: 30 }).text).not.toContain('fully staffed today');
  });

  it('names the month with the most spare FTE, counting only whole people', () => {
    const r = hiringPlan({ weekly_volume_by_month: [900, 1400, 800, 2000, 2000, 600, 3000], minutes_per_case: 25, annual_attrition: 0.2, time_to_hire_months: 1 });
    const spares = r.structured.months.filter((m) => m.short_or_spare >= 1).map((m) => m.month);
    expect(r.structured.months_with_spare).toEqual(spares);
    expect(r.structured.most_spare!.month).toBe(6);
    expect(r.structured.most_spare!.fte).toBeCloseTo(r.structured.months[5].short_or_spare, 9);
    expect(r.text).toContain('Month 6 has 24.7 FTE more than it needs, the most of any month; 1 other month also has at least one spare FTE.');
  });

  it('reports no spare month when every month is within one FTE of its need', () => {
    const r = hiringPlan(example).structured;
    expect(r.months_with_spare).toEqual([]);
    expect(r.most_spare).toBeNull();
  });
});

describe('hiring_plan: input errors are readable', () => {
  it('rejects both volume forms at once', () => {
    expect(() => hiringPlan({ ...example, weekly_volume_by_month: [1, 2] })).toThrow(InputError);
  });
  it('rejects no volume at all', () => {
    expect(() => hiringPlan({ minutes_per_case: 12 })).toThrow(/Give weekly_volume/);
  });
  it('rejects a plan length that disagrees with the monthly array', () => {
    expect(() => hiringPlan({ weekly_volume_by_month: [1, 2, 3], months: 4, minutes_per_case: 12 })).toThrow(/months is 4/);
  });
  it('rejects a start month that is not YYYY-MM', () => {
    expect(() => hiringPlan({ ...example, start_month: 'January' })).toThrow(/must look like 2027-01/);
  });
});
