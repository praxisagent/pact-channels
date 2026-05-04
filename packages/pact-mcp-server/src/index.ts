#!/usr/bin/env node

import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './mcp.js';

dotenv.config();

async function main() {
  const rpcUrl = process.env['RPC_URL'] ?? 'https://arb1.arbitrum.io/rpc';

  const server = createServer(rpcUrl);

  // ── HTTP / SSE transport ────────────────────────────────────
  const app = express();

  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.error(`${req.method} ${req.url}`);
    next();
  });

  const transports: Record<string, SSEServerTransport> = {};

  app.get('/sse', async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = (transport as unknown as Record<string, unknown>)['sessionId'];
    if (typeof sessionId !== 'string') {
      throw new TypeError('SSE transport did not expose a string sessionId');
    }
    transports[sessionId] = transport;
    await server.connect(transport);
  });

  app.post('/messages', async (req: Request, res: Response) => {
    const sessionIdParam = req.query['sessionId'];
    if (typeof sessionIdParam !== 'string') {
      res.status(400).send('sessionId query parameter is required');
      return;
    }
    const transport = transports[sessionIdParam];
    if (!transport) {
      res.status(400).send('No transport for sessionId');
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  app.get('/.well-known/agent.json', (_req: Request, res: Response) => {
    res.json({
      name: 'PACT MCP Server',
      version: '1.0.0',
      description: 'MCP server for PACT Protocol — trustless escrow and payment channels for AI agents on Arbitrum',
      website: 'https://dopeasset.com',
      skills: [
        {
          id: 'pact-escrow',
          name: 'PACT Escrow',
          description: 'Create, complete, verify, and reclaim trustless PACT escrow agreements',
          tags: ['escrow', 'arbitrum', 'pact', 'agents'],
          examples: ['pact_get_escrow', 'pact_build_create_escrow', 'pact_build_complete_escrow'],
          inputModes: ['application/json'],
          outputModes: ['application/json'],
        },
        {
          id: 'pact-channels',
          name: 'PACT Payment Channels',
          description: 'Open and settle bidirectional PACT payment channels for agent micropayments',
          tags: ['payment-channels', 'micropayments', 'arbitrum', 'pact'],
          examples: ['pact_get_channel', 'pact_build_open_channel', 'pact_compute_payment_digest'],
          inputModes: ['application/json'],
          outputModes: ['application/json'],
        },
      ],
    });
  });

  const PORT = process.env['PORT'] ?? 3020;
  app.listen(PORT, () => console.error(`PACT MCP server listening on port ${PORT}`));

  // ── STDIO transport ─────────────────────────────────────────
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  process.stdin.on('end', () => process.exit(0));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
