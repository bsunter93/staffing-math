# Staffing Math

An MCP server that gives Claude and ChatGPT exact staffing math. It has three tools:

- `required_fte`: how many people a steady workload needs.
- `hiring_plan`: how many requisitions to open each month as volume changes, after attrition, time to hire and ramp.
- `erlang_staffing`: how many agents a phone or chat queue needs to hit an answer-time target (Erlang C).

The model does the talking. The tools do every calculation and return it with the answer: each input marked `given` or `assumed`, and the arithmetic with the numbers filled in. You can check any answer with a calculator.

In Claude and ChatGPT, `hiring_plan` also draws its answer: FTE needed against FTE on hand by month, the short months hatched, and the requisitions to open underneath. Sliders for growth, attrition, time to hire, ramp, shrinkage and headcount rerun the plan on the server as you move them, and the model is told what you changed.

The math is the engine from the [Operating Model Simulator](https://github.com/bsunter93/operating-model-simulator), copied unchanged into `vendor/` along with its own tests.

To use it without installing anything, add `https://staffing-math.vercel.app/mcp` as a connector. Steps and examples: [bensunter.com/staffing-math.html](https://bensunter.com/staffing-math.html).

## Worked example

> I handle 4,000 cases a week at 12 minutes each with 30% shrinkage. How many people do I need, and what's my hiring plan if volume grows 5% a month?

`required_fte` returns:

```text
Answer: 33.61 FTE, so 34 people.

Inputs
- weekly volume: 4,000 cases (given)
- minutes per case: 12 (given)
- shrinkage: 30% (given)
- target occupancy: 85% (assumed)
- hours per FTE per week: 40 (assumed)

Arithmetic
1. Work per week = 4,000 cases x 12 min / 60 = 800.0 hours
2. Productive hours per FTE = 40 x (1 - 0.3) = 28.00 hours
3. Planned hours per FTE at 85% occupancy = 28.00 x 0.85 = 23.80 hours
4. FTE needed = 800.0 / 23.80 = 33.61
5. People to staff = 33.61 rounded up = 34

Each extra minute per case adds 2.80 FTE.
```

`hiring_plan` with the same inputs and 5% monthly growth returns this answer and table, plus the same inputs and arithmetic blocks:

```text
Answer: open 30 requisitions over 12 months, 4 of them in month 1.
FTE needed goes from 33.61 in month 1 to 57.49 in month 12. Expected leavers over the plan: 0.0.
Requisitions opened in months 11 and 12 are for hires who count in months 13 and 14, assuming the 5% monthly growth continues.
Month 2 is short and new hires can't fix that: the earliest a requisition opened now counts is month 3. Covering it takes overtime, contractors or moving people. People already hired or in the pipeline can count earlier: give them as hires_in_flight.
Attrition was assumed to be 0%. At 15% a year this plan needs 38 requisitions; at 30%, 48. Ask for the team's real rate.
Current headcount was assumed to be exactly what month 1 needs (34), as if the team is fully staffed today. If it has fewer people, give current_headcount.
```

| Month | Weekly volume | FTE needed | Reqs to open | Hires counting | Expected leavers | FTE on hand | Spare (+) / short (-) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Month 1 | 4,000 | 33.61 | 4 | 0 | 0.00 | 34.00 | +0.39 |
| Month 2 | 4,200 | 35.29 | 1 | 0 | 0.00 | 34.00 | -1.29 |
| Month 3 | 4,410 | 37.06 | 2 | 4 | 0.00 | 38.00 | +0.94 |
| Month 4 | 4,631 | 38.91 | 2 | 1 | 0.00 | 39.00 | +0.09 |
| Month 5 | 4,862 | 40.86 | 3 | 2 | 0.00 | 41.00 | +0.14 |
| Month 6 | 5,105 | 42.90 | 2 | 2 | 0.00 | 43.00 | +0.10 |
| Month 7 | 5,360 | 45.05 | 2 | 3 | 0.00 | 46.00 | +0.95 |
| Month 8 | 5,628 | 47.30 | 3 | 2 | 0.00 | 48.00 | +0.70 |
| Month 9 | 5,910 | 49.66 | 2 | 2 | 0.00 | 50.00 | +0.34 |
| Month 10 | 6,205 | 52.15 | 3 | 3 | 0.00 | 53.00 | +0.85 |
| Month 11 | 6,516 | 54.75 | 3 | 2 | 0.00 | 55.00 | +0.25 |
| Month 12 | 6,841 | 57.49 | 3 | 3 | 0.00 | 58.00 | +0.51 |

The prompt didn't give target occupancy, hours per week, current headcount, attrition, time to hire or ramp, so the tool used its defaults and listed each one as assumed. Attrition and headcount move the answer most, so the result spells those two out, with the plan at 15% and 30% attrition alongside. Claude is told to say so and offer to rerun with real numbers. With 30 people today, 25% annual attrition and a month of ramp, the same forecast needs 53 requisitions instead of 30, 12 of them in month 1, and months 1 to 3 are short before any hire can count.

Checking it by hand: month 12 volume is 4,000 x 1.05^11 = 6,841 cases a week. That's 6,841 x 12 / 60 = 1,368 hours, and 1,368 / 23.80 = 57.49 FTE.

## Install

The server is one file, `dist/staffing-math.mjs`, and needs Node 18 or later. Clone the repo first:

```bash
git clone https://github.com/bsunter93/staffing-math.git
```

### Claude Desktop

Open Settings, then Developer, then Edit Config, and add the server to `claude_desktop_config.json`. Use the full path to your clone:

```json
{
  "mcpServers": {
    "staffing-math": {
      "command": "node",
      "args": ["/full/path/to/staffing-math/dist/staffing-math.mjs"]
    }
  }
}
```

Restart Claude Desktop. The three tools appear under the tools menu in a new chat.

To install it as a Desktop extension instead, run `npm run pack` and double-click the `staffing-math.mcpb` it writes.

### Claude Code

As a plugin, from inside Claude Code:

```text
/plugin marketplace add bsunter93/staffing-math
/plugin install staffing-math@staffing-math
```

Or as a plain MCP server:

```bash
claude mcp add staffing-math -- node /full/path/to/staffing-math/dist/staffing-math.mjs
```

### Gemini CLI

```bash
gemini extensions install https://github.com/bsunter93/staffing-math
```

`gemini-extension.json` in the repo runs the same bundled server. Gemini CLI shows the tools' text answers; it doesn't draw the plan view.

### ChatGPT, Gemini and Claude custom connectors

These connect to a remote server over Streamable HTTP at a public HTTPS URL. The hosted one is free to use, needs no sign-in and stores nothing:

```text
https://staffing-math.vercel.app/mcp
```

To run your own, start the server in HTTP mode:

```bash
node dist/staffing-math.mjs --http --port 3000
```

It listens on `http://127.0.0.1:3000/mcp`. Put it behind HTTPS (a host, a reverse proxy, or a tunnel such as `cloudflared tunnel --url http://localhost:3000`), then add `https://your-host/mcp` as a connector with no authentication:

- ChatGPT: [Plugins](https://chatgpt.com/plugins), then Add, then Add custom MCP server, with no authentication. ChatGPT draws the plan view. After an update, Refresh tools in the plugin's settings picks up new inputs.
- Gemini: [Connectors](https://gemini.google.com/customize/connectors), then Custom. Gemini shows the text answers.
- Claude: Settings, Connectors, Add custom connector. Use `--host 0.0.0.0` when it runs on a server.

The HTTP mode is stateless. Each request gets a fresh server, so it scales out without sessions.

### Hosting it

`api/index.mjs` is the same server as a single Web-standard `fetch` handler (`src/fetch.ts`), built by `npm run build`. On Vercel:

```bash
npx vercel deploy --prod
```

`vercel.json` sends every path to that one function and tells Vercel there's no framework, nothing to install and nothing to build, so a project Vercel once guessed was something else still deploys. `.vercelignore` uploads only `api/` and `vercel.json`. Dragging a folder with just those two onto the project page in Vercel's dashboard deploys the same thing without the CLI. The endpoint is `https://<project>.vercel.app/mcp`. The same handler runs on Cloudflare Workers, Deno or Bun. On Workers' free plan, a 36-month plan with attrition can pass the 10ms CPU limit per request; the paid plan doesn't have that problem.

## Tools

| Tool | Required | Optional, with defaults |
|---|---|---|
| `required_fte` | `weekly_volume`, `minutes_per_case` | `shrinkage` 0.30, `target_occupancy` 0.85, `hours_per_fte_week` 40 |
| `hiring_plan` | `minutes_per_case`, and `weekly_volume` (with `monthly_growth`) or `weekly_volume_by_month` | the three above, `months` 12, `current_headcount` (what month 1 needs), `annual_attrition` 0, `time_to_hire_months` 2, `ramp_months` 0, `hires_in_flight` (none), `start_month` |
| `erlang_staffing` | `contacts_per_hour`, `handle_time_seconds` | `answer_within_seconds` 20, `service_level` 0.80, `shrinkage` 0.30 |

Fractions are fractions: 0.30 means 30%. A value of 30 for shrinkage is rejected with a message saying so.

Every result has a text block for the model and a `structuredContent` copy with the same numbers, the inputs and the steps. All three tools are read-only, make no network calls and store nothing.

## The plan view

`hiring_plan` carries an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) view, `ui://staffing-math/hiring-plan.html`: one HTML file with its script inlined and no outside requests. Hosts that support MCP Apps draw it under the answer; other hosts ignore it and show the text.

- The headline and the line under it are the answer in words, and screen readers hear them again after every change.
- The chart has a text description. Point at a month, or focus the chart and use the arrow keys, to read that month in a sentence.
- Every control is a labeled native slider or number field, so it works from the keyboard.
- "Show the numbers" opens the full table.
- It follows the host's light or dark theme.

The view never calculates. Moving a control calls `hiring_plan` again with the new arguments and draws what comes back.

## How the hiring plan works

1. FTE needed each month = weekly hours of work / (hours per FTE x (1 - shrinkage) x target occupancy).
2. Attrition is applied monthly at the rate that compounds to the annual figure: 1 - (1 - annual)^(1/12). Leavers are an expected value, so headcount can be fractional.
3. A requisition opened in month m counts as capacity from month m + time to hire + ramp. Until it's fully ramped a hire counts as zero, so the plan errs toward opening requisitions early.
4. Walking forward from the first month a hire can count, wherever FTE on hand is below FTE needed, the solver opens the shortfall in whole people in the month that lands them in time, then reruns the engine.
5. Months before the first possible landing can't be fixed by new requisitions. The tool says which ones and by how much. People already hired or in the pipeline can: `hires_in_flight` takes how many and the month each group starts counting, and the plan opens only what's still missing.
6. Requisitions opened near the end of the plan land after it. With a growth rate the solver carries the forecast past the last month so those requisitions still get planned, and says so. With a month-by-month forecast it plans nothing past the last month you gave.
7. A month with at least one whole FTE more than it needs is spare. The tool names the most overstaffed month, and the view shades every spare month. Hiring can't fix a spare month; it shows where demand dips below the people already there.
8. When attrition isn't given, the plan is rerun at 15% and 30% a year and both totals are reported. Those are reference points for the conversation, not benchmarks.

The tests check that the plan covers every coverable month and that removing any single requisition leaves some month short, so it never hires more than the forecast needs.

## Where the math comes from

`vendor/operating-model-simulator/` is a byte-for-byte copy of the Simulator's engine at commit `758c9d7`: the monthly model (`run()`), Erlang B and C with a stable recursion that doesn't overflow past 170 agents, and the calendar helpers. `required_fte` and `hiring_plan` build a one-team model and call `run()`; `erlang_staffing` calls `staffFor`, `serviceLevel` and `erlangC`. This repo adds the weekly-to-monthly conversion, the hiring solver and the MCP server around them.

```bash
npm install
npm test               # upstream engine tests plus this repo's own
npm run check:vendor   # confirms vendor/ still matches upstream
npm run build          # rebuilds dist/staffing-math.mjs
```

The tests include hand calculations for each tool, a textbook Erlang C written independently to check the engine against, and runs over all three transports: in memory, Streamable HTTP, and the built file over stdio.

## Limits

Erlang C assumes nobody hangs up while waiting and that arrivals are steady across the interval, so staff the busiest hour. There's no cost or budget, no multi-team routing, and no seasonality inside a month. The [Operating Model Simulator](https://bensunter.com/simulator/) covers multiple teams, routing between them and cost.

## License

MIT
