/**
 * The hiring plan view. It draws what hiring_plan returned and, when the reader moves a
 * control, asks the server to run hiring_plan again. All arithmetic stays on the server.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import pkg from '../../package.json';
import { changes, contextNote, controlsFor, geometry, show, summarize, type Control, type PlanResult } from './model';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';

const app = new App({ name: 'Staffing Math hiring plan', version: pkg.version }, {}, { autoResize: true });

let originalArgs: Record<string, unknown> = {};
let originalControls: Control[] | null = null;
let current: Record<string, number> = {};
let result: PlanResult | null = null;
let focusIndex = -1;
let timer: ReturnType<typeof setTimeout> | undefined;
let runId = 0;
let focusRect: SVGRectElement | null = null;
let columns: { x: number; w: number }[] = [];

/* ------------------------------------------------------------------ drawing */

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, text?: string) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function drawChart(r: PlanResult) {
  const svg = $('chart') as unknown as SVGSVGElement;
  const width = Math.max(320, Math.min(760, Math.round($('chart-wrap').clientWidth || 640)));
  const g = geometry(r.months, width);
  const s = summarize(r);
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);

  svg.append(el('title', { id: 'chart-title' }, 'FTE needed and FTE on hand by month, with requisitions to open'));
  svg.append(el('desc', { id: 'chart-desc' }, s.chart));

  const defs = el('defs', {});
  const pat = el('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(el('rect', { width: 6, height: 6, class: 'gap-bg' }), el('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'gap-line' }));
  defs.append(pat);
  svg.append(defs);

  for (const t of g.yTicks) {
    svg.append(el('line', { x1: g.plot.left, x2: g.plot.right, y1: t.y, y2: t.y, class: 'grid' }));
    svg.append(el('text', { x: g.plot.left - 8, y: t.y + 4, class: 'tick', 'text-anchor': 'end' }, t.label));
  }
  svg.append(el('text', { x: g.plot.left - 8, y: g.plot.top - 14, class: 'axis-name', 'text-anchor': 'start' }, 'FTE'));

  // One highlight, moved in place by pick(), so choosing a month never rebuilds the chart.
  focusRect = el('rect', { x: 0, y: g.plot.top, width: 0, height: g.bars.bottom - g.plot.top, class: 'focus-col' });
  columns = g.columns;
  svg.append(focusRect);
  placeFocus();

  svg.append(el('path', { d: g.onHandPath, class: 'onhand-line' }));
  for (const sp of g.spares) svg.append(el('rect', { x: sp.x, y: sp.y, width: sp.w, height: Math.max(1, sp.h), class: 'spare' }));
  for (const gap of g.gaps) svg.append(el('rect', { x: gap.x, y: gap.y, width: gap.w, height: Math.max(1, gap.h), class: 'gap' }));
  svg.append(el('path', { d: g.neededPath, class: 'needed-line' }));

  if (g.gaps.length) {
    const first = g.gaps[0];
    svg.append(el('text', { x: first.x + 2, y: first.y + Math.max(1, first.h) + 14, class: 'gap-label', 'text-anchor': 'start' }, `${show.one(first.short)} short`));
  }

  if (g.spares.length) {
    const top = g.spares.reduce((a, b) => (b.spare > a.spare ? b : a));
    svg.append(el('text', { x: top.x + top.w / 2, y: top.y - 6, class: 'spare-label', 'text-anchor': 'middle' }, `${show.one(top.spare)} spare`));
  }

  svg.append(el('text', { x: g.endLabels.x, y: g.endLabels.needed.y + 4, class: 'end needed' }, g.endLabels.needed.text));
  svg.append(el('text', { x: g.endLabels.x, y: g.endLabels.onHand.y + 4, class: 'end onhand' }, g.endLabels.onHand.text));

  for (const l of g.xLabels) svg.append(el('text', { x: l.x, y: g.plot.bottom + 18, class: 'tick', 'text-anchor': 'middle' }, l.label));

  svg.append(el('text', { x: g.barCaption.x - 8, y: g.barCaption.y, class: 'axis-name', 'text-anchor': 'start' }, 'REQUISITIONS TO OPEN'));
  svg.append(el('line', { x1: g.plot.left, x2: g.plot.right, y1: g.bars.bottom, y2: g.bars.bottom, class: 'grid' }));
  for (const b of g.reqBars) {
    if (b.value <= 0) continue;
    svg.append(el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 2, class: 'req' }));
    svg.append(el('text', { x: b.x + b.w / 2, y: b.y - 4, class: 'req-label', 'text-anchor': 'middle' }, String(b.value)));
  }

  // Hover and touch pick a month; the arrow keys do the same from the keyboard.
  g.columns.forEach((c, i) => {
    const hit = el('rect', { x: c.x, y: g.plot.top, width: c.w, height: g.bars.bottom - g.plot.top, class: 'hit' });
    hit.addEventListener('mouseenter', () => pick(i));
    hit.addEventListener('click', () => pick(i));
    svg.append(hit);
  });
}

function describeMonth(r: PlanResult, i: number): string {
  const m = r.months[i];
  const gap = m.short_or_spare < -1e-9 ? `${show.one(-m.short_or_spare)} short` : `${show.one(m.short_or_spare)} spare`;
  return `${m.label}: ${show.int(m.weekly_volume)} cases a week. Needs ${show.fte(m.fte_needed)} FTE, has ${show.fte(m.fte_on_hand)} (${gap}). ` +
    `Open ${m.reqs_to_open} requisition${m.reqs_to_open === 1 ? '' : 's'}; ${show.int(m.hires_counting)} hire${m.hires_counting === 1 ? '' : 's'} start counting.`;
}

function placeFocus() {
  const c = columns[focusIndex];
  if (!focusRect) return;
  focusRect.setAttribute('x', String(c ? c.x : 0));
  focusRect.setAttribute('width', String(c ? c.w : 0));
}

function pick(i: number) {
  if (!result) return;
  const next = Math.max(0, Math.min(result.months.length - 1, i));
  if (next === focusIndex) return;
  focusIndex = next;
  $('tip').textContent = describeMonth(result, focusIndex);
  placeFocus();
}

function drawTable(r: PlanResult) {
  const t = $('table') as HTMLTableElement;
  const head = ['Month', 'Weekly volume', 'FTE needed', 'Reqs to open', 'Hires counting', 'Expected leavers', 'FTE on hand', 'Spare or short'];
  t.replaceChildren();
  const thead = t.createTHead().insertRow();
  for (const h of head) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = h; thead.append(th); }
  const body = t.createTBody();
  for (const m of r.months) {
    const row = body.insertRow();
    const th = document.createElement('th'); th.scope = 'row'; th.textContent = m.label; row.append(th);
    const cells = [show.int(m.weekly_volume), m.fte_needed.toFixed(2), String(m.reqs_to_open), show.int(m.hires_counting),
      m.expected_leavers.toFixed(2), m.fte_on_hand.toFixed(2), `${m.short_or_spare >= 0 ? '+' : '-'}${Math.abs(m.short_or_spare).toFixed(2)}`];
    for (const c of cells) row.insertCell().textContent = c;
  }
}

function drawControls() {
  const list = $('control-list');
  if (!originalControls || list.childElementCount) return;
  for (const c of originalControls) {
    const id = `c-${c.key}`;
    const row = document.createElement('div');
    row.className = 'control';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = c.label;
    const input = document.createElement('input');
    input.id = id;
    input.type = c.kind;
    input.min = String(c.min); input.max = String(c.max); input.step = String(c.step);
    input.value = String(c.value);
    const out = document.createElement('output');
    if (c.kind === 'number') out.hidden = true;
    out.htmlFor.add(id);
    out.id = `${id}-out`;
    out.textContent = c.format(c.value);
    input.setAttribute('aria-valuetext', c.format(c.value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      current[c.key] = v;
      out.textContent = c.format(v);
      input.setAttribute('aria-valuetext', c.format(v));
      schedule();
    });
    row.append(label, input, out);
    list.append(row);
  }
}

function render(r: PlanResult) {
  result = r;
  const s = summarize(r);
  $('headline').textContent = s.headline;
  $('sub').textContent = s.sub;
  drawChart(r);
  drawTable(r);
  if (focusIndex >= 0) $('tip').textContent = describeMonth(r, focusIndex);
  const changed = originalControls ? changes(originalControls, current) : [];
  $('changed').textContent = changed.length ? `Changed: ${changed.join('; ')}.` : '';
  $('reset').hidden = changed.length === 0;
}

/* ------------------------------------------------------------------ rerunning */

function argsNow(): Record<string, unknown> {
  return { ...originalArgs, ...current };
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void rerun(), 300);
}

async function rerun() {
  const id = ++runId;
  const args = argsNow();
  document.body.classList.add('busy');
  $('error').hidden = true;
  try {
    const res = await app.callServerTool({ name: 'hiring_plan', arguments: args });
    if (id !== runId) return; // a newer change is already on its way
    if (res.isError || !res.structuredContent) {
      const text = (res.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === 'text')?.text;
      showError(text ?? 'The server could not run the plan with those numbers.');
      return;
    }
    const r = res.structuredContent as unknown as PlanResult;
    render(r);
    const changed = originalControls ? changes(originalControls, current) : [];
    void app.updateModelContext({ content: [{ type: 'text', text: contextNote(r, changed, args) }] }).catch(() => {});
  } catch (e) {
    if (id === runId) showError(`Could not rerun the plan: ${(e as Error).message}`);
  } finally {
    if (id === runId) document.body.classList.remove('busy');
  }
}

function showError(text: string) {
  const e = $('error');
  e.textContent = text;
  e.hidden = false;
}

function reset() {
  if (!originalControls) return;
  current = {};
  for (const c of originalControls) {
    const input = $(`c-${c.key}`) as HTMLInputElement;
    input.value = String(c.value);
    $(`c-${c.key}-out`).textContent = c.format(c.value);
    input.setAttribute('aria-valuetext', c.format(c.value));
  }
  schedule();
}

/* ------------------------------------------------------------------ host */

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

app.addEventListener('toolinput', (p) => { originalArgs = { ...(p.arguments ?? {}) }; });
app.addEventListener('toolresult', (p) => {
  const r = p.structuredContent as unknown as PlanResult | undefined;
  if (!r || !Array.isArray(r.months)) {
    const text = (p.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === 'text')?.text;
    showError(text ?? 'No plan to show.');
    return;
  }
  if (!originalControls) {
    originalControls = controlsFor(r);
    drawControls();
  }
  render(r);
});
app.addEventListener('hostcontextchanged', (ctx) => applyContext(ctx));

$('reset').addEventListener('click', reset);
const chart = $('chart');
chart.addEventListener('keydown', (e) => {
  if (!result) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    pick((focusIndex < 0 ? 0 : focusIndex) + (e.key === 'ArrowRight' ? 1 : -1) * (focusIndex < 0 ? 0 : 1));
  } else if (e.key === 'Home') { e.preventDefault(); pick(0); }
  else if (e.key === 'End') { e.preventDefault(); pick(result.months.length - 1); }
});
chart.addEventListener('focus', () => { if (result && focusIndex < 0) pick(0); });
let lastWidth = 0;
new ResizeObserver(() => {
  const w = $('chart-wrap').clientWidth;
  if (result && Math.abs(w - lastWidth) > 8) { lastWidth = w; drawChart(result); }
}).observe($('chart-wrap'));

void app.connect().then(() => {
  applyContext(app.getHostContext());
  if (!app.getHostCapabilities()?.serverTools) {
    $('controls').hidden = true;
  }
});
