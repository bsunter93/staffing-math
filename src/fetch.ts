/**
 * The server as one Web-standard fetch handler, for hosts that take one: Vercel, Cloudflare
 * Workers, Deno, Bun. Stateless, like the Node HTTP mode: a fresh server per request.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from './server';
import { count, stats, usageStore } from './usage';

/** The longest a count may hold up an answer. The count runs alongside the tool, so this is rarely reached. */
const COUNT_WAIT_MS = 400;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function rpcError(status: number, message: string): Response {
  return withCors(Response.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, { status }));
}

export async function handleFetch(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

  if (path === '/' && request.method === 'GET') {
    return withCors(new Response('Staffing Math MCP server. Connect an MCP client to /mcp.\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }));
  }
  if (path === '/stats' && request.method === 'GET') {
    const store = usageStore();
    if (!store) return withCors(Response.json({ error: 'Counting is off on this server.' }, { status: 503 }));
    try {
      return withCors(Response.json(await stats(store), { headers: { 'Cache-Control': 'no-store' } }));
    } catch (e) {
      console.error(e);
      return withCors(Response.json({ error: 'Counts are unavailable right now.' }, { status: 502 }));
    }
  }
  if (path !== '/mcp') return withCors(new Response('Not found\n', { status: 404 }));
  if (request.method !== 'POST') return rpcError(405, 'Method not allowed: this server is stateless, POST only.');

  // Read a copy of the body for the counter; the transport reads the original.
  const counting = count(request.clone());
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return withCors(await transport.handleRequest(request));
  } catch (e) {
    console.error(e);
    return rpcError(500, 'Internal server error');
  } finally {
    // JSON responses are complete once handleRequest returns, so nothing is left to stream.
    void transport.close();
    void server.close();
    // A serverless host may freeze the process once the response is returned, so give the
    // count a short window to land. It never fails the request.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([counting, new Promise((r) => { timer = setTimeout(r, COUNT_WAIT_MS); })]);
    clearTimeout(timer);
  }
}
