# Email Worker API — integration guide

Send emails by calling the Email Worker HTTP API directly over HTTPS. Do **not** use nodemailer or SMTP. The API queues each email and sends it through AWS SES with rate limiting, retries and bounce handling.

## Basics

- **Base URL:** `https://<EMAIL_WORKER_HOST>` (read from config, e.g. `EMAIL_WORKER_URL`)
- **Auth:** every request needs `Authorization: Bearer <EMAIL_WORKER_KEY>`. The key starts with `ew_` and is issued for your service by an operator in the admin dashboard (it is shown only once). Keep it server-side only; never put it in browser or mobile code.
- **Key rotation:** a service can hold several keys at once. To rotate, get a new key, deploy it, then ask for the old one to be revoked. A revoked key stops working within about 10 seconds.
- **Format:** JSON (`Content-Type: application/json`), UTF-8.
- **Asynchronous:** a `202` response means the email is **queued**, not delivered. Delivery happens a moment later.

## Send an email: `POST /emails`

```json
{
  "job_id": "3f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
  "priority": "transactional",
  "from": "Billing <billing@yourdomain.com>",
  "to": ["Ada <ada@example.com>", "bob@example.com"],
  "cc": ["accounts@example.com"],
  "bcc": ["audit@yourdomain.com"],
  "replyTo": "support@yourdomain.com",
  "subject": "Invoice #42",
  "text": "Your invoice is attached.",
  "html": "<p>Your invoice is attached.</p><img src=\"cid:logo\">",
  "headers": { "X-Campaign": "billing" },
  "attachments": [
    { "filename": "invoice-42.pdf", "content": "<base64>", "encoding": "base64", "contentType": "application/pdf" },
    { "filename": "logo.png", "content": "<base64>", "encoding": "base64", "contentType": "image/png", "cid": "logo" },
    { "filename": "notes.txt", "content": "plain text, no encoding needed" }
  ]
}
```

| Field | Required | Rules |
|---|---|---|
| `job_id` | no | **Must be a UUID v4** (e.g. `crypto.randomUUID()`). Omit it and the server generates one. |
| `priority` | no | `transactional` (OTP, password reset, receipts) or `general` (default). Transactional is sent first but is **not retried**: one failure is final. General is retried with backoff. |
| `from` | no | Defaults to the server's sender. Must be an address or domain verified in SES. |
| `to`, `cc`, `bcc`, `replyTo` | at least one recipient | An array of addresses, or one comma-separated string. `"Name <addr>"` is allowed; quote names containing commas. 50 recipients max (to+cc+bcc). |
| `subject` | **yes** | No line breaks. |
| `text`, `html` | **at least one** | Send both for best deliverability. |
| `headers` | no | Custom headers only. `From`, `To`, `Subject`, `Content-*` etc. are rejected. No line breaks in values. |
| `attachments` | no | `content` is base64 with `"encoding": "base64"` (use this for any binary file), or plain UTF-8 text with `encoding` omitted. Set `cid` to embed an image inline (`<img src="cid:...">`). `contentType` is guessed from the filename when omitted. |

The whole encoded email, attachments included, must stay under **10 MB**.

### Idempotency: always send a `job_id`

Generate the UUID **once per logical email**, store it with your record (e.g. on the order), and **reuse the same `job_id` when retrying the HTTP call**. A repeated `job_id` is never queued twice; the response says `"created": false`. That makes it safe to retry on timeouts and 5xx errors.

### Responses

| Status | Meaning | What to do |
|---|---|---|
| `202` `{"job_id": "...", "created": true}` | Queued | Save `job_id` |
| `200` `{"job_id": "...", "created": false}` | Already queued earlier (same `job_id`) | Treat as success |
| `400` `{"error": "..."}` | Invalid request (bad address, missing subject, `job_id` not a UUID v4, too large…) | Fix the request; don't retry as-is |
| `401` | Missing or invalid key | Check the key |
| `429` + `Retry-After` header | Your key's rate limit or daily quota is exceeded | Wait `Retry-After` seconds, then retry with the **same** `job_id` |
| `503` | Queue full | Retry later with backoff and the same `job_id` |
| `500` | Server error | Retry with backoff and the same `job_id` |

## Check status: `GET /emails/{job_id}`

Returns the live state, e.g. `{"job_id": "...", "status": "sent", "attempts": 1, "ses_message_id": "...", ...}`.

| `status` | Meaning |
|---|---|
| `queued`, `processing` | Waiting or being sent |
| `retry_wait` | A temporary failure; it will retry at `next_retry_at` (general priority only) |
| `sent` | Accepted by SES |
| `failed` | Gave up: see `failure_reason` and `last_error` |
| `suppressed` | Not sent: every recipient is on the bounce/complaint blacklist |

`suppressed_recipients` lists any blacklisted addresses that were dropped, even when the email was sent to the others. After an email finishes, its body and attachments are no longer returned here (`content_archived: true`); use `/logs` for the full copy. Live status is kept for about 24 hours.

## History: `GET /logs`

The permanent record, covering only emails sent with your key:

- `GET /logs/{job_id}`: full email, attachment list, and event history. `delivery_status` shows `delivered`, `bounced` or `complained` once SES reports it.
- `GET /logs/{job_id}/attachments/{n}`: download attachment `n` (0-based).
- `GET /logs?status=failed&delivery_status=bounced&recipient=ada@example.com&since=2026-10-01T00:00:00Z&until=...&limit=50&offset=0`: search, newest first, without bodies.

## Example (Node 18+, no libraries)

```js
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function sendEmail(email, jobId = randomUUID()) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${process.env.EMAIL_WORKER_URL}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.EMAIL_WORKER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ job_id: jobId, ...email }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null); // network error → retry

    if (res && (res.status === 200 || res.status === 202)) return (await res.json()).job_id;
    if (res && res.status < 500 && res.status !== 429) {
      throw new Error(`email rejected: ${res.status} ${(await res.json()).error}`);
    }
    const wait = Number(res?.headers.get('retry-after')) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait * 1000)); // same jobId on every retry
  }
  throw new Error('email API unavailable');
}

await sendEmail({
  priority: 'transactional',
  to: 'ada@example.com',
  subject: 'Your invoice',
  html: '<p>Invoice attached.</p>',
  text: 'Invoice attached.',
  attachments: [{
    filename: 'invoice.pdf',
    contentType: 'application/pdf',
    encoding: 'base64',
    content: (await readFile('invoice.pdf')).toString('base64'),
  }],
});
```

Equivalent `curl`:

```bash
curl -X POST "$EMAIL_WORKER_URL/emails" \
  -H "Authorization: Bearer $EMAIL_WORKER_KEY" -H "Content-Type: application/json" \
  -d '{"job_id":"'"$(uuidgen | tr A-Z a-z)"'","to":"ada@example.com","subject":"Hi","text":"Hello"}'
```

## Rules for the integrating code

1. Call the API only from the backend; the key is a secret.
2. Create one UUID v4 `job_id` per email, persist it, and reuse it on every retry.
3. Retry only on network errors, `429`, `503` and `5xx`, with backoff and honouring `Retry-After`. Never retry a `400` unchanged.
4. Base64-encode binary attachments, and set `encoding: "base64"`.
5. Use `priority: "transactional"` only for time-critical single-recipient mail; use `general` for everything else.
6. Treat `202` as "queued". If you need delivery confirmation, check `GET /emails/{job_id}` or `GET /logs/{job_id}` later.
