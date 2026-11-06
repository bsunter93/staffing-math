/**
 * Usage counts for the hosted server, and nothing else. Each request adds one to a counter
 * keyed by day, client app and what was asked for (initialize, list, a tool name, the view).
 * No inputs, no IP addresses, no full user-agent strings: the client is the first product
 * token of the User-Agent ("openai-mcp/1.0.0" counts as "openai-mcp").
 *
 * Counting is on only when an Upstash Redis REST URL and token are in the environment, which
 * Vercel's Upstash integration sets. Locally, over stdio, in tests and in anyone's own copy
 * nothing is counted. A failed or slow count never touches the answer.
 */

export interface UsageStore { url: string; token: string }

const TOOLS = new Set(['required_fte', 'hiring_plan', 'erlang_staffing']);
const PREFIX = 'sm';
export const STATS_DAYS = 30;

export function usageStore(env: Record<string, string | undefined> = process.env): UsageStore | null {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

/** A short, safe label: lowercase letters, digits, dot, dash and underscore, at most 40 characters. */
export function label(raw: string | null | undefined): string {
  const s = (raw ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return s || 'unknown';
}

/** The client app, from the first product token of the User-Agent header. */
export function clientFrom(userAgent: string | null): string {
  return label((userAgent ?? '').trim().split(/[\s/]/)[0]);
}

interface RpcMessage { method?: unknown; params?: { name?: unknown; clientInfo?: { name?: unknown } } }

/** What a JSON-RPC body asked for, as counter names. Tool arguments are never read. */
export function eventsFrom(body: unknown): { events: string[]; clientInfo: string[] } {
  const msgs = (Array.isArray(body) ? body : [body]) as RpcMessage[];
  const events: string[] = [];
  const clientInfo: string[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.method === 'initialize') {
      events.push('initialize');
      const n = m.params?.clientInfo?.name;
      if (typeof n === 'string') clientInfo.push(label(n));
    } else if (m.method === 'tools/list') {
      events.push('tools_list');
    } else if (m.method === 'tools/call') {
      const n = m.params?.name;
      events.push(typeof n === 'string' && TOOLS.has(n) ? `tool:${n}` : 'tool:other');
    } else if (m.method === 'resources/read') {
      events.push('view');
    }
  }
  return { events, clientInfo };
}

export function day(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function pipeline(store: UsageStore, commands: (string | number)[][]): Promise<unknown[]> {
  const res = await fetch(`${store.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${store.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`usage store answered ${res.status}`);
  return (await res.json()) as unknown[];
}

/** Count one request. Resolves either way; never throws. */
export async function count(request: Request, store: UsageStore | null = usageStore(), now = new Date()): Promise<void> {
  if (!store) return;
  try {
    const { events, clientInfo } = eventsFrom(await request.json());
    if (!events.length) return;
    const client = clientFrom(request.headers.get('user-agent'));
    const d = day(now);
    const commands: (string | number)[][] = [];
    for (const e of events) {
      commands.push(['HINCRBY', `${PREFIX}:day:${d}`, `${client}|${e}`, 1]);
      commands.push(['HINCRBY', `${PREFIX}:total`, `${client}|${e}`, 1]);
    }
    for (const n of clientInfo) commands.push(['HINCRBY', `${PREFIX}:clientinfo`, n, 1]);
    await pipeline(store, commands);
  } catch {
    // Counting is a nice-to-have. The answer goes out regardless.
  }
}

type Counts = Record<string, number>;

function toCounts(reply: unknown): Counts {
  const flat = (reply as { result?: unknown })?.result;
  const out: Counts = {};
  if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = Number(flat[i + 1]);
  return out;
}

/** The counts, for GET /stats: totals, the last 30 days, and the client names apps sent on initialize. */
export async function stats(store: UsageStore, now = new Date()): Promise<{ total: Counts; clientinfo: Counts; days: Record<string, Counts> }> {
  const dates: string[] = [];
  for (let i = 0; i < STATS_DAYS; i++) dates.push(day(new Date(now.getTime() - i * 86_400_000)));
  const replies = await pipeline(store, [
    ['HGETALL', `${PREFIX}:total`],
    ['HGETALL', `${PREFIX}:clientinfo`],
    ...dates.map((d) => ['HGETALL', `${PREFIX}:day:${d}`]),
  ]);
  const days: Record<string, Counts> = {};
  dates.forEach((d, i) => {
    const c = toCounts(replies[i + 2]);
    if (Object.keys(c).length) days[d] = c;
  });
  return { total: toCounts(replies[0]), clientinfo: toCounts(replies[1]), days };
}
