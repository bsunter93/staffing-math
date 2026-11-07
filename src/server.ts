/**
 * The MCP surface: three read-only tools with their schemas and descriptions.
 * All arithmetic lives in ./tools.ts and the vendored engine.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pkg from '../package.json';
import { DEFAULTS, erlangStaffing, hiringPlan, InputError, requiredFte, type ToolAnswer } from './tools';
import { PLAN_VIEW_HTML } from './view/plan-view.generated';

/** The hiring plan view. Hosts that support MCP Apps draw it under the tool result. */
export const PLAN_VIEW_URI = 'ui://staffing-math/hiring-plan.html';

const fraction = (what: string, max: number) =>
  z.number().min(0).max(max, `${what} is a fraction: 0.30 means 30%.`);

const workload = {
  minutes_per_case: z.number().positive().max(10_000).describe('Average handling time per case, in minutes.'),
  shrinkage: fraction('shrinkage', 0.95).optional()
    .describe(`Share of paid time not available for the work: PTO, sick time, training, meetings. 0.30 means 30%. Default ${DEFAULTS.shrinkage}.`),
  target_occupancy: z.number().min(0.05).max(1, 'target_occupancy is a fraction: 0.85 means 85%.').optional()
    .describe(`Share of available time you plan to keep people busy with the work. Default ${DEFAULTS.target_occupancy}.`),
  hours_per_fte_week: z.number().positive().max(168).optional()
    .describe(`Paid hours per full-time person per week. Default ${DEFAULTS.hours_per_fte_week}.`),
};

const inputLine = z.object({
  name: z.string(),
  value: z.union([z.number(), z.string(), z.array(z.number())]),
  shown: z.string(),
  source: z.enum(['given', 'assumed']),
});
const common = {
  answer: z.string(), notes: z.array(z.string()),
  inputs: z.array(inputLine), steps: z.array(z.string()), engine: z.string(),
};

/*
 * Numbers leave the server rounded: 2 decimals at 1 and above, 4 below (shares and
 * probabilities). The engine's full precision stays inside; a model reading 33.61344537815127
 * either repeats false precision or rounds it some other way.
 */
export function rounded<T>(v: T): T {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Number.isInteger(v)) return v;
    const f = Math.abs(v) >= 1 ? 100 : 10000;
    return (Math.round(v * f) / f) as T;
  }
  if (Array.isArray(v)) return v.map(rounded) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rounded(x)])) as T;
  return v;
}

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const INSTRUCTIONS = [
  'Staffing Math answers staffing questions with exact arithmetic from the Operating Model Simulator engine.',
  'Its tools apply when a user asks how many people, FTE or agents a workload or queue needs, or when and how many to hire.',
  'They account for occupancy, time to hire, ramp and attrition month by month, which quick estimates tend to leave out. Quote their numbers as returned.',
  'Every result lists its inputs as given or assumed. Tell the user which inputs were assumed and offer to rerun with their own numbers.',
  'Show the arithmetic steps when the user asks how a number was reached.',
].join(' ');

function reply<S>(fn: () => ToolAnswer<S>): CallToolResult {
  try {
    const a = fn();
    return { content: [{ type: 'text', text: a.text }], structuredContent: rounded(a.structured) as unknown as Record<string, unknown> };
  } catch (e) {
    if (e instanceof InputError) return { isError: true, content: [{ type: 'text', text: e.message }] };
    throw e;
  }
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'staffing-math', title: 'Staffing Math', version: pkg.version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool('required_fte', {
    title: 'FTE needed for a workload',
    description:
      'For questions like "how many people do I need" or "how many FTE does this workload take": cases, tickets, claims, orders or any work measured as volume times handling time. ' +
      'Applies shrinkage and target occupancy together; leaving out occupancy understates the people needed by about 15% at the 85% default. ' +
      'Give weekly volume and minutes per case; shrinkage, target occupancy and hours per week fall back to stated defaults. ' +
      'Returns FTE, people to staff (rounded up), every input marked given or assumed, and the arithmetic with numbers filled in. ' +
      'For volume that changes over time or any question about when to hire, see hiring_plan; for live queues with an answer-time target, see erlang_staffing.',
    inputSchema: {
      weekly_volume: z.number().positive().max(1e9).describe('Cases, tickets or items arriving per week.'),
      ...workload,
    },
    outputSchema: {
      fte: z.number(), people: z.number(), weekly_work_hours: z.number(),
      productive_hours_per_fte_week: z.number(), planned_hours_per_fte_week: z.number(),
      fte_per_extra_minute: z.number(),
      ...common,
    },
    annotations: { title: 'FTE needed for a workload', ...ANNOTATIONS },
  }, async (args) => reply(() => requiredFte(args)));

  registerAppResource(server, 'Hiring plan view', PLAN_VIEW_URI, {
    description: 'Chart of FTE needed against FTE on hand by month, with requisitions to open and controls that rerun the plan.',
  }, async () => ({
    contents: [{
      uri: PLAN_VIEW_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: PLAN_VIEW_HTML,
      _meta: { ui: { prefersBorder: true } },
    }],
  }));

  registerAppTool(server, 'hiring_plan', {
    title: 'Monthly hiring plan',
    description:
      'For hiring plans, headcount plans, and questions about when to open requisitions or how many people to hire as volume grows, shrinks or changes by season. ' +
      'Plans month by month how many requisitions to open so FTE on hand keeps up with FTE needed. ' +
      'A requisition adds capacity only after time to hire and ramp, and attrition removes people every month, so the plan opens reqs ahead of need and flags the months that run short before any new hire can count. ' +
      'Give weekly_volume with monthly_growth (0.05 means 5% a month, compounding), or weekly_volume_by_month. ' +
      'Unknown inputs fall back to stated defaults: current headcount defaults to what month 1 needs, attrition to 0, time to hire to 2 months, ramp to 0. ' +
      'When attrition is assumed, the result also gives the plan at 15% and 30%. Give hires_in_flight for people already hired or in the pipeline. ' +
      'Returns the plan table, totals, the arithmetic, and which inputs were assumed. A hire counts as zero capacity until fully ramped. ' +
      'Hosts that support MCP Apps also draw the plan as a chart with controls that rerun it.',
    inputSchema: {
      weekly_volume: z.number().positive().max(1e9).optional().describe('Weekly volume in month 1. Use with monthly_growth.'),
      monthly_growth: z.number().min(-0.5).max(1, 'monthly_growth is a fraction: 0.05 means 5% a month.').optional()
        .describe('Month-over-month change in weekly volume. 0.05 means 5% a month. Default 0.'),
      weekly_volume_by_month: z.array(z.number().positive().max(1e9)).min(1).max(36).optional()
        .describe('Average weekly volume in each month of the plan, instead of weekly_volume and monthly_growth.'),
      months: z.number().int().min(1).max(36).optional().describe(`Plan length in months when using monthly_growth. Default ${DEFAULTS.months}.`),
      ...workload,
      current_headcount: z.number().min(0).max(1e6).optional()
        .describe('FTE on the team today. Default: what month 1 needs, rounded up.'),
      annual_attrition: fraction('annual_attrition', 0.99).optional()
        .describe('Share of the team that leaves in a year. 0.25 means 25%. Default 0.'),
      time_to_hire_months: z.number().int().min(0).max(24).optional()
        .describe(`Months from opening a requisition to the start date. Default ${DEFAULTS.time_to_hire_months}.`),
      ramp_months: z.number().int().min(0).max(24).optional()
        .describe(`Months from start date to full productivity. Default ${DEFAULTS.ramp_months}.`),
      start_month: z.string().optional().describe('First month of the plan as YYYY-MM, used only to label months.'),
      hires_in_flight: z.array(z.object({
        month: z.number().int().min(1).max(36).describe('Plan month the people start counting as capacity. Use 1 for anyone counting from the start.'),
        count: z.number().int().min(1).max(100_000).describe('How many people.'),
      })).max(36).optional()
        .describe('People already hired or in the pipeline, and the month they start counting. These are the only way to cover months before a new requisition can land.'),
    },
    outputSchema: {
      total_reqs: z.number(), first_month_hires_can_count: z.number(),
      fte_needed_first_month: z.number(), fte_needed_last_month: z.number(),
      expected_leavers: z.number(), months_short_before_hires_land: z.array(z.number()), lookahead_months: z.number(),
      months_with_spare: z.array(z.number()),
      most_spare: z.object({ month: z.number(), fte: z.number() }).nullable(),
      attrition_range: z.array(z.object({ annual_attrition: z.number(), total_reqs: z.number() })),
      months: z.array(z.object({
        month: z.number(), label: z.string(), weekly_volume: z.number(), fte_needed: z.number(),
        reqs_to_open: z.number(), hires_counting: z.number(), expected_leavers: z.number(),
        fte_on_hand: z.number(), short_or_spare: z.number(), in_flight: z.number(),
      })),
      ...common,
    },
    annotations: { title: 'Monthly hiring plan', ...ANNOTATIONS },
    _meta: { ui: { resourceUri: PLAN_VIEW_URI } },
  }, async (args) => reply(() => hiringPlan(args)));

  server.registerTool('erlang_staffing', {
    title: 'Queue staffing (Erlang C)',
    description:
      'For call center, contact center, phone or chat staffing questions with a service level target, such as 80% answered within 20 seconds. ' +
      'Works out agents needed on a live queue to answer a target share of contacts within a target time, using Erlang C. ' +
      'Give contacts per hour for the interval being staffed (usually the busiest hour) and handle time in seconds. ' +
      'Returns agents needed, the service level at that number and at one fewer, chance of waiting, occupancy, and people to schedule after shrinkage. ' +
      'Use required_fte for case or ticket work with no answer-time target.',
    inputSchema: {
      contacts_per_hour: z.number().positive().max(100_000).describe('Contacts arriving per hour in the interval being staffed.'),
      handle_time_seconds: z.number().positive().max(36_000).describe('Average handle time in seconds: talk plus after-contact work.'),
      answer_within_seconds: z.number().min(0).max(3_600).optional()
        .describe(`Target answer time in seconds. Default ${DEFAULTS.answer_within_seconds}.`),
      service_level: z.number().min(0.01).max(0.999, 'service_level is a fraction below 1: 0.80 means 80%.').optional()
        .describe(`Share of contacts to answer within the target time. Default ${DEFAULTS.service_level}.`),
      shrinkage: fraction('shrinkage', 0.95).optional()
        .describe(`Share of paid time agents are off the queue. Converts agents to people scheduled. Default ${DEFAULTS.shrinkage}.`),
    },
    outputSchema: {
      agents: z.number(), service_level_at_agents: z.number(), service_level_one_fewer: z.number().nullable(),
      offered_load_erlangs: z.number(), probability_of_waiting: z.number(), occupancy: z.number(),
      people_to_schedule: z.number(),
      ...common,
    },
    annotations: { title: 'Queue staffing (Erlang C)', ...ANNOTATIONS },
  }, async (args) => reply(() => erlangStaffing(args)));

  return server;
}
