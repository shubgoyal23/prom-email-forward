// Turns an Alertmanager webhook payload into a short, readable email.
// Per-alert wording lives in TEMPLATES; numbers come from the `value` and
// `threshold` annotations set on the Prometheus rules.

const TIMEZONE = process.env.ALERT_TIMEZONE || "UTC";

const COLORS = { critical: "#d93025", warning: "#e37400", info: "#1a73e8", resolved: "#188038" };
const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const unique = (list) => [...new Set(list)];

const host = (a) => (a.labels.instance || "unknown host").replace(/:\d+$/, "");
const pct = (v) => (v === undefined || v === "" || isNaN(v) ? null : `${Number(v).toFixed(1)}%`);

const fmtTime = (iso) =>
  new Date(iso).toLocaleString("en-GB", {
    timeZone: TIMEZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

const fmtDuration = (ms) => {
  const total = Math.max(0, Math.round(ms / 60000));
  if (total < 1) return "under a minute";
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ");
};

const duration = (a) =>
  fmtDuration((a.status === "resolved" ? new Date(a.endsAt) : new Date()) - new Date(a.startsAt));

const TEMPLATES = {
  InstanceDown: {
    title: "Server unreachable",
    resolvedTitle: "Server reachable again",
    resourceLabel: "Server",
    resource: (a) => `${host(a)} (${a.labels.job || "target"})`,
    headline: (a) => `${host(a)} is unreachable`,
    resolvedHeadline: (a) => `${host(a)} is reachable again`,
    explain:
      "Prometheus can't scrape this target. The server may be down or overloaded, the exporter may have stopped, or the network is blocking it. While it's down, no other alerts can fire for it.",
    checks: (alerts) => [
      { text: "Check the host responds", cmd: `ping ${host(alerts[0])}` },
      { text: "If you can SSH in, check the exporter", cmd: "systemctl status node_exporter  # or: docker ps" },
      { text: "If SSH fails, open your VPS provider's console and check the server is running" },
    ],
  },

  HighCPUUsage: {
    title: "High CPU usage",
    resolvedTitle: "CPU usage back to normal",
    resourceLabel: "Server",
    resource: host,
    headline: (a) => `CPU at ${pct(a.annotations.value) || "high load"} on ${host(a)}`,
    resolvedHeadline: (a) => `CPU usage back to normal on ${host(a)}`,
    explain:
      "The server has been busy for several minutes. Requests may be slow or time out, and background jobs may fall behind.",
    checks: () => [
      { text: "Find the busiest processes", cmd: "top -o %CPU" },
      { text: "See which containers use the most CPU", cmd: "docker stats --no-stream" },
      { text: "Look for traffic spikes, runaway jobs or a container stuck in a restart loop" },
    ],
  },

  HighMemoryUsage: {
    title: "High memory usage",
    resolvedTitle: "Memory usage back to normal",
    resourceLabel: "Server",
    resource: host,
    headline: (a) => `Memory at ${pct(a.annotations.value) || "high usage"} on ${host(a)}`,
    resolvedHeadline: (a) => `Memory usage back to normal on ${host(a)}`,
    explain:
      "The server is running low on memory. If it runs out, Linux starts killing processes (OOM killer) and services can crash or restart.",
    checks: () => [
      { text: "Check memory and swap", cmd: "free -h" },
      { text: "Find the biggest processes", cmd: "ps aux --sort=-%mem | head" },
      { text: "See which containers use the most memory", cmd: "docker stats --no-stream" },
      { text: "Check whether anything was already killed", cmd: "dmesg -T | grep -i oom" },
    ],
  },

  DiskAlmostFull: {
    title: "Disk almost full",
    resolvedTitle: "Disk space recovered",
    resourceLabel: "Disk",
    resource: (a) => a.labels.mountpoint || "/",
    headline: (a) => `Disk ${pct(a.annotations.value) || "almost"} full on ${host(a)} (${a.labels.mountpoint || "/"})`,
    resolvedHeadline: (a) => `Disk space recovered on ${host(a)} (${a.labels.mountpoint || "/"})`,
    explain:
      "When a disk fills up, databases, logs and Docker can no longer write, and services may crash or corrupt data.",
    checks: (alerts) => [
      { text: "Find what's using the space", cmd: `sudo du -xh ${alerts[0].labels.mountpoint || "/"} --max-depth=1 | sort -h | tail` },
      { text: "Check Docker images, volumes and build cache", cmd: "docker system df" },
      { text: "Free space safely", cmd: "docker image prune -a && sudo journalctl --vacuum-size=500M" },
    ],
  },

  DockerContainerDown: {
    title: "Docker container down",
    resolvedTitle: "Docker container running again",
    resourceLabel: "Container",
    resource: (a) => a.labels.name,
    headline: (a) => `Container ${a.labels.name} is down on ${host(a)}`,
    resolvedHeadline: (a) => `Container ${a.labels.name} is running again on ${host(a)}`,
    explain:
      "The container stopped running: it crashed, was killed (possibly out of memory) or was removed. Whatever it serves is probably unavailable.",
    checks: (alerts) => {
      const names = unique(alerts.map((a) => a.labels.name));
      const first = names[0];
      return [
        { text: "Check its state and exit code", cmd: `docker ps -a ${names.map((n) => `--filter name=${n}`).join(" ")}` },
        { text: "Read the last logs", cmd: `docker logs --tail 100 ${first}` },
        { text: "See whether it was killed for memory", cmd: `docker inspect ${first} --format '{{.State.ExitCode}} OOMKilled={{.State.OOMKilled}}'` },
      ];
    },
  },
};

// Used for any alert without its own template
function genericTemplate(alertname) {
  const title = alertname.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return {
    title,
    resolvedTitle: `${title} resolved`,
    resourceLabel: "Server",
    resource: host,
    headline: (a) => a.annotations.summary || `${title} on ${host(a)}`,
    resolvedHeadline: (a) => `Resolved: ${a.annotations.summary || `${title} on ${host(a)}`}`,
    explain: null,
    checks: () => [],
  };
}

const templateFor = (alertname) => TEMPLATES[alertname] || genericTemplate(alertname || "Alert");

const worstSeverity = (alerts) =>
  alerts
    .map((a) => a.labels.severity || "warning")
    .sort((x, y) => (SEVERITY_RANK[y] || 0) - (SEVERITY_RANK[x] || 0))[0];

const listResources = (alerts, t) => {
  const items = unique(alerts.map(t.resource));
  return items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} +${items.length - 3} more`;
};

function buildHeadline(alerts, firing) {
  const names = unique(alerts.map((a) => a.labels.alertname));
  if (names.length > 1) {
    const titles = names.map((n) => templateFor(n).title).join(", ");
    return `${alerts.length} ${firing ? "alerts" : "alerts resolved"} on ${unique(alerts.map(host)).join(", ")}: ${titles}`;
  }
  const t = templateFor(names[0]);
  if (alerts.length === 1) {
    const a = alerts[0];
    if (firing) return t.headline(a);
    const was = pct(a.annotations.value);
    return `${t.resolvedHeadline(a)} after ${duration(a)}${was ? ` (was ${was})` : ""}`;
  }
  return `${firing ? t.title : t.resolvedTitle}: ${alerts.length} affected (${listResources(alerts, t)})`;
}

function silenceUrl(externalURL, labels) {
  const matchers = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(", ");
  return `${externalURL}/#/silences/new?filter=${encodeURIComponent(`{${matchers}}`)}`;
}

// One section per alert type: explanation, affected resources, what to check
function renderSection(alerts, firing, payload, showHeading) {
  const t = templateFor(alerts[0].labels.alertname);
  const showValue = firing && alerts.some((a) => pct(a.annotations.value));
  const muted = "color:#6b7280";
  const cell = "padding:8px 12px 8px 0;border-bottom:1px solid #eef0f2;vertical-align:top";
  const th = `padding:0 12px 6px 0;border-bottom:1px solid #e5e7eb;font-weight:500;font-size:12px;${muted}`;

  const rows = alerts
    .map((a) => {
      const value = pct(a.annotations.value);
      const limit = a.annotations.threshold ? `limit ${a.annotations.threshold}%` : "";
      const time = firing
        ? `since ${esc(fmtTime(a.startsAt))}<br><span style="${muted}">for ${esc(duration(a))}</span>`
        : `lasted ${esc(duration(a))}<br><span style="${muted}">ended ${esc(fmtTime(a.endsAt))}</span>`;
      const links = [
        a.generatorURL && `<a href="${esc(a.generatorURL)}" style="color:#1a73e8">Graph</a>`,
        firing && payload.externalURL && `<a href="${esc(silenceUrl(payload.externalURL, a.labels))}" style="color:#1a73e8">Silence</a>`,
      ]
        .filter(Boolean)
        .join(" &middot; ");
      return `<tr>
<td style="${cell}"><strong>${esc(t.resource(a))}</strong>${
        t.resourceLabel !== "Server" ? `<br><span style="${muted}">${esc(host(a))}</span>` : ""
      }</td>
${showValue ? `<td style="${cell}">${value ? `<strong>${esc(value)}</strong><br><span style="${muted}">${esc(limit)}</span>` : "-"}</td>` : ""}
<td style="${cell}">${time}</td>
<td style="${cell};text-align:right;white-space:nowrap">${links}</td>
</tr>`;
    })
    .join("\n");

  const checks = firing ? t.checks(alerts) : [];
  const checksHtml = checks.length
    ? `<p style="margin:20px 0 6px;font-size:13px;font-weight:600">What to check</p>
<ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.6">
${checks
  .map(
    (c) =>
      `<li>${esc(c.text)}${
        c.cmd
          ? `<br><code style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:#f3f4f6;padding:2px 6px;border-radius:4px">${esc(c.cmd)}</code>`
          : ""
      }</li>`
  )
  .join("\n")}
</ol>`
    : "";

  return `${showHeading ? `<p style="margin:24px 0 4px;font-size:15px;font-weight:600">${esc(firing ? t.title : t.resolvedTitle)}</p>` : ""}
${firing && t.explain ? `<p style="margin:12px 0 16px;font-size:14px;line-height:1.5;color:#374151">${esc(t.explain)}</p>` : ""}
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-top:12px">
<tr><th align="left" style="${th}">${esc(t.resourceLabel)}</th>${showValue ? `<th align="left" style="${th}">Value</th>` : ""}<th align="left" style="${th}">${firing ? "Started" : "Duration"}</th><th style="${th}"></th></tr>
${rows}
</table>
${checksHtml}`;
}

function renderText(groups, payload) {
  const lines = [];
  for (const { alerts, firing } of groups) {
    const t = templateFor(alerts[0].labels.alertname);
    lines.push(`${firing ? "FIRING" : "RESOLVED"}: ${firing ? t.title : t.resolvedTitle}`);
    if (firing && t.explain) lines.push(t.explain);
    lines.push("");
    for (const a of alerts) {
      const value = pct(a.annotations.value);
      lines.push(
        `- ${t.resource(a)}${t.resourceLabel !== "Server" ? ` on ${host(a)}` : ""}` +
          (value ? `: ${value}${a.annotations.threshold ? ` (limit ${a.annotations.threshold}%)` : ""}` : "") +
          (firing ? `, since ${fmtTime(a.startsAt)} (${duration(a)})` : `, lasted ${duration(a)}`)
      );
      if (a.generatorURL) lines.push(`  Graph: ${a.generatorURL}`);
    }
    const checks = firing ? t.checks(alerts) : [];
    if (checks.length) {
      lines.push("", "What to check:");
      checks.forEach((c, i) => lines.push(`${i + 1}. ${c.text}${c.cmd ? `\n   $ ${c.cmd}` : ""}`));
    }
    lines.push("");
  }
  if (payload.externalURL) lines.push(`All alerts: ${payload.externalURL}`);
  return lines.join("\n");
}

function buildEmail(payload) {
  const firing = payload.alerts.filter((a) => a.status === "firing");
  const resolved = payload.alerts.filter((a) => a.status !== "firing");
  const isFiring = firing.length > 0;
  const primary = isFiring ? firing : resolved;

  const severity = isFiring ? worstSeverity(firing) : "resolved";
  const color = COLORS[severity] || COLORS.warning;
  const headline = buildHeadline(primary, isFiring);
  const subject = `[${cap(severity)}] ${headline}`.replace(/[\r\n]+/g, " ").slice(0, 200);

  // Firing sections first, then anything that resolved in the same batch
  const groups = [];
  for (const [list, isF] of [[firing, true], [resolved, false]]) {
    for (const name of unique(list.map((a) => a.labels.alertname))) {
      groups.push({ alerts: list.filter((a) => a.labels.alertname === name), firing: isF });
    }
  }

  const statusLine = isFiring
    ? `${cap(severity)} &middot; ${firing.length} firing${resolved.length ? `, ${resolved.length} resolved` : ""}`
    : "Resolved";

  const html = `<div style="background:#f6f7f9;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2328">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
<div style="height:4px;background:${color}"></div>
<div style="padding:24px">
<div style="font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${color}">${statusLine}</div>
<h1 style="margin:6px 0 0;font-size:20px;line-height:1.3;font-weight:600">${esc(headline)}</h1>
${groups.map((g) => renderSection(g.alerts, g.firing, payload, groups.length > 1)).join("\n")}
</div>
<div style="padding:14px 24px;border-top:1px solid #eef0f2;font-size:12px;color:#6b7280">
${payload.externalURL ? `<a href="${esc(payload.externalURL)}" style="color:#6b7280">Open Alertmanager</a> &middot; ` : ""}Times in ${esc(TIMEZONE)}
</div>
</div>
</div>`;

  return { subject, text: renderText(groups, payload), html };
}

module.exports = { buildEmail };
