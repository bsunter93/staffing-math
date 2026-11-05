/**
 * The bridge to the Operating Model Simulator engine.
 *
 * Everything this server reports about FTE, attrition and hires landing comes from the
 * engine's own run(). This file only builds the one-team model it needs, converting the
 * weekly units planners use into the monthly units the engine works in.
 */
import { addMonths, annualToMonthlyRate, run } from '../vendor/operating-model-simulator/src/engine';
import type { MonthKey, OperatingModel, Scenario, ScenarioEffect } from '../vendor/operating-model-simulator/src/models/types';
import type { TeamMonth } from '../vendor/operating-model-simulator/src/models/results';

export { annualToMonthlyRate, erlangC, serviceLevel, staffFor } from '../vendor/operating-model-simulator/src/engine';

/** The upstream commit the vendored engine was copied from. check-vendor.sh reads it. */
export const ENGINE_COMMIT = '758c9d770be8cfb8e244a93897357dfe2d231b4e';
export const ENGINE_SOURCE = 'https://github.com/bsunter93/operating-model-simulator';

/** 52 weeks over 12 months. The engine is monthly; planners think in weeks. */
export const WEEKS_PER_MONTH = 52 / 12;

/**
 * The engine needs a calendar. When the reader gives no start month the plan is labeled
 * Month 1, Month 2 and so on, and this anchor never appears in any output.
 */
const ANCHOR: MonthKey = '2001-01';

const TEAM = 'team';
const STREAM = 'work';

export interface TeamInputs {
  /** Weekly volume in each month of the plan. Length is the plan length. */
  weeklyVolumeByMonth: number[];
  minutesPerCase: number;
  shrinkage: number;
  targetOccupancy: number;
  hoursPerFteWeek: number;
  currentFte: number;
  annualAttrition: number;
  /** Requisitions opened in each month (index = month), whole people. */
  reqsByMonth?: number[];
  /** Months from opening a requisition to the hire counting as capacity. */
  leadTimeMonths?: number;
  /** People already hired or in the pipeline, by the month (index) they start counting. */
  landingsByMonth?: number[];
  startMonth?: MonthKey;
}

export interface EngineMonth {
  /** 0-based month index. */
  index: number;
  weeklyVolume: number;
  /** Hours of work per week arriving this month. */
  weeklyWorkHours: number;
  requiredFte: number;
  startingFte: number;
  attritionLoss: number;
  hiresLanded: number;
  availableFte: number;
  /** required minus available, floored at zero, exactly as the engine reports it. */
  workforceGap: number;
  utilization: number;
}

/**
 * Build the one-team model. Volume over time is expressed the way the engine already
 * expresses a demand change: a combined scenario of month-on-month demand multipliers,
 * each taking effect from its own month. Seasonality is flat, so month one's volume is
 * exactly annualVolume / 12.
 */
export function oneTeamModel(p: TeamInputs): { model: OperatingModel; scenario: Scenario } {
  const n = p.weeklyVolumeByMonth.length;
  if (n < 1) throw new Error('the plan needs at least one month');
  const start = p.startMonth ?? ANCHOR;
  const year = Number(start.slice(0, 4));
  const seasonality: Record<MonthKey, number> = {};
  for (let m = 1; m <= 12; m++) seasonality[`${year}-${String(m).padStart(2, '0')}`] = 1;

  const v = p.weeklyVolumeByMonth;
  const effects: ScenarioEffect[] = [];
  for (let m = 1; m < n; m++) {
    effects.push({ type: 'demandMultiplier', demandMultiplier: v[m] / v[m - 1], fromMonth: addMonths(start, m) });
  }
  const scenario: Scenario = effects.length
    ? { id: 'forecast', name: 'Forecast', type: 'combined', effects }
    : { id: 'base', name: 'Base', type: 'base' };

  const lead = p.leadTimeMonths ?? 0;
  const reqs = p.reqsByMonth ?? [];
  const landings = p.landingsByMonth ?? [];

  const model: OperatingModel = {
    modelVersion: '3.0',
    id: 'staffing-math',
    name: 'One team',
    status: 'provisional',
    calendar: { startMonth: start, endMonth: addMonths(start, n - 1), workHoursPerFteMonth: p.hoursPerFteWeek * WEEKS_PER_MONTH },
    strategy: { revenueTarget: 0, growthTargetPct: 0, employeeCount: 0, enterpriseCustomers: 0, operatingCostTarget: 0, strategicPriorities: [] },
    teams: [{
      id: TEAM, name: 'Team', teamType: 'operational',
      currentFte: p.currentFte, annualAttrition: p.annualAttrition,
      shrinkage: p.shrinkage, targetUtilization: p.targetOccupancy, monthlyFteCost: 0,
    }],
    seasonality,
    demandStreams: [{
      id: STREAM, name: 'Work', teamId: TEAM, unit: 'case',
      annualVolume: v[0] * 52,
      handlingMinutesPerUnit: p.minutesPerCase, complexityFactor: 1,
      workMix: { reusable: 1, configurable: 0, bespoke: 0 },
      seasonality: 'default',
    }],
    hiringPlan: [
      ...reqs.flatMap((headcount, m) => headcount > 0
        ? [{ id: `req-${m + 1}`, teamId: TEAM, requestMonth: addMonths(start, m), headcount, leadTimeMonths: lead }]
        : []),
      // Hires already on their way are requests that land in their own month, with no lead time left.
      ...landings.flatMap((headcount, m) => headcount > 0
        ? [{ id: `in-flight-${m + 1}`, teamId: TEAM, requestMonth: addMonths(start, m), headcount, leadTimeMonths: 0 }]
        : []),
    ],
    initiatives: [],
    dependencies: [],
    budget: { modeledAnnualBudget: 0 },
    pooling: { clientCount: 1, workloadPerClient: 1, ahtSeconds: 1, targetSeconds: 1, serviceLevel: 0.8, bespokeShare: 0, contextPenalty: 0 },
    scenarios: effects.length ? [{ id: 'base', name: 'Base', type: 'base' }, scenario] : [scenario],
    interventions: [],
    decisionWeights: { cost: 1, speed: 0, revenueExposure: 0 },
  };
  return { model, scenario };
}

/** Run the engine on one team and return its months in weekly units. */
export function runTeam(p: TeamInputs): EngineMonth[] {
  const { model, scenario } = oneTeamModel(p);
  const result = run(model, { scenario: scenario.id });
  const rows: TeamMonth[] = result.teams[0].months;
  return rows.map((r) => ({
    index: r.monthIndex,
    weeklyVolume: p.weeklyVolumeByMonth[r.monthIndex],
    weeklyWorkHours: r.runHours / WEEKS_PER_MONTH,
    requiredFte: r.requiredFte,
    startingFte: r.startingFte,
    attritionLoss: r.attritionLoss,
    hiresLanded: r.hiresLanded,
    availableFte: r.availableFte,
    workforceGap: r.workforceGap,
    utilization: r.utilization,
  }));
}

export function monthlyAttritionRate(annual: number): number {
  return annualToMonthlyRate(annual);
}
