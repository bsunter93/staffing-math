/**
 * Everything the plan view computes, kept free of the DOM so it can be tested in Node.
 * It draws numbers the server already calculated; it never calculates a plan itself.
 */
import type { HiringPlanResult, InputLine, PlanMonth } from '../tools';

export type PlanResult = HiringPlanResult & { inputs: InputLine[]; steps: string[]; engine: string };

const nf = (d: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const show = {
  int: (x: number) => nf(0).format(x),
  one: (x: number) => nf(1).format(x),
  /** Whole numbers print whole: 34, not 34.0. */
  fte: (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? nf(0).format(Math.round(x)) : nf(1).format(x)),
  pct: (x: number) => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(x * 100)}%`,
  months: (x: number) => `${x} month${x === 1 ? '' : 's'}`,
};

/* ------------------------------------------------------------------ words */

const listOf = (xs: number[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function summarize(r: PlanResult) {
  const n = r.months.length;
  const first = r.months[0], last = r.months[n - 1];
  const headline = r.total_reqs === 0
    ? `No requisitions needed over ${n} months`
    : `Open ${r.total_reqs} requisition${r.total_reqs === 1 ? '' : 's'} over ${n} months`;
  const parts = [`${show.fte(first.fte_on_hand)} FTE on hand in month 1, ${show.fte(last.fte_on_hand)} in month ${n}.`];
  const short = r.months_short_before_hires_land;
  if (short.length) {
    parts.push(`${short.length === 1 ? `Month ${short[0]} is` : `Months ${listOf(short)} are`} short before the first hire can count.`);
  }
  if (r.most_spare) {
    const m = r.months[r.most_spare.month - 1];
    parts.push(`${m.label} has ${show.one(r.most_spare.fte)} FTE more than it needs.`);
  }
  const chart = `FTE needed goes from ${show.fte(first.fte_needed)} to ${show.fte(last.fte_needed)} over ${n} months. ` +
    `FTE on hand goes from ${show.fte(first.fte_on_hand)} to ${show.fte(last.fte_on_hand)}.` +
    (short.length ? ` Short in ${short.length === 1 ? 'month' : 'months'} ${listOf(short)}.` : '') +
    (r.months_with_spare?.length ? ` At least one FTE spare in ${r.months_with_spare.length === 1 ? 'month' : 'months'} ${listOf(r.months_with_spare)}.` : '');
  return { headline, sub: parts.join(' '), chart };
}

/* ------------------------------------------------------------------ chart */

export interface Geometry {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  bars: { top: number; bottom: number };
  yTicks: { y: number; label: string }[];
  xLabels: { x: number; label: string }[];
  neededPath: string;
  onHandPath: string;
  barCaption: { x: number; y: number };
  gaps: { x: number; y: number; w: number; h: number; month: number; short: number }[];
  /** Months with at least one whole FTE more than needed, drawn between the two lines. */
  spares: { x: number; y: number; w: number; h: number; month: number; spare: number }[];
  reqBars: { x: number; y: number; w: number; h: number; value: number }[];
  columns: { x: number; w: number; month: PlanMonth }[];
  endLabels: { needed: { y: number; text: string }; onHand: { y: number; text: string }; x: number };
}

function niceStep(max: number, count: number): number {
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

/** Short month labels: "Jan" for "Jan 2027", "1" for "Month 1". */
export function shortLabel(label: string): string {
  const m = /^Month (\d+)$/.exec(label);
  return m ? m[1] : label.slice(0, 3);
}

export function geometry(months: PlanMonth[], width = 640): Geometry {
  const height = 318;
  const plot = { left: 40, right: width - 96, top: 26, bottom: 206 };
  const bars = { top: 262, bottom: 304 };
  const n = months.length;
  const step = (plot.right - plot.left) / n;
  const cx = (i: number) => plot.left + step * (i + 0.5);

  /* The axis starts near the data rather than at zero. The question is the gap between two
     lines, and from zero a one-person gap on a team of fifty is a hairline. These are lines
     with no area under them, so a cut axis doesn't exaggerate anything. */
  const values = months.flatMap((m) => [m.fte_needed, m.fte_on_hand]);
  const hi = Math.max(1, ...values), lo = Math.min(...values);
  const tick = niceStep(Math.max(hi - lo, hi * 0.1), 4);
  const yMax = Math.ceil((hi + tick * 0.25) / tick) * tick;
  const yMin = Math.max(0, Math.floor((lo - tick * 0.25) / tick) * tick);
  const y = (v: number) => plot.bottom - ((v - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);
  const yTicks: Geometry['yTicks'] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += tick) yTicks.push({ y: y(v), label: show.int(v) });

  const every = n <= 12 ? 1 : n <= 24 ? 2 : 3;
  const xLabels = months
    .map((m, i) => ({ x: cx(i), label: shortLabel(m.label), i }))
    .filter((l) => l.i % every === 0 || l.i === n - 1)
    .map(({ x, label }) => ({ x, label }));

  const f = (v: number) => v.toFixed(1);
  const neededPath = months.map((m, i) => `${i ? 'L' : 'M'}${f(cx(i))},${f(y(m.fte_needed))}`).join('');
  // Headcount holds for the whole month, so on hand is a step across each month's column.
  let onHandPath = '';
  months.forEach((m, i) => {
    const x0 = plot.left + step * i, x1 = x0 + step, yy = y(m.fte_on_hand);
    onHandPath += `${i ? 'L' : 'M'}${f(x0)},${f(yy)}L${f(x1)},${f(yy)}`;
  });

  const gaps = months.flatMap((m, i) => (m.short_or_spare < -1e-9
    ? [{ x: plot.left + step * i, y: y(m.fte_needed), w: step, h: y(m.fte_on_hand) - y(m.fte_needed), month: m.month, short: -m.short_or_spare }]
    : []));

  const spares = months.flatMap((m, i) => (m.short_or_spare >= 1
    ? [{ x: plot.left + step * i, y: y(m.fte_on_hand), w: step, h: y(m.fte_needed) - y(m.fte_on_hand), month: m.month, spare: m.short_or_spare }]
    : []));

  const maxReq = Math.max(1, ...months.map((m) => m.reqs_to_open));
  const barW = Math.min(28, step * 0.6);
  const reqBars = months.map((m, i) => {
    const h = (m.reqs_to_open / maxReq) * (bars.bottom - bars.top);
    return { x: cx(i) - barW / 2, y: bars.bottom - h, w: barW, h, value: m.reqs_to_open };
  });

  const columns = months.map((m, i) => ({ x: plot.left + step * i, w: step, month: m }));

  const last = months[n - 1];
  let yn = y(last.fte_needed), yo = y(last.fte_on_hand);
  // Keep the two end labels from printing on top of each other.
  if (Math.abs(yn - yo) < 15) {
    const mid = (yn + yo) / 2, up = last.fte_needed >= last.fte_on_hand;
    yn = mid + (up ? -8 : 8); yo = mid + (up ? 8 : -8);
  }
  const endLabels = {
    x: plot.right + 8,
    needed: { y: yn, text: `Needed ${show.fte(last.fte_needed)}` },
    onHand: { y: yo, text: `On hand ${show.fte(last.fte_on_hand)}` },
  };
  const barCaption = { x: plot.left, y: bars.top - 22 };

  return { width, height, plot, bars, yTicks, xLabels, neededPath, onHandPath, barCaption, gaps, spares, reqBars, columns, endLabels };
}

/* ------------------------------------------------------------------ controls */

export interface Control {
  key: string;
  input: string;
  label: string;
  kind: 'range' | 'number';
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
}

const SPECS: Omit<Control, 'value'>[] = [
  { key: 'monthly_growth', input: 'monthly growth', label: 'Monthly growth', kind: 'range', min: -0.05, max: 0.15, step: 0.005, format: show.pct },
  { key: 'annual_attrition', input: 'annual attrition', label: 'Annual attrition', kind: 'range', min: 0, max: 0.6, step: 0.01, format: show.pct },
  { key: 'time_to_hire_months', input: 'time to hire', label: 'Time to hire', kind: 'range', min: 0, max: 6, step: 1, format: show.months },
  { key: 'ramp_months', input: 'ramp to full productivity', label: 'Ramp to full speed', kind: 'range', min: 0, max: 6, step: 1, format: show.months },
  { key: 'shrinkage', input: 'shrinkage', label: 'Shrinkage', kind: 'range', min: 0, max: 0.6, step: 0.01, format: show.pct },
  { key: 'current_headcount', input: 'current headcount', label: 'People today', kind: 'number', min: 0, max: 100000, step: 1, format: show.int },
];

/** The controls this result can offer, set to the values the result was computed with. */
export function controlsFor(r: PlanResult): Control[] {
  return SPECS.flatMap((s) => {
    const line = r.inputs.find((i) => i.name === s.input);
    if (!line || typeof line.value !== 'number') return [];
    const v = line.value;
    return [{ ...s, value: v, min: Math.min(s.min, v), max: Math.max(s.max, v) }];
  });
}

export function changes(original: Control[], current: Record<string, number>): string[] {
  return original
    .filter((c) => current[c.key] !== undefined && Math.abs(current[c.key] - c.value) > 1e-12)
    .map((c) => `${c.label} ${c.format(current[c.key])} (was ${c.format(c.value)})`);
}

/** What the model is told after the reader changes something, so a follow-up question lands on the new plan. */
export function contextNote(r: PlanResult, changed: string[], args: Record<string, unknown>): string {
  const s = summarize(r);
  return [
    'The user adjusted the hiring plan in the Staffing Math view.',
    changed.length ? `Changed: ${changed.join('; ')}.` : 'They reset it to the original inputs.',
    `Result now: ${s.headline}, ${r.months[0].reqs_to_open} in month 1. ${s.sub}`,
    `Arguments for hiring_plan: ${JSON.stringify(args)}`,
  ].join('\n');
}
