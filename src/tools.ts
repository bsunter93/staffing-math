/**
 * The three tools as plain functions: arguments in, an answer with its working out.
 * No MCP here, so every number can be tested without a client.
 */
import { ENGINE_COMMIT, erlangC, monthlyAttritionRate, runTeam, serviceLevel, staffFor, type EngineMonth } from './engine';

export const DEFAULTS = {
  shrinkage: 0.3,
  target_occupancy: 0.85,
  hours_per_fte_week: 40,
  months: 12,
  annual_attrition: 0,
  time_to_hire_months: 2,
  ramp_months: 0,
  answer_within_seconds: 20,
  service_level: 0.8,
} as const;

export type Source = 'given' | 'assumed';

export interface InputLine {
  name: string;
  value: number | string | number[];
  shown: string;
  source: Source;
}

export interface ToolAnswer<S> {
  text: string;
  /**
   * Everything the text says, as data. Some hosts hand the model only structuredContent,
   * so the answer and every caveat have to be in here as well as in the text.
   */
  structured: S & { answer: string; notes: string[]; inputs: InputLine[]; steps: string[]; engine: string };
}

const ENGINE_NOTE = `Operating Model Simulator engine, commit ${ENGINE_COMMIT.slice(0, 7)}`;

/* Formatting is pinned to en-US so the same inputs always print the same text. */
const nf = (digits: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmt = {
  n0: (x: number) => nf(0).format(x),
  n1: (x: number) => nf(1).format(x),
  n2: (x: number) => nf(2).format(x),
  pct: (x: number) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(x * 100)}%`,
  pct1: (x: number) => `${nf(1).format(x * 100)}%`,
  signed: (x: number) => (x >= 0 ? '+' : '-') + nf(2).format(Math.abs(x)),
};

/** Rounds up to whole people without turning 34.0000000001 into 35. */
export const wholePeople = (fte: number) => Math.max(0, Math.ceil(fte - 1e-9));

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listOf = (xs: number[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const shownOf = (lines: InputLine[], name: string) => lines.find((l) => l.name === name)!.shown;

function pick<T>(given: T | undefined, fallback: T): { value: T; source: Source } {
  return given === undefined ? { value: fallback, source: 'assumed' } : { value: given, source: 'given' };
}

function inputsBlock(lines: InputLine[]): string {
  return lines.map((l) => `- ${l.name}: ${l.shown} (${l.source})`).join('\n');
}

function assumedLines(lines: InputLine[]): string[] {
  const a = lines.filter((l) => l.source === 'assumed').map((l) => l.name);
  return a.length ? [`Assumed, not given: ${a.join(', ')}. Tell the user and offer to rerun with their numbers.`] : [];
}

function assumedNote(lines: InputLine[]): string {
  return assumedLines(lines).map((l) => `\n${l}`).join('');
}

/* ------------------------------------------------------------------ required_fte */

export interface RequiredFteArgs {
  weekly_volume: number;
  minutes_per_case: number;
  shrinkage?: number;
  target_occupancy?: number;
  hours_per_fte_week?: number;
}

export interface RequiredFteResult {
  fte: number;
  people: number;
  weekly_work_hours: number;
  productive_hours_per_fte_week: number;
  planned_hours_per_fte_week: number;
  fte_per_extra_minute: number;
}

/** Productive and planned hours per person per week, shared by two tools. */
function perPerson(hours: number, shrinkage: number, occupancy: number) {
  const productive = hours * (1 - shrinkage);
  return { productive, planned: productive * occupancy };
}

export function requiredFte(a: RequiredFteArgs): ToolAnswer<RequiredFteResult> {
  const shrinkage = pick(a.shrinkage, DEFAULTS.shrinkage);
  const occ = pick(a.target_occupancy, DEFAULTS.target_occupancy);
  const hours = pick(a.hours_per_fte_week, DEFAULTS.hours_per_fte_week);

  const [row] = runTeam({
    weeklyVolumeByMonth: [a.weekly_volume], minutesPerCase: a.minutes_per_case,
    shrinkage: shrinkage.value, targetOccupancy: occ.value, hoursPerFteWeek: hours.value,
    currentFte: 0, annualAttrition: 0,
  });
  const fte = row.requiredFte;

  // The same figure by hand, to print. If the two ever disagree the server says so.
  const work = (a.weekly_volume * a.minutes_per_case) / 60;
  const { productive, planned } = perPerson(hours.value, shrinkage.value, occ.value);
  const byHand = work / planned;
  if (Math.abs(byHand - fte) > 1e-9 * Math.max(1, fte)) {
    throw new Error(`internal check failed: engine says ${fte}, arithmetic says ${byHand}`);
  }
  const people = wholePeople(fte);
  const perMinute = a.weekly_volume / 60 / planned;

  const inputs: InputLine[] = [
    { name: 'weekly volume', value: a.weekly_volume, shown: `${fmt.n0(a.weekly_volume)} cases`, source: 'given' },
    { name: 'minutes per case', value: a.minutes_per_case, shown: `${fmt.n2(a.minutes_per_case).replace(/\.00$/, '')}`, source: 'given' },
    { name: 'shrinkage', value: shrinkage.value, shown: fmt.pct(shrinkage.value), source: shrinkage.source },
    { name: 'target occupancy', value: occ.value, shown: fmt.pct(occ.value), source: occ.source },
    { name: 'hours per FTE per week', value: hours.value, shown: fmt.n2(hours.value).replace(/\.00$/, ''), source: hours.source },
  ];
  const steps = [
    `Work per week = ${fmt.n0(a.weekly_volume)} cases x ${inputs[1].shown} min / 60 = ${fmt.n1(work)} hours`,
    `Productive hours per FTE = ${inputs[4].shown} x (1 - ${shrinkage.value}) = ${fmt.n2(productive)} hours`,
    `Planned hours per FTE at ${fmt.pct(occ.value)} occupancy = ${fmt.n2(productive)} x ${occ.value} = ${fmt.n2(planned)} hours`,
    `FTE needed = ${fmt.n1(work)} / ${fmt.n2(planned)} = ${fmt.n2(fte)}`,
    `People to staff = ${fmt.n2(fte)} rounded up = ${people}`,
  ];
  const answer = `${fmt.n2(fte)} FTE, so ${people} people.`;
  const notes = [`Each extra minute per case adds ${fmt.n2(perMinute)} FTE.`, ...assumedLines(inputs)];
  const text = [
    `Answer: ${answer}`,
    '',
    'Inputs',
    inputsBlock(inputs),
    '',
    'Arithmetic',
    steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    `Each extra minute per case adds ${fmt.n2(perMinute)} FTE.`,
    `Computed by the ${ENGINE_NOTE}.${assumedNote(inputs)}`,
  ].join('\n');

  return {
    text,
    structured: {
      fte, people, weekly_work_hours: work,
      productive_hours_per_fte_week: productive, planned_hours_per_fte_week: planned,
      fte_per_extra_minute: perMinute,
      answer, notes, inputs, steps, engine: ENGINE_NOTE,
    },
  };
}

/* ------------------------------------------------------------------ hiring_plan */

export interface HiringPlanArgs extends Omit<RequiredFteArgs, 'weekly_volume'> {
  weekly_volume?: number;
  monthly_growth?: number;
  weekly_volume_by_month?: number[];
  months?: number;
  current_headcount?: number;
  annual_attrition?: number;
  time_to_hire_months?: number;
  ramp_months?: number;
  start_month?: string;
  /** People already hired or in the pipeline: how many, and the plan month they start counting. */
  hires_in_flight?: { month: number; count: number }[];
}

export interface PlanMonth {
  month: number;
  label: string;
  weekly_volume: number;
  fte_needed: number;
  reqs_to_open: number;
  hires_counting: number;
  expected_leavers: number;
  fte_on_hand: number;
  short_or_spare: number;
  /** Of hires_counting, how many were already in flight rather than opened by this plan. */
  in_flight: number;
}

export interface HiringPlanResult {
  total_reqs: number;
  first_month_hires_can_count: number;
  fte_needed_first_month: number;
  fte_needed_last_month: number;
  expected_leavers: number;
  months_short_before_hires_land: number[];
  /** Months past the plan the solver looked at so the final months' requisitions are planned. */
  lookahead_months: number;
  /** Months with at least one whole FTE more than they need, and the largest such month. */
  months_with_spare: number[];
  most_spare: { month: number; fte: number } | null;
  /** When attrition was assumed rather than given: the same plan at reference rates. Empty otherwise. */
  attrition_range: { annual_attrition: number; total_reqs: number }[];
  months: PlanMonth[];
}

/** Rates the plan is rerun at when the reader didn't give one. References, not benchmarks. */
export const ATTRITION_REFERENCE = [0.15, 0.3];
/** Less than one whole person over is rounding, not a spare month. */
const SPARE_FTE = 1;

export class InputError extends Error {}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function labelFor(i: number, start?: string): string {
  if (!start) return `Month ${i + 1}`;
  const y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7)) - 1 + i;
  return `${MONTH_NAMES[m % 12]} ${y + Math.floor(m / 12)}`;
}

export function hiringPlan(a: HiringPlanArgs): ToolAnswer<HiringPlanResult> {
  const hasArray = Array.isArray(a.weekly_volume_by_month) && a.weekly_volume_by_month.length > 0;
  if (hasArray && (a.weekly_volume !== undefined || a.monthly_growth !== undefined)) {
    throw new InputError('Give either weekly_volume_by_month, or weekly_volume with monthly_growth, not both.');
  }
  if (!hasArray && a.weekly_volume === undefined) {
    throw new InputError('Give weekly_volume (with optional monthly_growth), or weekly_volume_by_month.');
  }
  if (hasArray && a.months !== undefined && a.months !== a.weekly_volume_by_month!.length) {
    throw new InputError(`months is ${a.months} but weekly_volume_by_month has ${a.weekly_volume_by_month!.length} entries.`);
  }
  if (a.start_month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(a.start_month)) {
    throw new InputError(`start_month "${a.start_month}" must look like 2027-01.`);
  }

  const shrinkage = pick(a.shrinkage, DEFAULTS.shrinkage);
  const occ = pick(a.target_occupancy, DEFAULTS.target_occupancy);
  const hours = pick(a.hours_per_fte_week, DEFAULTS.hours_per_fte_week);
  const attrition = pick(a.annual_attrition, DEFAULTS.annual_attrition);
  const tth = pick(a.time_to_hire_months, DEFAULTS.time_to_hire_months);
  const ramp = pick(a.ramp_months, DEFAULTS.ramp_months);

  let volumes: number[];
  let volumeLine: InputLine;
  const extraLines: InputLine[] = [];
  let growth: number | null = null;
  if (hasArray) {
    volumes = a.weekly_volume_by_month!.slice();
    volumeLine = { name: 'weekly volume by month', value: volumes, shown: volumes.map(fmt.n0).join(', '), source: 'given' };
  } else {
    const months = pick(a.months, DEFAULTS.months);
    const g = pick(a.monthly_growth, 0);
    growth = g.value;
    volumes = Array.from({ length: months.value }, (_, m) => a.weekly_volume! * Math.pow(1 + g.value, m));
    volumeLine = { name: 'weekly volume in month 1', value: a.weekly_volume!, shown: `${fmt.n0(a.weekly_volume!)} cases`, source: 'given' };
    extraLines.push(
      { name: 'monthly growth', value: g.value, shown: g.value === 0 ? 'none' : `${g.value > 0 ? '' : '-'}${fmt.pct(Math.abs(g.value))} a month, compounding`, source: g.source },
      { name: 'plan length', value: months.value, shown: plural(months.value, 'month'), source: months.source },
    );
  }
  const n = volumes.length;
  const lead = tth.value + ramp.value;

  const inFlight = a.hires_in_flight ?? [];
  for (const h of inFlight) {
    if (!Number.isInteger(h.month) || h.month < 1 || h.month > n) {
      throw new InputError(`hires_in_flight month ${h.month} must be a whole month from 1 to ${n}. Hires before month 1 count from month 1.`);
    }
    if (!Number.isInteger(h.count) || h.count < 1) throw new InputError(`hires_in_flight count ${h.count} must be a whole number of people.`);
  }

  /*
   * Requisitions opened in the last `lead` months land after the plan ends. With a growth
   * rate the forecast can be carried that far, so those months still get their hiring;
   * the extra months are solved and then dropped from what's reported. A month-by-month
   * forecast stops where the reader stopped it, so nothing past it is invented.
   */
  const lookahead = growth === null ? 0 : lead;
  const solved = growth === null
    ? volumes
    : Array.from({ length: n + lookahead }, (_, m) => a.weekly_volume! * Math.pow(1 + growth!, m));

  const base = {
    weeklyVolumeByMonth: solved, minutesPerCase: a.minutes_per_case,
    shrinkage: shrinkage.value, targetOccupancy: occ.value, hoursPerFteWeek: hours.value,
    annualAttrition: attrition.value, leadTimeMonths: lead, startMonth: a.start_month,
  };

  // Current headcount defaults to what month 1 needs, rounded up: staffed for today.
  let current: { value: number; source: Source };
  if (a.current_headcount !== undefined) current = { value: a.current_headcount, source: 'given' };
  else {
    const [m1] = runTeam({ ...base, weeklyVolumeByMonth: [volumes[0]], currentFte: 0, leadTimeMonths: 0 });
    current = { value: wholePeople(m1.requiredFte), source: 'assumed' };
  }

  const landings = new Array<number>(solved.length).fill(0);
  for (const h of inFlight) landings[h.month - 1] += h.count;

  /*
   * The solver. Walk the months in order. Where the engine says FTE on hand is short of
   * FTE needed, open that many requisitions (whole people) in the month that lands them
   * in time, and run the engine again. A hire only changes its landing month and later,
   * so earlier months never move once settled. Hires already in flight are in every run.
   */
  const solve = (annual: number) => {
    const reqs = new Array<number>(solved.length).fill(0);
    const runWith = () => runTeam({ ...base, annualAttrition: annual, currentFte: current.value, reqsByMonth: reqs, landingsByMonth: landings });
    let all: EngineMonth[] = runWith();
    for (let m = lead; m < solved.length; m++) {
      const gap = all[m].workforceGap;
      if (gap > 1e-9) {
        reqs[m - lead] += wholePeople(gap);
        all = runWith();
      }
    }
    return { reqs, all };
  };
  const { reqs, all } = solve(attrition.value);
  const rows = all.slice(0, n);

  const months: PlanMonth[] = rows.map((r, i) => ({
    month: i + 1,
    label: labelFor(i, a.start_month),
    weekly_volume: r.weeklyVolume,
    fte_needed: r.requiredFte,
    reqs_to_open: reqs[i],
    hires_counting: r.hiresLanded,
    expected_leavers: r.attritionLoss,
    fte_on_hand: r.availableFte,
    short_or_spare: r.availableFte - r.requiredFte,
    in_flight: landings[i],
  }));
  const totalReqs = reqs.slice(0, n).reduce((x, y) => x + y, 0);
  const leavers = rows.reduce((x, r) => x + r.attritionLoss, 0);
  const shortEarly = months.filter((m, i) => i < lead && m.short_or_spare < -1e-9).map((m) => m.month);
  const spare = months.filter((m) => m.short_or_spare >= SPARE_FTE);
  const mostSpare = spare.reduce<PlanMonth | null>((best, m) => (!best || m.short_or_spare > best.short_or_spare ? m : best), null);
  const attritionRange = attrition.source === 'assumed'
    ? ATTRITION_REFERENCE.map((rate) => ({ annual_attrition: rate, total_reqs: solve(rate).reqs.slice(0, n).reduce((x, y) => x + y, 0) }))
    : [];
  const ma = monthlyAttritionRate(attrition.value);

  const inputs: InputLine[] = [
    volumeLine,
    ...extraLines,
    { name: 'minutes per case', value: a.minutes_per_case, shown: fmt.n2(a.minutes_per_case).replace(/\.00$/, ''), source: 'given' },
    { name: 'shrinkage', value: shrinkage.value, shown: fmt.pct(shrinkage.value), source: shrinkage.source },
    { name: 'target occupancy', value: occ.value, shown: fmt.pct(occ.value), source: occ.source },
    { name: 'hours per FTE per week', value: hours.value, shown: fmt.n2(hours.value).replace(/\.00$/, ''), source: hours.source },
    { name: 'current headcount', value: current.value, shown: `${fmt.n2(current.value).replace(/\.00$/, '')}${current.source === 'assumed' ? ' (what month 1 needs, rounded up)' : ''}`, source: current.source },
    { name: 'annual attrition', value: attrition.value, shown: fmt.pct(attrition.value), source: attrition.source },
    { name: 'time to hire', value: tth.value, shown: plural(tth.value, 'month'), source: tth.source },
    { name: 'ramp to full productivity', value: ramp.value, shown: plural(ramp.value, 'month'), source: ramp.source },
  ];
  if (a.start_month) inputs.push({ name: 'start month', value: a.start_month, shown: a.start_month, source: 'given' });
  if (inFlight.length) {
    const byMonth = landings.slice(0, n).flatMap((c, i) => (c > 0 ? [`${c} counting from month ${i + 1}`] : []));
    inputs.push({ name: 'hires in flight', value: landings.slice(0, n).reduce((x, y) => x + y, 0), shown: byMonth.join(', '), source: 'given' });
  }

  const { productive, planned } = perPerson(hours.value, shrinkage.value, occ.value);
  const steps = [
    `Planned hours per FTE per week = ${shownOf(inputs, 'hours per FTE per week')} x (1 - ${shrinkage.value}) x ${occ.value} = ${fmt.n2(planned)} (productive hours ${fmt.n2(productive)})`,
    `FTE needed each month = weekly volume x ${shownOf(inputs, 'minutes per case')} / 60 / ${fmt.n2(planned)}`,
    `Monthly attrition rate = 1 - (1 - ${attrition.value})^(1/12) = ${fmt.pct(ma)}; expected leavers = FTE at the start of the month x that rate`,
    `A requisition opened in month m counts as capacity from month m + ${lead} (${tth.value} to hire + ${ramp.value} to ramp). Until then the hire counts as zero.`,
    `Each month from month ${lead + 1}: if FTE on hand is below FTE needed, open the shortfall rounded up to whole people in month m - ${lead}`,
    `FTE on hand = last month's FTE - expected leavers + hires counting this month${inFlight.length ? ' (including hires already in flight)' : ''}`,
  ];

  const table = [
    '| Month | Weekly volume | FTE needed | Reqs to open | Hires counting | Expected leavers | FTE on hand | Spare (+) / short (-) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...months.map((m) => `| ${m.label} | ${fmt.n0(m.weekly_volume)} | ${fmt.n2(m.fte_needed)} | ${m.reqs_to_open} | ${fmt.n0(m.hires_counting)} | ${fmt.n2(m.expected_leavers)} | ${fmt.n2(m.fte_on_hand)} | ${fmt.signed(m.short_or_spare)} |`),
  ].join('\n');

  const firstCount = lead + 1;
  const notes: string[] = [];
  const tailStart = Math.max(0, n - lead);
  const tailReqs = reqs.slice(tailStart, n).reduce((x, y) => x + y, 0);
  if (lookahead > 0 && tailReqs > 0) {
    const span = (a1: number, b1: number) => (a1 === b1 ? `month ${a1}` : b1 === a1 + 1 ? `months ${a1} and ${b1}` : `months ${a1} to ${b1}`);
    notes.push(`Requisitions opened in ${span(tailStart + 1, n)} are for hires who count in ${span(n + 1, n + lookahead)}, assuming ${growth === 0 ? 'volume stays flat' : `the ${fmt.pct(growth!)} monthly growth continues`}.`);
  }
  if (growth === null && lead > 0) {
    notes.push(lead >= n
      ? `A requisition opened now can't count before month ${firstCount}, which is past the end of this ${n}-month plan, so no hires are planned.`
      : `No requisitions are planned in the ${lead === 1 ? 'last month' : `last ${lead} months`}: those hires would count after month ${n}. Add months to the forecast to plan them.`);
  }
  if (shortEarly.length) {
    const which = shortEarly.length === 1 ? `Month ${shortEarly[0]} is` : `Months ${listOf(shortEarly)} are`;
    notes.push(`${which} short and new hires can't fix that: the earliest a requisition opened now counts is month ${firstCount}. Covering it takes overtime, contractors or moving people.${inFlight.length ? '' : ' People already hired or in the pipeline can count earlier: give them as hires_in_flight.'}`);
  }
  if (mostSpare) {
    const others = spare.length - 1;
    notes.push(`${mostSpare.label} has ${fmt.n1(mostSpare.short_or_spare)} FTE more than it needs, the most of any month${others ? `; ${plural(others, 'other month')} also ${others === 1 ? 'has' : 'have'} at least one spare FTE` : ''}.`);
  }
  if (attritionRange.length) {
    const [lo, hi] = attritionRange;
    notes.push(`Attrition was assumed to be ${fmt.pct(attrition.value)}. At ${fmt.pct(lo.annual_attrition)} a year this plan needs ${plural(lo.total_reqs, 'requisition')}; at ${fmt.pct(hi.annual_attrition)}, ${hi.total_reqs}. Ask for the team's real rate.`);
  }
  if (current.source === 'assumed') {
    notes.push(`Current headcount was assumed to be exactly what month 1 needs (${fmt.n0(current.value)}), as if the team is fully staffed today. If it has fewer people, give current_headcount.`);
  }

  const answer = totalReqs === 0
    ? `No requisitions needed over ${n} months.`
    : `Open ${totalReqs} requisition${totalReqs === 1 ? '' : 's'} over ${n} months, ${reqs[0]} of them in month 1.`;
  const range = `FTE needed goes from ${fmt.n2(months[0].fte_needed)} in month 1 to ${fmt.n2(months[n - 1].fte_needed)} in month ${n}. Expected leavers over the plan: ${fmt.n1(leavers)}.`;
  const text = [
    `Answer: ${answer[0].toLowerCase()}${answer.slice(1)}`,
    range,
    ...notes,
    '',
    'Inputs',
    inputsBlock(inputs),
    '',
    'Arithmetic',
    steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    table,
    '',
    `Computed by the ${ENGINE_NOTE}.${assumedNote(inputs)}`,
  ].join('\n');

  return {
    text,
    structured: {
      total_reqs: totalReqs,
      first_month_hires_can_count: firstCount,
      fte_needed_first_month: months[0].fte_needed,
      fte_needed_last_month: months[n - 1].fte_needed,
      expected_leavers: leavers,
      months_short_before_hires_land: shortEarly,
      lookahead_months: lookahead,
      months_with_spare: spare.map((m) => m.month),
      most_spare: mostSpare ? { month: mostSpare.month, fte: mostSpare.short_or_spare } : null,
      attrition_range: attritionRange,
      months,
      answer, notes: [range, ...notes, ...assumedLines(inputs)], inputs, steps, engine: ENGINE_NOTE,
    },
  };
}

/* ------------------------------------------------------------------ erlang_staffing */

export interface ErlangArgs {
  contacts_per_hour: number;
  handle_time_seconds: number;
  answer_within_seconds?: number;
  service_level?: number;
  shrinkage?: number;
}

export interface ErlangResult {
  agents: number;
  service_level_at_agents: number;
  service_level_one_fewer: number | null;
  offered_load_erlangs: number;
  probability_of_waiting: number;
  occupancy: number;
  people_to_schedule: number;
}

export function erlangStaffing(a: ErlangArgs): ToolAnswer<ErlangResult> {
  const target = pick(a.answer_within_seconds, DEFAULTS.answer_within_seconds);
  const sl = pick(a.service_level, DEFAULTS.service_level);
  const shrinkage = pick(a.shrinkage, DEFAULTS.shrinkage);
  const aht = a.handle_time_seconds;

  const load = (a.contacts_per_hour * aht) / 3600;
  const agents = staffFor(load, aht, target.value, sl.value);
  const slAt = agents > 0 ? serviceLevel(agents, load, aht, target.value) : 1;
  const slPrev = agents > 1 ? serviceLevel(agents - 1, load, aht, target.value) : null;
  const pWait = agents > 0 ? erlangC(agents, load) : 0;
  const occupancy = agents > 0 ? load / agents : 0;
  const scheduledFte = agents / (1 - shrinkage.value);
  const people = wholePeople(scheduledFte);

  const inputs: InputLine[] = [
    { name: 'contacts per hour', value: a.contacts_per_hour, shown: fmt.n2(a.contacts_per_hour).replace(/\.00$/, ''), source: 'given' },
    { name: 'handle time', value: aht, shown: `${fmt.n2(aht).replace(/\.00$/, '')} seconds`, source: 'given' },
    { name: 'answer within', value: target.value, shown: `${target.value} seconds`, source: target.source },
    { name: 'service level target', value: sl.value, shown: fmt.pct(sl.value), source: sl.source },
    { name: 'shrinkage', value: shrinkage.value, shown: fmt.pct(shrinkage.value), source: shrinkage.source },
  ];
  const steps = [
    `Offered load = ${inputs[0].shown} contacts x ${inputs[1].shown} / 3,600 = ${fmt.n2(load)} Erlangs (agents' worth of work arriving at once, on average)`,
    `Service level with N agents = 1 - ErlangC(N, ${fmt.n2(load)}) x e^(-(N - ${fmt.n2(load)}) x ${target.value} / ${fmt.n2(aht).replace(/\.00$/, '')})`,
    slPrev === null
      ? `Smallest N reaching ${fmt.pct(sl.value)} within ${target.value} seconds: ${agents} (${fmt.pct1(slAt)})`
      : `Smallest N reaching ${fmt.pct(sl.value)} within ${target.value} seconds: ${agents - 1} agents give ${fmt.pct1(slPrev)}, ${agents} give ${fmt.pct1(slAt)}, so ${agents}`,
    `Chance a contact waits at all with ${agents} agents = ErlangC = ${fmt.pct1(pWait)}`,
    `Occupancy = ${fmt.n2(load)} / ${agents} = ${fmt.pct1(occupancy)}`,
    `People to schedule = ${agents} / (1 - ${shrinkage.value}) = ${fmt.n2(scheduledFte)}, rounded up = ${people}`,
  ];
  const answer = `${agents} agents on the queue, ${people} people scheduled.`;
  const caveat = 'Erlang C assumes nobody hangs up while waiting and arrivals are steady across the hour. Staff the busiest hour, not the daily average.';
  const text = [
    `Answer: ${answer}`,
    '',
    'Inputs',
    inputsBlock(inputs),
    '',
    'Arithmetic',
    steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    caveat,
    `Computed by the ${ENGINE_NOTE} (staffFor, serviceLevel, erlangC).${assumedNote(inputs)}`,
  ].join('\n');

  return {
    text,
    structured: {
      agents, service_level_at_agents: slAt, service_level_one_fewer: slPrev,
      offered_load_erlangs: load, probability_of_waiting: pWait, occupancy,
      people_to_schedule: people,
      answer, notes: [caveat, ...assumedLines(inputs)], inputs, steps, engine: ENGINE_NOTE,
    },
  };
}
