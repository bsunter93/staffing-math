/**
 * The server as one Web-standard fetch handler, for hosts that take one: Vercel, Cloudflare
 * Workers, Deno, Bun. Stateless, like the Node HTTP mode: a fresh server per request.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from './server';

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
  if (path !== '/mcp') return withCors(new Response('Not found\n', { status: 404 }));
  if (request.method !== 'POST') return rpcError(405, 'Method not allowed: this server is stateless, POST only.');

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
  }
}
