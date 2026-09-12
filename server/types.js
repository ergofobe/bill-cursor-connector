/**
 * Shared JSDoc types for the BILL Spend & Expense subset this plugin wraps.
 * These are documentation-only; runtime code is plain JavaScript.
 *
 * Auth: send header `apiToken` (not Bearer, not sessionId, not Authorization).
 * Production base: https://gateway.prod.bill.com/connect
 * Sandbox base:    https://gateway.stage.bill.com/connect
 */

/**
 * Transaction subset returned by list_transactions / get_transaction.
 * Field names follow the BILL Spend TransactionResponseDto.
 *
 * @typedef {object} SpendTransaction
 * @property {string} [id] Deprecated BILL-generated ID.
 * @property {string} [uuid] BILL-generated UUID of the transaction.
 * @property {number} [amount] Transaction amount including fees.
 * @property {string} [merchant] Alias of merchantName (cleaned merchant).
 * @property {string} [merchantName] Readable (cleaned) merchant name.
 * @property {string} [rawMerchantName] Raw merchant name.
 * @property {string} [occurredTime] Created / occurred datetime (ISO-8601).
 * @property {string} [authorizedTime] Authorization datetime (ISO-8601).
 * @property {string} [updatedTime] Last updated datetime (ISO-8601).
 * @property {string} [status] Transaction status (e.g. INCOMPLETE, COMPLETE).
 * @property {boolean} [complete] True when required fields (receipt + Category) are set.
 * @property {boolean} [reviewRequired] True if a review is required.
 * @property {boolean} [receiptRequired] True if a receipt is required.
 * @property {string} [receiptStatus] Receipt status (MISSING, ATTACHED, …).
 * @property {boolean} [isLocked] True if custom fields cannot be updated.
 * @property {unknown[]} [receipts] Attached receipt objects.
 * @property {unknown[]} [customFields] Custom fields currently on the transaction.
 */

/**
 * Response from POST /v3/spend/transactions/receipt-upload-url.
 *
 * @typedef {object} ReceiptUploadUrl
 * @property {string} url Presigned upload URL. PUT JPG/PNG bytes here, then
 *   POST the same URL as `{ "url": "<upload url>" }` on the transaction.
 */

/**
 * A selectable value on a Spend custom field (typically Category).
 * BILL returns `uuid` (often `tvl_…`) and `value` (display text).
 *
 * @typedef {object} CustomFieldValue
 * @property {string} uuid BILL-generated UUID of the value (tvl_…).
 * @property {string} [name] Display name (mapped from API `value`).
 * @property {string} [label] Same as name, for callers that expect a label.
 * @property {string} [value] Raw API display string.
 * @property {string} [id] Deprecated BILL-generated ID.
 */

/**
 * Body for PUT /v3/spend/transactions/{transactionUuid}/custom-fields.
 * Prefer `customFieldId` (Oberon production / current BILL docs).
 *
 * @typedef {object} SetCustomFieldsBody
 * @property {Array<{
 *   customFieldId: string,
 *   selectedValues: string[],
 *   note?: string
 * }>} customFields
 */

export {};
