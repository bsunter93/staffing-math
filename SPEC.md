# Staffing Math: spec

## What it is

An MCP server with three tools that answer the staffing questions ops leaders get every planning season: how many people does this workload need, how many do I hire and when, and how many agents does a queue need to hit its answer-time target. Claude or ChatGPT does the talking. The tools do every calculation and return the arithmetic with the answer, so a reader can check it with a calculator.

## Who it's for

The person building next year's headcount plan for a support, operations or back-office team. The answer goes into a planning meeting as one number with its working shown.

## Where the math comes from

The engine is copied unchanged from the [Operating Model Simulator](https://github.com/bsunter93/operating-model-simulator) (commit `758c9d7`) into `vendor/operating-model-simulator/`, with its own upstream tests. Nothing in that folder is edited. `npm run check:vendor` diffs it against upstream.

- `required_fte` and `hiring_plan` build a one-team model and call the engine's `run()`. Every FTE, attrition and landing figure is the engine's own monthly output.
- `erlang_staffing` calls the engine's `staffFor`, `serviceLevel` and `erlangC` directly.

The only new arithmetic is the input conversion (weekly to monthly) and the hiring solver that decides how many requisitions to open each month. Both are tested against hand calculations.

## Tools

### `required_fte`

How many people a steady workload needs.

| Input | Default | Notes |
|---|---|---|
| `weekly_volume` | required | Cases, tickets or items per week |
| `minutes_per_case` | required | Average handling time |
| `shrinkage` | 0.30 | Share of paid time not available for the work (PTO, training, meetings) |
| `target_occupancy` | 0.85 | Share of available time you plan to keep people busy |
| `hours_per_fte_week` | 40 | Paid hours per full-time person |

Formula: FTE = weekly hours of work / (hours per FTE x (1 - shrinkage) x target occupancy). People to staff is FTE rounded up.

### `hiring_plan`

How many requisitions to open each month so capacity keeps up with a forecast.

Inputs are the same as `required_fte`, plus:

| Input | Default | Notes |
|---|---|---|
| `weekly_volume` or `weekly_volume_by_month` | one required | Month 1's weekly volume, or each month's |
| `monthly_growth` | 0 | With `weekly_volume`: compounds month over month (0.05 = 5%) |
| `months` | 12 | Plan length when using growth (1 to 36) |
| `current_headcount` | people needed in month 1 | FTE on the team today |
| `annual_attrition` | 0 | Share of the team that leaves in a year, applied monthly as the engine does |
| `time_to_hire_months` | 2 | From opening a requisition to the start date |
| `ramp_months` | 0 | From start date to full productivity |
| `start_month` | none | `YYYY-MM`, used only to label months |
| `hires_in_flight` | none | People already hired or in the pipeline: `[{ month, count }]`, counting from that month |

Rules:
- A hire counts as zero capacity until fully ramped. Real ramps give some output earlier, so the plan can open requisitions early. It never opens them late.
- Hires are whole people. Attrition is an expected value, so headcount can be fractional.
- The solver walks the months in order. Where FTE on hand falls below FTE needed, it opens enough requisitions (rounded up) in the month that lands them in time, then re-runs the engine.
- Months before the first possible landing can't be fixed by new requisitions. They're reported as a gap with the month the first hire can count. Hires in flight can cover them.
- When attrition is assumed, the plan is also solved at 15% and 30% and both totals reported (`attrition_range`).
- Months with at least one whole spare FTE are reported (`months_with_spare`, `most_spare`) and shaded in the view.
- When current headcount is assumed, the answer says it assumed a fully staffed team.

### `erlang_staffing`

Agents needed on a live queue (calls, chats) to answer a share of contacts within a target time, using Erlang C.

| Input | Default | Notes |
|---|---|---|
| `contacts_per_hour` | required | Arrivals in the interval you're staffing, usually the busiest hour |
| `handle_time_seconds` | required | Talk plus wrap time |
| `answer_within_seconds` | 20 | Target answer time |
| `service_level` | 0.80 | Share of contacts answered within that time |
| `shrinkage` | 0.30 | Converts agents on the queue to people scheduled |

Returns the agents needed, the service level at that number and at one fewer, occupancy, and people to schedule.

## The plan view (added in 0.2.0)

`hiring_plan` links an MCP Apps view (`_meta.ui.resourceUri`). It shows the answer in one line, a chart of FTE needed against FTE on hand with the short months hatched, requisitions per month as bars, and six controls (growth, attrition, time to hire, ramp, shrinkage, headcount). Moving a control calls `hiring_plan` through the host and redraws; the view sends the host a model-context update with the change and the new result. The view does no arithmetic. Accessibility: live-region headline, a text description of the chart, arrow-key month readout, native labeled inputs, a full data table, host theme.

## Every answer includes

1. The answer in one line.
2. Every input with its value, marked `given` or `assumed`.
3. The arithmetic, step by step, with the numbers substituted.
4. A JSON copy of all of the above in `structuredContent` for clients that render it.

The tool descriptions tell the model to name assumed inputs back to the user.

## Runs in

- Claude Desktop and Claude Code over stdio (`node dist/staffing-math.mjs`; the bundle has no runtime dependencies).
- Claude Desktop as a one-click extension (`manifest.json`, packed with `npm run pack`).
- Claude Code as a plugin (`.claude-plugin/` in this repo).
- Gemini CLI as an extension (`gemini-extension.json`).
- ChatGPT developer mode, Gemini custom connectors and Claude custom connectors over Streamable HTTP (`--http`, endpoint `/mcp`). All need a public HTTPS URL.

- Any fetch-handler host (Vercel, Cloudflare Workers, Deno, Bun) through `api/index.mjs` / `src/fetch.ts`.

No network calls, no accounts, no stored data. All three tools are read-only.

## Out of scope for v1

Cost and budget, multiple teams, routing between teams, seasonality inside a month, Erlang A (abandonment), and views for `required_fte` and `erlang_staffing`.

## Done when

- Tests pass for all three tools, including the upstream engine tests running against the vendored copy.
- The worked example in the README matches a hand calculation.
- A real Claude client answers the example prompt using the tools, with a saved transcript.
