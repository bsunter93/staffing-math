/**
 * Entry point.
 *
 *   staffing-math                 stdio, for Claude Desktop and Claude Code
 *   staffing-math --http          Streamable HTTP on 127.0.0.1:3000/mcp
 *   staffing-math --http --port 8080 --host 0.0.0.0
 *
 * stdout belongs to the protocol in stdio mode, so anything for a person goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttp } from './http';
import { buildServer } from './server';

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.error('Usage: staffing-math [--http] [--port 3000] [--host 127.0.0.1]');
    return;
  }
  if (args.includes('--http')) {
    const port = Number(argValue(args, '--port') ?? process.env.PORT ?? 3000);
    const host = argValue(args, '--host') ?? process.env.HOST ?? '127.0.0.1';
    await startHttp(port, host);
    console.error(`Staffing Math listening on http://${host}:${port}/mcp`);
    return;
  }
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error('Staffing Math running on stdio');
}

main().catch((e) => { console.error(e); process.exit(1); });
