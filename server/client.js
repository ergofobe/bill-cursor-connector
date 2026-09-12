/**
 * BILL Spend & Expense HTTP client.
 *
 * Wraps only:
 *   GET  /v3/spend/transactions
 *   GET  /v3/spend/transactions/{id}
 *   POST /v3/spend/transactions/receipt-upload-url
 *   PUT  <presigned upload url>  (image bytes; no apiToken header)
 *   POST /v3/spend/transactions/{id}/receipts
 *   GET  /v3/spend/custom-fields/{id}/values
 *   PUT  /v3/spend/transactions/{id}/custom-fields
 *
 * Does not wrap AP/AR, /v3/login, pay, refund, card-create, budgets CRUD,
 * reimbursements, webhooks, or anything that creates cards or moves money.
 */

export const DEFAULT_BASE_URL = "https://gateway.prod.bill.com/connect";
export const SANDBOX_BASE_URL = "https://gateway.stage.bill.com/connect";

const ALLOWED_BILL_PATHS = [
  /^\/v3\/spend\/transactions$/,
  /^\/v3\/spend\/transactions\/receipt-upload-url$/,
  /^\/v3\/spend\/transactions\/[^/]+$/,
  /^\/v3\/spend\/transactions\/[^/]+\/receipts$/,
  /^\/v3\/spend\/transactions\/[^/]+\/custom-fields$/,
  /^\/v3\/spend\/custom-fields\/[^/]+\/values$/,
];

export class SpendError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string }} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = "SpendError";
    this.status = extra.status;
    this.code = extra.code;
  }
}

/**
 * Redact a secret from any string that might leak into logs or tool errors.
 * Never include the token value in thrown messages.
 *
 * @param {unknown} value
 * @param {string} [secret]
 * @returns {string}
 */
export function redactSecret(value, secret) {
  const text = value == null ? "" : String(value);
  if (!secret) return text;
  if (secret.length === 0) return text;
  return text.split(secret).join("[redacted]");
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function requireApiToken(env) {
  const token = typeof env.BILL_SPEND_API_TOKEN === "string" ? env.BILL_SPEND_API_TOKEN.trim() : "";
  if (!token) {
    throw new SpendError(
      "BILL_SPEND_API_TOKEN is not set. Configure it in Cursor Plugins → Configure, or export it locally. Use the Spend & Expense apiToken header value (Admin-generated). Not a Bearer token.",
      { code: "missing_token" },
    );
  }
  return token;
}

/**
 * @param {string} pathname
 */
export function assertAllowedBillPath(pathname) {
  const pathOnly = pathname.split("?")[0];
  if (!ALLOWED_BILL_PATHS.some((re) => re.test(pathOnly))) {
    throw new SpendError(`Refusing to call unwrapped BILL path: ${pathOnly}`, {
      code: "forbidden_path",
    });
  }
}

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveBaseUrl(env = {}) {
  const raw = typeof env.BILL_SPEND_BASE_URL === "string" ? env.BILL_SPEND_BASE_URL.trim() : "";
  const base = raw || DEFAULT_BASE_URL;
  return base.replace(/\/+$/, "");
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
export function createBillClient(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  /**
   * @param {string} path
   * @param {{ method?: string, query?: Record<string, string | number | boolean | undefined>, json?: unknown }} [opts]
   */
  async function billFetch(path, opts = {}) {
    const token = requireApiToken(env);
    const pathname = path.startsWith("/") ? path : `/${path}`;
    assertAllowedBillPath(pathname);

    const url = new URL(`${resolveBaseUrl(env)}${pathname}`);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    /** @type {Record<string, string>} */
    const headers = {
      apiToken: token,
      Accept: "application/json",
    };
    /** @type {RequestInit} */
    const init = {
      method: opts.method ?? "GET",
      headers,
    };
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.json);
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), init);
    } catch (err) {
      throw new SpendError(
        `BILL Spend request failed: ${redactSecret(err instanceof Error ? err.message : err, token)}`,
        { code: "network" },
      );
    }

    const text = await response.text();
    const safeText = redactSecret(text, token);
    if (!response.ok) {
      throw new SpendError(
        `BILL Spend API ${response.status} on ${opts.method ?? "GET"} ${pathname}: ${safeText || response.statusText}`,
        { status: response.status, code: "http_error" },
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(safeText);
    } catch {
      return safeText;
    }
  }

  /**
   * PUT image bytes to a presigned upload URL. Do not attach apiToken.
   *
   * @param {string} uploadUrl
   * @param {Uint8Array} bytes
   * @param {string} contentType
   */
  async function putUpload(uploadUrl, bytes, contentType) {
    const token = requireApiToken(env);
    let response;
    try {
      response = await fetchImpl(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes,
      });
    } catch (err) {
      throw new SpendError(
        `Receipt upload failed: ${redactSecret(err instanceof Error ? err.message : err, token)}`,
        { code: "network" },
      );
    }
    if (!response.ok) {
      const text = redactSecret(await response.text(), token);
      throw new SpendError(
        `Receipt upload PUT ${response.status}: ${text || response.statusText}`,
        { status: response.status, code: "upload_failed" },
      );
    }
  }

  return {
    env,
    billFetch,
    putUpload,
  };
}
