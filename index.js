const express = require("express");
const { randomUUID } = require("node:crypto");
const { buildEmail } = require("./email-template");

const app = express();

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const EMAIL_WORKER_URL = process.env.EMAIL_WORKER_URL;
const EMAIL_WORKER_KEY = process.env.EMAIL_WORKER_KEY;
const ADMIN_EMAILS = process.env.ADMIN_EMAILS; // comma-separated
const EMAIL_FROM = process.env.EMAIL_FROM; // optional, must be SES-verified
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN; // optional, shared with Alertmanager

for (const [name, value] of Object.entries({ EMAIL_WORKER_URL, EMAIL_WORKER_KEY, ADMIN_EMAILS })) {
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
}

// Retries on network errors, 429 and 5xx, reusing the same job_id so the
// email is never queued twice. Kept short so Alertmanager doesn't time out.
async function sendEmail(email, jobId = randomUUID()) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${EMAIL_WORKER_URL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EMAIL_WORKER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ job_id: jobId, ...email }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (res && (res.status === 200 || res.status === 202)) return (await res.json()).job_id;
    if (res && res.status < 500 && res.status !== 429) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(`email rejected: ${res.status} ${body.error || ""}`);
      error.permanent = true;
      throw error;
    }
    if (attempt < 3) {
      const wait = Math.min(Number(res?.headers.get("retry-after")) || 2 ** attempt, 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error("email API unavailable");
}

app.post("/alerts", async (req, res) => {
  if (WEBHOOK_TOKEN && req.get("authorization") !== `Bearer ${WEBHOOK_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body;
  if (!Array.isArray(payload?.alerts) || payload.alerts.length === 0) {
    return res.status(400).json({ error: "No alerts in payload" });
  }

  console.log(`Received ${payload.alerts.length} alert(s) for group ${payload.groupKey}`);

  try {
    const jobId = await sendEmail({
      priority: "general",
      ...(EMAIL_FROM && { from: EMAIL_FROM }),
      to: ADMIN_EMAILS,
      ...buildEmail(payload),
      headers: { "X-Alertmanager-Status": String(payload.status || "") },
    });

    console.log(`Email queued: ${jobId}`);
    res.status(200).json({ success: true, job_id: jobId });
  } catch (error) {
    console.error("Email send failed:", error.message);
    // 4xx tells Alertmanager not to retry; 5xx makes it retry later
    res.status(error.permanent ? 400 : 502).json({ error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Alert webhook listening on port ${PORT}`);
});
