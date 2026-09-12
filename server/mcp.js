import { TOOL_DEFINITIONS, callTool, createToolContext, toolErrorText } from "./tools.js";

export const SERVER_INFO = {
  name: "bill-spend",
  version: "1.0.0",
};

const SUPPORTED_PROTOCOL = "2024-11-05";

/**
 * Zero-dependency JSON-RPC 2.0 MCP handler (stdio, newline-delimited).
 * Hand-rolled instead of @modelcontextprotocol/sdk: five tools, Node 18+
 * built-in fetch, no install step for a thin protocol wrapper.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   readFile?: (path: string) => Promise<Uint8Array>,
 * }} [options]
 */
export function createMcpHandler(options = {}) {
  const env = options.env ?? process.env;
  const ctx = createToolContext(options);

  /**
   * @param {unknown} message
   * @returns {Promise<object | null>}
   */
  async function handleMessage(message) {
    if (!message || typeof message !== "object") return null;
    const msg = /** @type {{ jsonrpc?: string, id?: string|number|null, method?: string, params?: Record<string, unknown> }} */ (
      message
    );
    if (msg.method && msg.id === undefined) {
      return null;
    }
    if (typeof msg.method !== "string") {
      return errorResponse(msg.id, -32600, "Invalid Request");
    }

    try {
      switch (msg.method) {
        case "initialize": {
          const requested =
            typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : SUPPORTED_PROTOCOL;
          return resultResponse(msg.id, {
            protocolVersion: requested || SUPPORTED_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
        }
        case "ping":
          return resultResponse(msg.id, {});
        case "tools/list":
          return resultResponse(msg.id, { tools: TOOL_DEFINITIONS });
        case "tools/call": {
          const name = String(msg.params?.name ?? "");
          const args =
            msg.params?.arguments && typeof msg.params.arguments === "object"
              ? /** @type {Record<string, unknown>} */ (msg.params.arguments)
              : {};
          try {
            const output = await callTool(ctx, name, args);
            return resultResponse(msg.id, {
              content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            });
          } catch (err) {
            return resultResponse(msg.id, {
              content: [{ type: "text", text: toolErrorText(err, env) }],
              isError: true,
            });
          }
        }
        default:
          return errorResponse(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      return errorResponse(msg.id, -32603, toolErrorText(err, env));
    }
  }

  return { handleMessage, ctx };
}

/**
 * @param {string|number|null|undefined} id
 * @param {unknown} result
 */
function resultResponse(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

/**
 * @param {string|number|null|undefined} id
 * @param {number} code
 * @param {string} message
 */
function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
