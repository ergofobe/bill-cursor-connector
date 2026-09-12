import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBillClient, DEFAULT_BASE_URL, redactSecret, requireApiToken, SpendError } from "../server/client.js";
import {
  PDF_REJECT_MESSAGE,
  attachReceipt,
  buildCustomFieldsBody,
  buildListQueryFilters,
  callTool,
  createToolContext,
  detectReceiptImage,
  listTransactions,
  matchesTransactionFilters,
  setTransactionCustomFields,
  toolErrorText,
} from "../server/tools.js";
import { createMcpHandler, SERVER_INFO } from "../server/mcp.js";

const SECRET = "test-token-do-not-leak-9f3a";
const OTHER_SECRET = "should-never-appear-in-errors";

/** Minimal JPEG (SOI + APP0-ish stub) */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

/**
 * @param {Array<{ match: (url: string, init: RequestInit) => boolean, status?: number, body?: unknown, capture?: object }>} routes
 */
function mockFetch(routes) {
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = routes.find((r) => r.match(String(url), init));
    if (!hit) {
      return new Response(JSON.stringify({ error: "unexpected fetch", url }), {
        status: 599,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (hit.capture) {
      hit.capture.url = String(url);
      hit.capture.init = init;
    }
    const status = hit.status ?? 200;
    if (hit.body === undefined || hit.body === null) {
      return new Response("", { status });
    }
    if (typeof hit.body === "string" || hit.body instanceof Uint8Array) {
      return new Response(hit.body, { status });
    }
    return new Response(JSON.stringify(hit.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function sampleTransactions() {
  return [
    {
      id: "tx_1",
      uuid: "txn_aaa",
      amount: 42.5,
      merchantName: "Airport Cafe",
      rawMerchantName: "AIRPORT CAFE LLC",
      occurredTime: "2026-04-02T15:04:00Z",
      authorizedTime: "2026-04-02T15:04:00Z",
      updatedTime: "2026-04-02T16:00:00Z",
      status: "INCOMPLETE",
      complete: false,
      reviewRequired: false,
      receipts: [],
      customFields: [],
    },
    {
      id: "tx_2",
      uuid: "txn_bbb",
      amount: 19.99,
      merchantName: "Office Depot",
      rawMerchantName: "OFFICE DEPOT #12",
      occurredTime: "2026-04-02T10:00:00Z",
      status: "INCOMPLETE",
      complete: false,
      reviewRequired: true,
      receipts: [],
      customFields: [],
    },
    {
      id: "tx_3",
      uuid: "txn_ccc",
      amount: 42.5,
      merchantName: "Harbor Freight",
      rawMerchantName: "HARBOR FREIGHT",
      occurredTime: "2026-03-01T12:00:00Z",
      status: "COMPLETE",
      complete: true,
      reviewRequired: false,
      receipts: [{ id: "rcpt_1" }],
      customFields: [{ customFieldId: "cf_cat", selectedValues: ["tvl_tools"] }],
    },
  ];
}

test("list_transactions filters by amount, date, and merchant substring", async () => {
  const capture = {};
  const { fetchImpl, calls } = mockFetch([
    {
      match: (url) => url.includes("/v3/spend/transactions") && !url.includes("/receipts"),
      capture,
      body: { results: sampleTransactions() },
    },
  ]);
  const ctx = createToolContext({
    env: { BILL_SPEND_API_TOKEN: SECRET },
    fetchImpl,
  });

  const out = await listTransactions(ctx, {
    amount: 42.5,
    date: "2026-04-02",
    merchant: "airport",
  });

  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].uuid, "txn_aaa");
  assert.equal(out.results[0].merchant, "Airport Cafe");
  assert.equal(out.results[0].merchantName, "Airport Cafe");
  assert.equal(out.results[0].complete, false);
  assert.ok("receipts" in out.results[0]);
  assert.ok("customFields" in out.results[0]);

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${DEFAULT_BASE_URL}/v3/spend/transactions`);
  assert.equal(url.searchParams.get("includeReceipts"), "true");
  const filters = url.searchParams.get("filters") ?? "";
  assert.match(filters, /amount:gte:42\.50/);
  assert.match(filters, /amount:lte:42\.50/);
  assert.match(filters, /occurredTime:gte:2026-04-02T00:00:00Z/);

  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
  assert.equal(headers.apiToken, SECRET);
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.authorization, undefined);
});

test("matchesTransactionFilters and buildListQueryFilters helpers", () => {
  const tx = sampleTransactions()[0];
  assert.equal(matchesTransactionFilters(tx, { merchant: "CAFE" }), true);
  assert.equal(matchesTransactionFilters(tx, { merchant: "depot" }), false);
  assert.equal(matchesTransactionFilters(tx, { amount: "42.50" }), true);
  assert.equal(matchesTransactionFilters(tx, { amount: 42.51 }), false);
  assert.equal(matchesTransactionFilters(tx, { date: "2026-04-02" }), true);
  assert.equal(matchesTransactionFilters(tx, { date: "2026-04-03" }), false);
  assert.equal(buildListQueryFilters({ amount: 10 }), "amount:gte:10.00,amount:lte:10.00");
});

test("attach_receipt happy path: upload-url, PUT bytes, POST receipts with same url", async () => {
  const uploadUrl = "https://uploads.example.test/receipts/abc?sig=1";
  /** @type {object[]} */
  const capture = [];
  const { fetchImpl, calls } = mockFetch([
    {
      match: (url, init) => url.endsWith("/v3/spend/transactions/receipt-upload-url") && init.method === "POST",
      body: { url: uploadUrl },
    },
    {
      match: (url, init) => url === uploadUrl && init.method === "PUT",
      status: 200,
      body: "",
    },
    {
      match: (url, init) => url.includes("/v3/spend/transactions/txn_aaa/receipts") && init.method === "POST",
      body: { status: "SUCCESS" },
    },
  ]);

  const ctx = createToolContext({
    env: { BILL_SPEND_API_TOKEN: SECRET },
    fetchImpl,
    readFile: async (p) => {
      assert.equal(p, "/tmp/coffee.jpg");
      return JPEG_BYTES;
    },
  });

  const out = await attachReceipt(ctx, { transactionId: "txn_aaa", filePath: "/tmp/coffee.jpg" });
  assert.equal(out.ok, true);
  assert.equal(out.contentType, "image/jpeg");
  assert.equal(out.uploadUrl, uploadUrl);

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/v3\/spend\/transactions\/receipt-upload-url$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(/** @type {Record<string, string>} */ (calls[0].init.headers).apiToken, SECRET);

  assert.equal(calls[1].url, uploadUrl);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(/** @type {Record<string, string>} */ (calls[1].init.headers)["Content-Type"], "image/jpeg");
  assert.equal(/** @type {Record<string, string>} */ (calls[1].init.headers).apiToken, undefined);
  assert.deepEqual(calls[1].init.body, JPEG_BYTES);

  assert.match(calls[2].url, /\/v3\/spend\/transactions\/txn_aaa\/receipts$/);
  assert.equal(calls[2].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { url: uploadUrl });
  assert.equal(/** @type {Record<string, string>} */ (calls[2].init.headers).apiToken, SECRET);
  assert.equal(/** @type {Record<string, string>} */ (calls[2].init.headers).Authorization, undefined);
});

test("attach_receipt rejects PDF with convert-first error and does not fetch", async () => {
  const { fetchImpl, calls } = mockFetch([]);
  const ctx = createToolContext({
    env: { BILL_SPEND_API_TOKEN: SECRET },
    fetchImpl,
    readFile: async () => {
      throw new Error("should not read PDF after extension check");
    },
  });

  await assert.rejects(
    () => attachReceipt(ctx, { transactionId: "txn_aaa", filePath: "/tmp/scan.pdf" }),
    (err) => {
      assert.ok(err instanceof SpendError);
      assert.equal(err.code, "pdf_rejected");
      assert.equal(err.message, PDF_REJECT_MESSAGE);
      assert.match(err.message, /pdftoppm/);
      assert.doesNotMatch(err.message, /Bearer|Authorization|sessionId/);
      return true;
    },
  );
  assert.equal(calls.length, 0);

  assert.throws(() => detectReceiptImage(PDF_BYTES, "receipt.bin"), (err) => {
    assert.equal(err.message, PDF_REJECT_MESSAGE);
    return true;
  });
  assert.deepEqual(detectReceiptImage(PNG_BYTES, "x.png"), { kind: "png", contentType: "image/png" });
});

test("set_transaction_custom_fields sends customFields + customFieldId + selectedValues", async () => {
  const capture = {};
  const { fetchImpl, calls } = mockFetch([
    {
      match: (url, init) => url.includes("/custom-fields") && init.method === "PUT",
      capture,
      body: { status: "SUCCESS" },
    },
  ]);
  const ctx = createToolContext({
    env: { BILL_SPEND_API_TOKEN: SECRET },
    fetchImpl,
  });

  const out = await setTransactionCustomFields(ctx, {
    transactionId: "txn_aaa",
    customFieldId: "cf_category_prod",
    selectedValues: ["tvl_meals"],
  });

  assert.deepEqual(out.body, {
    customFields: [{ customFieldId: "cf_category_prod", selectedValues: ["tvl_meals"] }],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v3\/spend\/transactions\/txn_aaa\/custom-fields$/);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(sent, {
    customFields: [{ customFieldId: "cf_category_prod", selectedValues: ["tvl_meals"] }],
  });
  assert.equal(Object.prototype.hasOwnProperty.call(sent.customFields[0], "customFieldUuid"), false);

  const fromUuidAlias = buildCustomFieldsBody({
    customFieldUuid: "legacy-uuid",
    selectedValues: ["tvl_x"],
  });
  assert.deepEqual(fromUuidAlias, {
    customFields: [{ customFieldId: "legacy-uuid", selectedValues: ["tvl_x"] }],
  });
});

test("missing token error never includes the token value", async () => {
  const env = { BILL_SPEND_API_TOKEN: "" };
  assert.throws(() => requireApiToken(env), (err) => {
    const text = JSON.stringify(err);
    assert.doesNotMatch(err.message, new RegExp(SECRET));
    assert.doesNotMatch(err.message, new RegExp(OTHER_SECRET));
    assert.doesNotMatch(text, /test-token-do-not-leak/);
    assert.match(err.message, /BILL_SPEND_API_TOKEN is not set/);
    assert.match(err.message, /Not a Bearer token/);
    assert.equal(err.code, "missing_token");
    return true;
  });

  const { fetchImpl, calls } = mockFetch([]);
  const ctx = createToolContext({ env: {}, fetchImpl });
  await assert.rejects(() => listTransactions(ctx, {}), (err) => {
    assert.doesNotMatch(err.message, new RegExp(SECRET));
    assert.doesNotMatch(err.message, new RegExp(OTHER_SECRET));
    assert.match(err.message, /BILL_SPEND_API_TOKEN is not set/);
    return true;
  });
  assert.equal(calls.length, 0);

  const echoed = `Unauthorized apiToken=${SECRET}`;
  assert.equal(redactSecret(echoed, SECRET), "Unauthorized apiToken=[redacted]");
  assert.equal(toolErrorText(new Error(echoed), { BILL_SPEND_API_TOKEN: SECRET }), "Unauthorized apiToken=[redacted]");
  assert.doesNotMatch(toolErrorText(new Error(echoed), { BILL_SPEND_API_TOKEN: SECRET }), new RegExp(SECRET));
});

test("API error bodies that echo the token are redacted", async () => {
  const { fetchImpl } = mockFetch([
    {
      match: () => true,
      status: 401,
      body: `bad token ${SECRET}`,
    },
  ]);
  const client = createBillClient({
    env: { BILL_SPEND_API_TOKEN: SECRET },
    fetchImpl,
  });
  await assert.rejects(() => client.billFetch("/v3/spend/transactions"), (err) => {
    assert.doesNotMatch(err.message, new RegExp(SECRET));
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
});

test("MCP initialize, tools/list (5 tools), and tools/call missing token", async () => {
  const { handleMessage } = createMcpHandler({
    env: {},
    fetchImpl: async () => {
      throw new Error("no live calls");
    },
  });

  const init = await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(init.result.serverInfo.name, SERVER_INFO.name);
  assert.equal(init.result.capabilities.tools !== undefined, true);

  const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = listed.result.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "list_transactions",
    "get_transaction",
    "attach_receipt",
    "list_custom_field_values",
    "set_transaction_custom_fields",
  ]);

  const call = await handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_transactions", arguments: {} },
  });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /BILL_SPEND_API_TOKEN is not set/);
  assert.doesNotMatch(JSON.stringify(call), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(call), /should-never-appear/);
});

test("get_transaction and list_custom_field_values shapes", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      match: (url) => url.includes("/v3/spend/transactions/txn_aaa") && !url.includes("custom-fields"),
      body: sampleTransactions()[0],
    },
    {
      match: (url) => url.includes("/v3/spend/custom-fields/cf_cat/values"),
      body: {
        results: [{ uuid: "tvl_meals", value: "Meals", id: "old" }],
      },
    },
  ]);
  const ctx = createToolContext({ env: { BILL_SPEND_API_TOKEN: SECRET }, fetchImpl });
  const tx = await callTool(ctx, "get_transaction", { transactionId: "txn_aaa" });
  assert.equal(tx.uuid, "txn_aaa");
  assert.equal(tx.merchant, "Airport Cafe");

  const values = await callTool(ctx, "list_custom_field_values", { customFieldId: "cf_cat" });
  assert.deepEqual(values.results[0], {
    uuid: "tvl_meals",
    id: "old",
    name: "Meals",
    label: "Meals",
    value: "Meals",
  });
  assert.ok(calls[1].url.includes("max=100"));
});

test("sandbox base URL override and forbidden paths", async () => {
  const { fetchImpl, calls } = mockFetch([
    { match: () => true, body: { results: [] } },
  ]);
  const ctx = createToolContext({
    env: {
      BILL_SPEND_API_TOKEN: SECRET,
      BILL_SPEND_BASE_URL: "https://gateway.stage.bill.com/connect/",
    },
    fetchImpl,
  });
  await listTransactions(ctx, {});
  assert.ok(calls[0].url.startsWith("https://gateway.stage.bill.com/connect/v3/spend/transactions"));

  const client = createBillClient({ env: { BILL_SPEND_API_TOKEN: SECRET }, fetchImpl });
  await assert.rejects(() => client.billFetch("/v3/login"), /unwrapped BILL path/);
  await assert.rejects(() => client.billFetch("/v3/spend/budgets"), /unwrapped BILL path/);
});

test("source tree does not call forbidden BILL endpoints", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "server");
  const src = ["client.js", "tools.js", "mcp.js", "index.js"]
    .map((f) => readFileSync(join(root, f), "utf8"))
    .join("\n");
  const called = [...src.matchAll(/billFetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]);
  const allowed = [
    "/v3/spend/transactions",
    "/v3/spend/transactions/${encodeURIComponent(id)}",
    "/v3/spend/transactions/receipt-upload-url",
    "/v3/spend/transactions/${encodeURIComponent(transactionId)}/receipts",
    "/v3/spend/custom-fields/${encodeURIComponent(customFieldId)}/values",
    "/v3/spend/transactions/${encodeURIComponent(transactionId)}/custom-fields",
  ];
  for (const path of called) {
    assert.ok(
      allowed.includes(path) || path.startsWith("/v3/spend/transactions/") || path.startsWith("/v3/spend/custom-fields/"),
      `unexpected billFetch path: ${path}`,
    );
    assert.doesNotMatch(path, /login|budgets|cards|reimburs|webhook|payments/i);
  }
  assert.ok(called.length >= 5);
  assert.match(src, /apiToken:\s*token/);
  assert.doesNotMatch(src, /headers\s*:\s*\{[^}]*Authorization/s);
});
