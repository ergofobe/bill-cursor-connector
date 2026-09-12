---
name: bill-spend-receipts
description: >
  Attach JPG/PNG receipts and set Category on BILL Spend & Expense (Divvy)
  card transactions. Use when the user mentions Divvy, BILL Spend, Spend &
  Expense receipts, listing card transactions, or setting a transaction
  Category.
---

# BILL Spend & Expense receipts

Use this skill with the `bill-spend` MCP tools. Do not invent AP/AR, payments, cards, budgets, or webhook calls.

## When to use

- Divvy / BILL Spend & Expense receipt capture
- List or find company-card transactions (amount, date, merchant)
- Set the required **Category** custom field so a transaction becomes `COMPLETE`

## Auth

- Header name is **`apiToken`**. Not `Authorization`, not `Bearer`, not `sessionId`.
- Token comes from `BILL_SPEND_API_TOKEN` (Cursor Plugins → Configure, or a local env var). Admin-generated Spend token.
- Production base: `https://gateway.prod.bill.com/connect`
- Optional sandbox: `BILL_SPEND_BASE_URL=https://gateway.stage.bill.com/connect`
- **Never log, print, echo, or commit the token.** If an error might contain it, redact it.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_transactions` | Find card txns; match amount, date (`YYYY-MM-DD`), merchant substring |
| `get_transaction` | Fetch one txn by id/uuid |
| `attach_receipt` | 3-step JPG/PNG attach (rejects PDF) |
| `list_custom_field_values` | Category (or other field) values (`tvl_…`) |
| `set_transaction_custom_fields` | PUT Category; body uses `customFieldId` + `selectedValues` |

## Workflow 1 — Find a transaction

1. Call `list_transactions` with whatever the user gave you: `amount`, `date`, `merchant`.
2. If several match, show merchant, amount, date, `status`, `complete`, `receiptStatus`, and uuid; ask which one.
3. Use `get_transaction` when you need the full subset (`receipts`, `customFields`, `isLocked`).

## Workflow 2 — Attach a receipt (JPG/PNG only)

BILL accepts **JPG and PNG only**.

1. If the file is a **PDF**, do **not** call `attach_receipt`. Convert first:

   ```bash
   pdftoppm -jpeg -r 150 -singlefile receipt.pdf receipt
   ```

   That writes `receipt.jpg`. Then attach the image.

2. Call `attach_receipt` with `transactionId` and `filePath` to the `.jpg` / `.jpeg` / `.png`.
3. The server will:
   - `POST /v3/spend/transactions/receipt-upload-url`
   - `PUT` image bytes to the returned `url` with `Content-Type: image/jpeg` or `image/png`
   - `POST /v3/spend/transactions/{transactionId}/receipts` with `{ "url": "<same upload url>" }`

If you get a convert-first error, run `pdftoppm` (or equivalent) and retry with the image path.

## Workflow 3 — Set Category (required custom field)

1. Call `list_custom_field_values` with the org's Category `customFieldId` (prefer **customFieldId** in Oberon production; uuid also works as the path id).
2. Match the user's category text to a value `uuid` (`tvl_…`).
3. Call `set_transaction_custom_fields` with `transactionId`, `customFieldId`, and `selectedValues: ["tvl_…"]`.
4. The PUT body must look like:

   ```json
   {
     "customFields": [
       {
         "customFieldId": "<id>",
         "selectedValues": ["tvl_…"]
       }
     ]
   }
   ```

Do not send `customFieldUuid` in the body. Prefer `customFieldId`.

After a receipt **and** the required Category are set, `status` becomes `COMPLETE` / `complete: true`. Do not update custom fields when `isLocked` is true.

## Do not

Do not wrap or call:

- BILL AP/AR
- `/v3/login`
- pay, refund, or any money movement
- card create / card issuance
- budgets CRUD
- reimbursements
- webhooks

This plugin only lists/gets Spend transactions, attaches receipts, and sets custom field values.

## Data shape (subset)

- **Transaction:** `id`, `uuid`, `amount`, `merchant` / `merchantName`, `occurredTime` / `authorizedTime` / `updatedTime`, `status`, `complete`, `reviewRequired`, `receipts`, `customFields`
- **ReceiptUploadUrl:** `{ "url": "…" }`
- **CustomFieldValue:** `uuid` (`tvl_…`), `name` / `label` (from API `value`)
