/**
 * Streamable HTTP for ChatGPT developer mode and Claude custom connectors. Both need the
 * endpoint at a public HTTPS URL; this listens on plain HTTP and expects a proxy or tunnel
 * in front for that.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server';

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch { reject(new Error('request body is not JSON')); }
    });
    req.on('error', reject);
  });
}

function rpcError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/*
 * Stateless: a fresh server and transport per request. The tools hold no state, so there is
 * nothing a session would keep, and any number of instances can sit behind a load balancer.
 */
async function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Staffing Math MCP server. Connect an MCP client to /mcp.\n');
    return;
  }
  if (path !== '/mcp') { res.writeHead(404); res.end(); return; }
  if (req.method !== 'POST') { rpcError(res, 405, 'Method not allowed: this server is stateless, POST only.'); return; }

  let body: unknown;
  try { body = await readBody(req); } catch (e) { rpcError(res, 400, (e as Error).message); return; }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) rpcError(res, 500, 'Internal server error');
  }
}

export function startHttp(port: number, host: string): Promise<Server> {
  const http = createServer((req, res) => { void handle(req, res); });
  return new Promise((resolve) => http.listen(port, host, () => resolve(http)));
}
