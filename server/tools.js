import { readFile as fsReadFile } from "node:fs/promises";
import { extname } from "node:path";
import { createBillClient, redactSecret, requireApiToken, SpendError } from "./client.js";

export const PDF_REJECT_MESSAGE =
  "BILL Spend accepts JPG and PNG receipts only. Convert the PDF first (for example: pdftoppm -jpeg -r 150 -singlefile receipt.pdf receipt) and attach the resulting .jpg, then retry.";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const PDF_MAGIC = Buffer.from("%PDF");

/**
 * @param {Uint8Array} bytes
 * @param {string} [hint]
 * @returns {{ kind: "jpeg" | "png", contentType: "image/jpeg" | "image/png" }}
 */
export function detectReceiptImage(bytes, hint = "") {
  const lower = String(hint).toLowerCase();
  const head = Buffer.from(bytes.subarray(0, 8));

  if (head.subarray(0, 4).equals(PDF_MAGIC) || lower.includes(".pdf") || lower.includes("application/pdf")) {
    throw new SpendError(PDF_REJECT_MESSAGE, { code: "pdf_rejected" });
  }

  const isJpeg =
    head.subarray(0, 3).equals(JPEG_MAGIC) ||
    lower.includes(".jpg") ||
    lower.includes(".jpeg") ||
    lower.includes("image/jpeg");
  const isPng = head.subarray(0, 4).equals(PNG_MAGIC) || lower.includes(".png") || lower.includes("image/png");

  if (isJpeg && !isPng) return { kind: "jpeg", contentType: "image/jpeg" };
  if (isPng) return { kind: "png", contentType: "image/png" };

  throw new SpendError(
    "Receipt must be a JPG or PNG image. PDF is not accepted — convert with pdftoppm first, then attach the image.",
    { code: "unsupported_receipt" },
  );
}

/**
 * Map a BILL transaction to the documented subset.
 *
 * @param {Record<string, unknown>} raw
 */
export function toTransactionSubset(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const merchantName = typeof raw.merchantName === "string" ? raw.merchantName : undefined;
  return {
    id: raw.id,
    uuid: raw.uuid,
    amount: raw.amount,
    merchant: merchantName,
    merchantName,
    rawMerchantName: raw.rawMerchantName,
    occurredTime: raw.occurredTime,
    authorizedTime: raw.authorizedTime,
    updatedTime: raw.updatedTime,
    status: raw.status,
    complete: raw.complete,
    reviewRequired: raw.reviewRequired,
    receiptRequired: raw.receiptRequired,
    receiptStatus: raw.receiptStatus,
    isLocked: raw.isLocked,
    receipts: raw.receipts,
    customFields: raw.customFields,
  };
}

/**
 * Map a custom field value. BILL uses `uuid` (tvl_…) and `value`.
 *
 * @param {Record<string, unknown>} raw
 */
export function toCustomFieldValue(raw) {
  const name = typeof raw.value === "string" ? raw.value : typeof raw.name === "string" ? raw.name : undefined;
  return {
    uuid: raw.uuid,
    id: raw.id,
    name,
    label: name,
    value: raw.value ?? name,
  };
}

/**
 * @param {unknown} amount
 * @returns {string | null}
 */
function normalizeAmount(amount) {
  if (amount === undefined || amount === null || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

/**
 * @param {unknown} dateLike
 * @returns {string | null} YYYY-MM-DD
 */
function toDateKey(dateLike) {
  if (!dateLike) return null;
  const s = String(dateLike);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Client-side match for amount, calendar date, and merchant substring.
 *
 * @param {Record<string, unknown>} tx
 * @param {{ amount?: unknown, date?: string, merchant?: string }} filters
 */
export function matchesTransactionFilters(tx, filters) {
  if (filters.amount !== undefined && filters.amount !== null && filters.amount !== "") {
    if (normalizeAmount(tx.amount) !== normalizeAmount(filters.amount)) return false;
  }
  if (filters.date) {
    const want = toDateKey(filters.date);
    const dates = [tx.occurredTime, tx.authorizedTime, tx.updatedTime]
      .map(toDateKey)
      .filter(Boolean);
    if (want && !dates.includes(want)) return false;
  }
  if (filters.merchant) {
    const needle = String(filters.merchant).toLowerCase();
    const hay = [tx.merchantName, tx.rawMerchantName, tx.merchant]
      .filter((v) => typeof v === "string")
      .join(" ")
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

/**
 * BILL list filters: amount exact via gte+lte, date via occurredTime range.
 * Merchant substring is applied client-side (API merchantName only supports eq).
 *
 * @param {{ amount?: unknown, date?: string }} filters
 */
export function buildListQueryFilters(filters) {
  /** @type {string[]} */
  const parts = [];
  const amt = normalizeAmount(filters.amount);
  if (amt) {
    parts.push(`amount:gte:${amt}`, `amount:lte:${amt}`);
  }
  const day = filters.date ? toDateKey(filters.date) : null;
  if (day) {
    parts.push(`occurredTime:gte:${day}T00:00:00Z`, `occurredTime:lte:${day}T23:59:59Z`);
  }
  return parts.length ? parts.join(",") : undefined;
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   readFile?: (path: string) => Promise<Uint8Array>,
 * }} [options]
 */
export function createToolContext(options = {}) {
  const env = options.env ?? process.env;
  const client = createBillClient({ env, fetchImpl: options.fetchImpl });
  const readFile =
    options.readFile ??
    (async (filePath) => {
      const buf = await fsReadFile(filePath);
      return new Uint8Array(buf);
    });
  return { env, client, readFile };
}

export const TOOL_DEFINITIONS = [
  {
    name: "list_transactions",
    description:
      "List BILL Spend & Expense card transactions. Optionally match amount, calendar date (YYYY-MM-DD), and merchant substring. Returns id/uuid, amount, merchant, date fields, status, complete, reviewRequired, receipts, and customFields.",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "number",
          description: "Exact transaction amount to match (2 decimal places).",
        },
        date: {
          type: "string",
          description: "Calendar date (YYYY-MM-DD) matched against occurred/authorized/updated time.",
        },
        merchant: {
          type: "string",
          description: "Case-insensitive substring of merchantName or rawMerchantName.",
        },
        max: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Page size (BILL max 50). Default 50.",
        },
        nextPage: {
          type: "string",
          description: "BILL nextPage token for pagination.",
        },
        complete: {
          type: "boolean",
          description: "If set, add a complete:eq filter on the list request.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_transaction",
    description: "Get one Spend & Expense transaction by BILL id or uuid.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: {
          type: "string",
          description: "BILL-generated transaction ID or UUID.",
        },
      },
      required: ["transactionId"],
      additionalProperties: false,
    },
  },
  {
    name: "attach_receipt",
    description:
      "Attach a JPG or PNG receipt to a transaction (3-step: create upload URL, PUT image bytes, POST receipts with the same url). Rejects PDF — convert with pdftoppm first.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: {
          type: "string",
          description: "BILL-generated transaction ID or UUID.",
        },
        filePath: {
          type: "string",
          description: "Local path to a .jpg/.jpeg or .png receipt image.",
        },
      },
      required: ["transactionId", "filePath"],
      additionalProperties: false,
    },
  },
  {
    name: "list_custom_field_values",
    description:
      "List values for a Spend custom field (typically Category). Returns uuid (tvl_…), name/label. Calls GET /v3/spend/custom-fields/{customFieldUuid}/values?max=100.",
    inputSchema: {
      type: "object",
      properties: {
        customFieldId: {
          type: "string",
          description: "BILL custom field ID or UUID. Prefer customFieldId in production.",
        },
        max: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Page size. Default 100.",
        },
        nextPage: {
          type: "string",
          description: "BILL nextPage token.",
        },
      },
      required: ["customFieldId"],
      additionalProperties: false,
    },
  },
  {
    name: "set_transaction_custom_fields",
    description:
      "Set custom field values on a transaction (Category). PUT body uses customFields[].customFieldId + selectedValues (tvl_…). After a receipt and the required Category are set, status becomes COMPLETE.",
    inputSchema: {
      type: "object",
      properties: {
        transactionId: {
          type: "string",
          description: "BILL-generated transaction UUID.",
        },
        customFieldId: {
          type: "string",
          description: "Custom field ID (preferred in Oberon production) or UUID.",
        },
        selectedValues: {
          type: "array",
          items: { type: "string" },
          description: "Custom field value UUIDs (tvl_…). Pass [] to clear.",
        },
        customFields: {
          type: "array",
          description: "Full customFields array. If omitted, built from customFieldId + selectedValues.",
          items: {
            type: "object",
            properties: {
              customFieldId: { type: "string" },
              selectedValues: { type: "array", items: { type: "string" } },
              note: { type: "string" },
            },
          },
        },
      },
      required: ["transactionId"],
      additionalProperties: false,
    },
  },
];

/**
 * @param {ReturnType<typeof createToolContext>} ctx
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
export async function callTool(ctx, name, args = {}) {
  switch (name) {
    case "list_transactions":
      return listTransactions(ctx, args);
    case "get_transaction":
      return getTransaction(ctx, args);
    case "attach_receipt":
      return attachReceipt(ctx, args);
    case "list_custom_field_values":
      return listCustomFieldValues(ctx, args);
    case "set_transaction_custom_fields":
      return setTransactionCustomFields(ctx, args);
    default:
      throw new SpendError(`Unknown tool: ${name}`, { code: "unknown_tool" });
  }
}

/**
 * @param {ReturnType<typeof createToolContext>} ctx
 * @param {Record<string, unknown>} args
 */
export async function listTransactions(ctx, args) {
  const query = {
    max: args.max ?? 50,
    includeReceipts: true,
    nextPage: args.nextPage,
  };
  const apiFilters = buildListQueryFilters(args);
  const extra = [];
  if (typeof args.complete === "boolean") extra.push(`complete:eq:${args.complete}`);
  const filters = [apiFilters, extra.join(",")].filter(Boolean).join(",");
  if (filters) query.filters = filters;

  const data = await ctx.client.billFetch("/v3/spend/transactions", { query });
  const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
  const matched = results.filter((tx) => matchesTransactionFilters(tx, args)).map(toTransactionSubset);
  return {
    results: matched,
    nextPage: data?.nextPage ?? null,
    prevPage: data?.prevPage ?? null,
  };
}

/**
 * @param {ReturnType<typeof createToolContext>} ctx
 * @param {Record<string, unknown>} args
 */
export async function getTransaction(ctx, args) {
  const id = String(args.transactionId ?? "").trim();
  if (!id) throw new SpendError("transactionId is required.", { code: "invalid_args" });
  const data = await ctx.client.billFetch(`/v3/spend/transactions/${encodeURIComponent(id)}`);
  return toTransactionSubset(data);
}

/**
 * @param {ReturnType<typeof createToolContext>} ctx
 * @param {Record<string, unknown>} args
 */
export async function attachReceipt(ctx, args) {
  const transactionId = String(args.transactionId ?? "").trim();
  const filePath = String(args.filePath ?? "").trim();
  if (!transactionId) throw new SpendError("transactionId is required.", { code: "invalid_args" });
  if (!filePath) throw new SpendError("filePath is required.", { code: "invalid_args" });

  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    throw new SpendError(PDF_REJECT_MESSAGE, { code: "pdf_rejected" });
  }

  const bytes = await ctx.readFile(filePath);
  const { contentType } = detectReceiptImage(bytes, `${filePath}`);

  /** @type {import("./types.js").ReceiptUploadUrl} */
  const upload = await ctx.client.billFetch("/v3/spend/transactions/receipt-upload-url", {
    method: "POST",
  });
  const uploadUrl = upload && typeof upload.url === "string" ? upload.url : "";
  if (!uploadUrl) {
    throw new SpendError("BILL did not return a receipt upload url.", { code: "upload_url_missing" });
  }

  await ctx.client.putUpload(uploadUrl, bytes, contentType);

  const attached = await ctx.client.billFetch(
    `/v3/spend/transactions/${encodeURIComponent(transactionId)}/receipts`,
    {
      method: "POST",
      json: { url: uploadUrl },
    },
  );

  return {
    ok: true,
    transactionId,
    contentType,
    uploadUrl,
    result: attached,
  };
}

/**
 * @param {ReturnType<typeof createToolContext>} ctx
 * @param {Record<string, unknown>} args
 */
export async function listCustomFieldValues(ctx, args) {
  const customFieldId = String(args.customFieldId ?? "").trim();
  if (!customFieldId) throw new SpendError("customFieldId is required.", { code: "invalid_args" });
  const data = await ctx.client.billFetch(
    `/v3/spend/custom-fields/${encodeURIComponent(customFieldId)}/values`,
    {
      query: { max: args.max ?? 100, nextPage: args.nextPage },
    },
  );
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    results: results.map(toCustomFieldValue),
    nextPage: data?.nextPage ?? null,
    prevPage: data?.prevPage ?? null,
  };
}

/**
 * Build the PUT body. Always emit customFieldId (not customFieldUuid).
 *
 * @param {Record<string, unknown>} args
 */
export function buildCustomFieldsBody(args) {
  if (Array.isArray(args.customFields) && args.customFields.length > 0) {
    return {
      customFields: args.customFields.map((item) => {
        const row = item && typeof item === "object" ? item : {};
        const customFieldId = String(row.customFieldId ?? row.customFieldUuid ?? "").trim();
        if (!customFieldId) {
          throw new SpendError("Each customFields item needs customFieldId.", { code: "invalid_args" });
        }
        /** @type {{ customFieldId: string, selectedValues: string[], note?: string }} */
        const out = {
          customFieldId,
          selectedValues: Array.isArray(row.selectedValues) ? row.selectedValues.map(String) : [],
        };
        if (typeof row.note === "string") out.note = row.note;
        return out;
      }),
    };
  }

  const customFieldId = String(args.customFieldId ?? args.customFieldUuid ?? "").trim();
  if (!customFieldId) {
    throw new SpendError("customFieldId (or customFields[]) is required.", { code: "invalid_args" });
  }
  const selectedValues = Array.isArray(args.selectedValues) ? args.selectedValues.map(String) : [];
  return { customFields: [{ customFieldId, selectedValues }] };
}

/**
 * @param {ReturnType<typeof createToolContext>} ctx
 * @param {Record<string, unknown>} args
 */
export async function setTransactionCustomFields(ctx, args) {
  const transactionId = String(args.transactionId ?? "").trim();
  if (!transactionId) throw new SpendError("transactionId is required.", { code: "invalid_args" });
  const body = buildCustomFieldsBody(args);
  const result = await ctx.client.billFetch(
    `/v3/spend/transactions/${encodeURIComponent(transactionId)}/custom-fields`,
    { method: "PUT", json: body },
  );
  return { ok: true, body, result };
}

/**
 * Safe tool error text: never include the token.
 *
 * @param {unknown} err
 * @param {Record<string, string | undefined>} env
 */
export function toolErrorText(err, env) {
  const token = typeof env.BILL_SPEND_API_TOKEN === "string" ? env.BILL_SPEND_API_TOKEN : "";
  const message = err instanceof Error ? err.message : String(err);
  return redactSecret(message, token);
}

/**
 * Used by tests that assert the token is configured without printing it.
 *
 * @param {Record<string, string | undefined>} env
 */
export function assertTokenConfigured(env) {
  requireApiToken(env);
  return { configured: true };
}
