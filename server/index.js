#!/usr/bin/env node
/**
 * BILL Spend & Expense MCP server (stdio, JSON-RPC 2.0).
 * Zero npm dependencies. Requires Node 18+ (built-in fetch).
 *
 * Env:
 *   BILL_SPEND_API_TOKEN  required — Spend apiToken header (never logged)
 *   BILL_SPEND_BASE_URL   optional — default production gateway
 */

import readline from "node:readline";
import { createMcpHandler } from "./mcp.js";

const handler = createMcpHandler();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const response = await handler.handleMessage(message);
  if (response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});

rl.on("close", () => {
  process.exit(0);
});
