const express = require("express");
const webpush = require("web-push");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 8000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "lecture-reminder.db");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_ATTEMPTS = 20;
const RETRY_WINDOW_MS = 2 * 60 * 60 * 1000; // keep retrying until eventAt + 2 hours

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    subscription TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedule_jobs (
    id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    scheduledAt TEXT NOT NULL,
    eventAt TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    notifiedAt TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    lastError TEXT,
    failed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, endpoint),
    FOREIGN KEY (endpoint) REFERENCES subscriptions(endpoint) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Remove the old global reminder table if it still exists. Reminder lists are
// private browser localStorage data and must never be exposed by the server.
try {
  db.exec("DROP TABLE IF EXISTS reminders");
} catch (error) {
  console.error("Could not remove legacy reminders table:", error.message);
}

// Upgrade schedule_jobs created by an older private version.
const columns = db.prepare("PRAGMA table_info(schedule_jobs)").all().map(row => row.name);
if (!columns.includes("attempts")) db.exec("ALTER TABLE schedule_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
if (!columns.includes("lastError")) db.exec("ALTER TABLE schedule_jobs ADD COLUMN lastError TEXT");
if (!columns.includes("failed")) db.exec("ALTER TABLE schedule_jobs ADD COLUMN failed INTEGER NOT NULL DEFAULT 0");

function setting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function saveSetting(key, value) {
  db.prepare(`
    INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value);
}

let publicKey = process.env.VAPID_PUBLIC_KEY || setting("vapidPublicKey");
let privateKey = process.env.VAPID_PRIVATE_KEY || setting("vapidPrivateKey");

if (!publicKey || !privateKey) {
  const generated = webpush.generateVAPIDKeys();
  publicKey = generated.publicKey;
  privateKey = generated.privateKey;
  saveSetting("vapidPublicKey", publicKey);
  saveSetting("vapidPrivateKey", privateKey);
  console.log("Generated VAPID keys and saved them in the database.");
}

webpush.setVapidDetails(
  "mailto:" + (process.env.VAPID_EMAIL || "lecture-reminder@example.com").replace(/^mailto:/i, ""),
  publicKey,
  privateKey
);

app.use(express.json({ limit: "100kb" }));
// Only the public directory is exposed. DATA_DIR is never served over HTTP.
app.use(express.static(PUBLIC_DIR, { index: "index.html" }));

function parseIsoDate(value, fieldName) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`Invalid ${fieldName}.`);
  return date;
}

function assertFutureSchedule(scheduledAt, eventAt) {
  const scheduled = parseIsoDate(scheduledAt, "scheduled time");
  const event = parseIsoDate(eventAt, "event time");
  if (event.getTime() <= Date.now()) throw new Error("The lecture date/time must be in the future.");
  if (scheduled.getTime() > event.getTime()) throw new Error("Scheduled time cannot be after event time.");
  return { scheduled, event };
}

function isSubscriptionShape(subscription) {
  return Boolean(
    subscription &&
    typeof subscription.endpoint === "string" &&
    subscription.endpoint.length > 0 &&
    subscription.keys &&
    typeof subscription.keys.p256dh === "string" &&
    typeof subscription.keys.auth === "string"
  );
}

function sameSubscription(a, b) {
  return Boolean(
    isSubscriptionShape(a) && isSubscriptionShape(b) &&
    a.endpoint === b.endpoint &&
    a.keys.p256dh === b.keys.p256dh &&
    a.keys.auth === b.keys.auth
  );
}

function getStoredSubscription(endpoint) {
  const row = db.prepare("SELECT subscription FROM subscriptions WHERE endpoint = ?").get(endpoint);
  if (!row) return null;
  try {
    return JSON.parse(row.subscription);
  } catch {
    db.prepare("DELETE FROM subscriptions WHERE endpoint = ?").run(endpoint);
    return null;
  }
}

function authorizeSubscription(subscription) {
  if (!isSubscriptionShape(subscription)) return false;
  const stored = getStoredSubscription(subscription.endpoint);
  return sameSubscription(stored, subscription);
}

function subscriptionError(res) {
  // Deliberately generic: don't reveal whether a different endpoint exists.
  return res.status(403).json({ error: "Push subscription is not authorized for this request." });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "Lecture Reminder", time: new Date().toISOString() });
});

app.get("/api/config", (_req, res) => res.json({ publicKey }));

// There is intentionally NO GET /api/reminders or public job-list endpoint.

app.post("/api/subscribe", (req, res) => {
  try {
    const subscription = req.body;
    if (!isSubscriptionShape(subscription)) return res.status(400).json({ error: "Invalid push subscription." });

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO subscriptions(endpoint,subscription,createdAt,updatedAt)
      VALUES(?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET
        subscription=excluded.subscription,
        updatedAt=excluded.updatedAt
    `).run(subscription.endpoint, JSON.stringify(subscription), now, now);

    res.status(201).json({ saved: true });
  } catch (error) {
    console.error("Save subscription failed:", error.message);
    res.status(500).json({ error: "Could not save push subscription." });
  }
});

app.post("/api/schedules", (req, res) => {
  try {
    const { subscription, id, title, note = "", scheduledAt, eventAt } = req.body || {};

    if (!isSubscriptionShape(subscription) || !id || !title || !scheduledAt || !eventAt) {
      return res.status(400).json({ error: "Full subscription, id, title, scheduledAt and eventAt are required." });
    }
    if (!authorizeSubscription(subscription)) return subscriptionError(res);
    if (String(id).length > 200 || String(title).trim().length > 200) {
      return res.status(400).json({ error: "Reminder data is too long." });
    }

    const { scheduled, event } = assertFutureSchedule(scheduledAt, eventAt);
    const endpoint = subscription.endpoint;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO schedule_jobs
      (id,endpoint,title,body,scheduledAt,eventAt,notified,createdAt,attempts,lastError,failed)
      VALUES(?,?,?,?,?,?,0,?,0,NULL,0)
      ON CONFLICT(id,endpoint) DO UPDATE SET
        title=excluded.title,
        body=excluded.body,
        scheduledAt=excluded.scheduledAt,
        eventAt=excluded.eventAt,
        notified=0,
        notifiedAt=NULL,
        attempts=0,
        lastError=NULL,
        failed=0
    `).run(
      String(id), endpoint, String(title).trim().slice(0, 200), String(note || "").trim().slice(0, 500),
      scheduled.toISOString(), event.toISOString(), now
    );

    res.status(201).json({ scheduled: true });
  } catch (error) {
    console.error("Create schedule failed:", error.message);
    res.status(400).json({ error: error.message || "Could not schedule reminder." });
  }
});

app.post("/api/schedules/sync", (req, res) => {
  try {
    const { subscription, reminderIds = [] } = req.body || {};
    if (!isSubscriptionShape(subscription) || !Array.isArray(reminderIds)) {
      return res.status(400).json({ error: "Full subscription and reminderIds are required." });
    }
    if (!authorizeSubscription(subscription)) return subscriptionError(res);

    const ids = new Set(reminderIds.map(id => String(id)).filter(Boolean));
    const jobs = db.prepare("SELECT id FROM schedule_jobs WHERE endpoint = ? AND notified = 0 AND failed = 0").all(subscription.endpoint);
    const remove = db.prepare("DELETE FROM schedule_jobs WHERE endpoint = ? AND id = ?");
    const transaction = db.transaction(() => {
      for (const job of jobs) {
        if (!ids.has(String(job.id))) remove.run(subscription.endpoint, job.id);
      }
    });
    transaction();

    res.json({ synced: true, removed: jobs.filter(job => !ids.has(String(job.id))).length });
  } catch (error) {
    console.error("Schedule sync failed:", error.message);
    res.status(400).json({ error: "Could not sync private schedules." });
  }
});

app.delete("/api/schedules/:id", (req, res) => {
  const subscription = req.body?.subscription;
  const id = String(req.params.id || "");
  if (!isSubscriptionShape(subscription)) return res.status(400).json({ error: "Full push subscription is required." });
  if (!authorizeSubscription(subscription)) return subscriptionError(res);

  // Endpoint is taken from the authenticated subscription, never from a client string.
  db.prepare("DELETE FROM schedule_jobs WHERE id = ? AND endpoint = ?").run(id, subscription.endpoint);
  res.status(204).end();
});

async function sendToSubscription(endpoint, payload) {
  const subscription = getStoredSubscription(endpoint);
  if (!subscription) return { delivered: false, permanent: true, error: "Subscription unavailable." };

  try {
    await webpush.sendNotification(subscription, payload);
    return { delivered: true, permanent: false, error: null };
  } catch (error) {
    const permanent = error.statusCode === 404 || error.statusCode === 410;
    if (permanent) {
      db.prepare("DELETE FROM subscriptions WHERE endpoint = ?").run(endpoint);
    }
    return { delivered: false, permanent, error: `${error.statusCode || "push"}: ${error.message || "delivery failed"}`.slice(0, 500) };
  }
}

app.post("/api/test", async (req, res) => {
  try {
    const subscription = req.body?.subscription;
    if (!isSubscriptionShape(subscription)) return res.status(400).json({ error: "Full push subscription is required." });
    if (!authorizeSubscription(subscription)) return subscriptionError(res);

    const result = await sendToSubscription(subscription.endpoint, JSON.stringify({
      title: "Lecture Reminder",
      body: "Test notification: your phone push notifications are working.",
      id: "test",
      url: "/"
    }));

    if (!result.delivered) return res.status(result.permanent ? 410 : 503).json({ delivered: false, error: "Test notification could not be delivered." });
    res.json({ delivered: true });
  } catch (error) {
    console.error("Test push failed:", error.message);
    res.status(500).json({ delivered: false, error: "Test notification failed." });
  }
});

let checking = false;

async function checkSchedules() {
  if (checking) return;
  checking = true;

  try {
    const now = Date.now();
    const due = db.prepare(`
      SELECT * FROM schedule_jobs
      WHERE notified = 0 AND failed = 0
        AND scheduledAt <= ?
        AND eventAt >= ?
        AND attempts < ?
      ORDER BY scheduledAt ASC
      LIMIT 100
    `).all(new Date(now).toISOString(), new Date(now - RETRY_WINDOW_MS).toISOString(), MAX_ATTEMPTS);

    for (const row of due) {
      const payload = JSON.stringify({
        title: "Lecture Reminder 📚",
        body: `${row.title}${row.body ? ` — ${row.body}` : ""}`,
        id: row.id,
        url: "/"
      });

      const result = await sendToSubscription(row.endpoint, payload);
      if (result.delivered) {
        db.prepare(`
          UPDATE schedule_jobs SET notified = 1, notifiedAt = ?, lastError = NULL
          WHERE id = ? AND endpoint = ?
        `).run(new Date().toISOString(), row.id, row.endpoint);
      } else {
        const attempts = row.attempts + 1;
        const expired = now > new Date(row.eventAt).getTime() + RETRY_WINDOW_MS;
        const failed = result.permanent || attempts >= MAX_ATTEMPTS || expired;
        db.prepare(`
          UPDATE schedule_jobs SET attempts = ?, lastError = ?, failed = ?
          WHERE id = ? AND endpoint = ?
        `).run(attempts, result.error, failed ? 1 : 0, row.id, row.endpoint);
      }
    }

    // Jobs past the retry window or exhausted are permanently failed and removed.
    db.prepare(`
      DELETE FROM schedule_jobs
      WHERE failed = 1
         OR eventAt < ?
         OR attempts >= ?
    `).run(new Date(now - RETRY_WINDOW_MS).toISOString(), MAX_ATTEMPTS);
  } catch (error) {
    console.error("Scheduler error:", error.message);
  } finally {
    checking = false;
  }
}

// A 30-second poll keeps due jobs durable across temporary server/network errors.
setInterval(checkSchedules, 30 * 1000);
checkSchedules();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lecture Reminder running on port ${PORT}`);
});
