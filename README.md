# BILL Spend & Expense (Cursor plugin)

Shareable [Cursor plugin](https://cursor.com/docs/plugins) that lists BILL Spend & Expense (Divvy) card transactions, attaches **JPG/PNG** receipts, and sets the **Category** custom field.

This is **not** an official BILL product. Marketplace / cursor.directory publication and any BILL affiliation statement are out of scope here — the repo owner decides that later.

## What it wraps

| Tool | BILL call |
| --- | --- |
| `list_transactions` | `GET /v3/spend/transactions` (+ client-side amount / date / merchant match) |
| `get_transaction` | `GET /v3/spend/transactions/{id}` |
| `attach_receipt` | `POST /v3/spend/transactions/receipt-upload-url` → `PUT` image bytes → `POST /v3/spend/transactions/{id}/receipts` |
| `list_custom_field_values` | `GET /v3/spend/custom-fields/{customFieldUuid}/values?max=100` |
| `set_transaction_custom_fields` | `PUT /v3/spend/transactions/{transactionUuid}/custom-fields` |

Production base URL: `https://gateway.prod.bill.com/connect`  
Sandbox (optional): `https://gateway.stage.bill.com/connect`

## What it does not wrap

AP/AR, `/v3/login`, pay, refund, card-create, budgets CRUD, reimbursements, webhooks, or anything that creates cards or moves money.

## Auth

- Header name is **`apiToken`**. Not `Authorization`, not `Bearer`, not `sessionId`.
- Value comes from **`BILL_SPEND_API_TOKEN`** — the Admin-generated Spend & Expense API token ([BILL docs](https://developer.bill.com/docs/authentication-with-api-token)).
- Optional **`BILL_SPEND_BASE_URL`** overrides the gateway (sandbox: `https://gateway.stage.bill.com/connect`).
- **Never log, print, or commit the token.** Errors redact it if an upstream body echoes it.

Set the token in Cursor: **Plugins → Configure** (declared in `.cursor-plugin/plugin.json`). For a local CLI run, export it in the environment instead. No secrets belong in this repo.

## Install in Cursor

1. Clone this repository (or add it as a plugin source).
2. Open **Plugins → Configure** and set **BILL Spend API token** (`BILL_SPEND_API_TOKEN`).
3. Reload the window. The `bill-spend` MCP server starts with:

```json
{
  "command": "node",
  "args": ["server/index.js"],
  "env": {
    "BILL_SPEND_API_TOKEN": "${BILL_SPEND_API_TOKEN}"
  }
}
```

Requires **Node 18+** on the PATH (`fetch` is built in). There are **no npm dependencies**.

### MCP implementation choice

The server is a small **zero-dependency** JSON-RPC 2.0 stdio loop (`initialize`, `tools/list`, `tools/call`, `ping`). `@modelcontextprotocol/sdk` was not added: for five tools and built-in `fetch`, the SDK would be an install-only wrapper around the same messages.

## Local run (env token)

```bash
export BILL_SPEND_API_TOKEN='…'          # never commit this
# optional:
# export BILL_SPEND_BASE_URL='https://gateway.stage.bill.com/connect'

node server/index.js
```

The process reads newline-delimited JSON-RPC on stdin. You do not need `npm install`.

## Tests

Automated tests **mock `fetch`**. They never call live BILL.

```bash
npm test
```

Coverage includes: list filter (amount / date / merchant), receipt 3-step happy path, PDF reject, Category PUT body shape (`customFields` + `customFieldId` + `selectedValues`), and a missing-token error that never includes a token value.

### Optional manual production smoke

Not part of `npm test`. Only if you have a real Admin token and a disposable transaction:

```bash
export BILL_SPEND_API_TOKEN='…'
# Then in Cursor: list a known txn, attach a small JPG, set Category.
```

Do not commit tokens, receipts with PII, or production IDs you care about.

## Receipts: JPG/PNG only

BILL rejects PDF receipts. Convert first, then attach the image:

```bash
pdftoppm -jpeg -r 150 -singlefile receipt.pdf receipt
# writes receipt.jpg
```

`attach_receipt` returns a convert-first error if the file is a PDF.

## Category custom field

Prefer **`customFieldId`** in the PUT body (current BILL docs / Oberon production). `selectedValues` are value UUIDs (`tvl_…`) from `list_custom_field_values`.

```json
{
  "customFields": [
    {
      "customFieldId": "<category field id>",
      "selectedValues": ["tvl_…"]
    }
  ]
}
```

After a receipt **and** the required Category are set, transaction `status` becomes `COMPLETE`.

## Data shapes

### Transaction (subset)

`id` / `uuid`, `amount`, `merchant` / `merchantName` (plus `rawMerchantName`), date fields (`occurredTime`, `authorizedTime`, `updatedTime`), `status`, `complete`, `reviewRequired`, `receipts`, `customFields`.

See JSDoc in [`server/types.js`](server/types.js).

### ReceiptUploadUrl

```json
{ "url": "https://…" }
```

### CustomFieldValue

```json
{ "uuid": "tvl_…", "name": "Travel", "label": "Travel" }
```

(`name` / `label` are mapped from the API `value` field.)

## Plugin layout

```
.cursor-plugin/plugin.json          # name: bill-spend; dashboard variable
mcp.json                            # stdio MCP + ${BILL_SPEND_API_TOKEN}
server/                             # Node 18+ MCP (no npm deps)
skills/bill-spend-receipts/SKILL.md
assets/logo.svg
README.md
LICENSE                             # MIT
```

No rules, hooks, agents, or commands.

## License

MIT. See [LICENSE](LICENSE).
