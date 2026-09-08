const REMINDER_KEY = "lectureReminders";
let vapidPublicKey = "";

document.addEventListener("DOMContentLoaded", async () => {
  setToday();
  await registerServiceWorker();
  await loadConfig();
  loadEvents();
  updatePushStatus();
});

function setToday() {
  const input = document.getElementById("date");
  if (!input) return;
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now).map(part => [part.type, part.value]));
  input.value = `${parts.year}-${parts.month}-${parts.day}`;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    setPushStatus("Service workers are not supported by this browser.");
    return null;
  }
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (error) {
    console.error("Service worker registration failed:", error.message);
    setPushStatus("Service worker registration failed.");
    return null;
  }
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load push configuration.");
    vapidPublicKey = data.publicKey || "";
  } catch (error) {
    console.error("Config error:", error.message);
    setPushStatus("Push setup is unavailable.");
  }
}

function readLocalReminders() {
  try {
    const raw = localStorage.getItem(REMINDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Reminder storage is not an array.");
    return parsed.filter(item => item && typeof item === "object");
  } catch (error) {
    console.warn("Corrupt local reminder storage; resetting it.");
    localStorage.setItem(REMINDER_KEY, "[]");
    return [];
  }
}

function writeLocalReminders(reminders) {
  localStorage.setItem(REMINDER_KEY, JSON.stringify(reminders));
}

function loadEvents() {
  const future = readLocalReminders().filter(reminder => {
    const eventAt = getEventDate(reminder.date, reminder.time);
    return eventAt && eventAt.getTime() > Date.now();
  });
  writeLocalReminders(future);
  renderEvents(future);
}

function normalizeTime(time) {
  const value = String(time || "").trim();
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${match[1]}:${match[2]}`;
}

function getEventDate(date, time) {
  date = String(date || "");
  time = normalizeTime(time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !time) return null;

  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const value = new Date(`${date}T${time}:00+01:00`);
  if (Number.isNaN(value.getTime())) return null;

  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(value).map(part => [part.type, part.value]));

  if (Number(parts.year) !== year || Number(parts.month) !== month || Number(parts.day) !== day ||
      Number(parts.hour) !== hour || Number(parts.minute) !== minute) return null;
  return value;
}

function createReminderId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function validateReminder(title, date, time, lead) {
  if (!title || !date || !time) return "Please enter a title, date and time.";
  if (!normalizeTime(time)) return "Please enter a valid time (HH:MM or HH:MM:SS).";
  const eventAt = getEventDate(date, time);
  if (!eventAt) return "Please enter a valid date and time.";
  const minutes = Number(lead);
  if (!Number.isFinite(minutes) || minutes < 0) return "Please select a valid reminder time.";
  if (eventAt.getTime() <= Date.now()) return "The lecture date/time must be in the future.";
  return null;
}

async function addEvent() {
  const title = document.getElementById("title").value.trim();
  const date = document.getElementById("date").value;
  const rawTime = document.getElementById("time").value;
  const time = normalizeTime(rawTime);
  const note = document.getElementById("note").value.trim();
  const lead = Number(document.getElementById("lead").value);

  const validationError = validateReminder(title, date, rawTime, lead);
  if (validationError) return setStatus(validationError);

  const eventAt = getEventDate(date, time);
  const reminder = {
    id: createReminderId(), title: title.slice(0, 200), date, time,
    note: note.slice(0, 500), lead, eventAt: eventAt.toISOString(),
    createdAt: new Date().toISOString(),
    scheduledAt: new Date(eventAt.getTime() - lead * 60000).toISOString()
  };

  const reminders = readLocalReminders();
  reminders.push(reminder);
  writeLocalReminders(reminders);
  renderEvents(reminders);
  document.getElementById("title").value = "";
  document.getElementById("note").value = "";
  setStatus("Reminder saved on this browser.");

  try {
    const subscription = await getActiveSubscription();
    if (subscription) {
      await scheduleReminder(reminder, subscription);
      setStatus("Reminder saved and phone notification scheduled.");
    } else {
      setStatus("Reminder saved on this browser. Enable Phone Notifications to receive push alerts.");
    }
  } catch (error) {
    console.error("Schedule error:", error.message);
    setStatus("Reminder saved on this browser, but push scheduling failed. You can enable notifications again to retry.");
  }
}

async function deleteEvent(id) {
  if (!confirm("Delete this reminder?")) return;
  const reminders = readLocalReminders();
  writeLocalReminders(reminders.filter(item => String(item.id) !== String(id)));
  renderEvents(readLocalReminders());

  try {
    const subscription = await getActiveSubscription();
    if (subscription) await deleteSchedule(id, subscription);
  } catch (error) {
    console.warn("Server schedule cleanup failed:", error.message);
  }
  setStatus("Reminder deleted from this browser.");
}

async function getActiveSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function enableNotifications() {
  try {
    if (!("Notification" in window)) throw new Error("This browser does not support notifications.");
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support web push.");
    if (!window.isSecureContext) throw new Error("Notifications require HTTPS.");
    if (!vapidPublicKey) await loadConfig();
    if (!vapidPublicKey) throw new Error("Push configuration is unavailable.");

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus(permission === "denied" ? "Notifications are blocked. Allow them in Chrome site settings." : "Notification permission was not granted.");
      return;
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }

    await saveSubscription(subscription);
    await syncLocalSchedules(subscription);
    setPushStatus("🔔 Phone notifications are enabled for this browser.");
    setStatus("Your private reminders have been synchronized with this phone.");
  } catch (error) {
    console.error("Notification setup failed:", error.message);
    setPushStatus("Notification setup failed: " + error.message);
  }
}

function subscriptionJSON(subscription) {
  return typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;
}

async function saveSubscription(subscription) {
  const fullSubscription = subscriptionJSON(subscription);
  const response = await fetch("/api/subscribe", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fullSubscription)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not save phone subscription.");
}

async function scheduleReminder(reminder, subscription) {
  const fullSubscription = subscriptionJSON(subscription);
  const response = await fetch("/api/schedules", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: fullSubscription, id: reminder.id, title: reminder.title,
      note: reminder.note, scheduledAt: reminder.scheduledAt, eventAt: reminder.eventAt
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not schedule push notification.");
}

async function deleteSchedule(id, subscription) {
  const fullSubscription = subscriptionJSON(subscription);
  const response = await fetch("/api/schedules/" + encodeURIComponent(id), {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: fullSubscription })
  });
  if (!response.ok && response.status !== 404) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Could not delete push schedule.");
  }
}

async function syncLocalSchedules(subscription) {
  const reminders = readLocalReminders();
  const fullSubscription = subscriptionJSON(subscription);

  // First upsert every current local reminder. This keeps this browser's jobs durable.
  for (const reminder of reminders) {
    const eventAt = getEventDate(reminder.date, reminder.time);
    if (!eventAt || eventAt.getTime() <= Date.now()) continue;
    const normalized = {
      ...reminder,
      time: normalizeTime(reminder.time),
      eventAt: eventAt.toISOString(),
      scheduledAt: new Date(eventAt.getTime() - Number(reminder.lead || 0) * 60000).toISOString()
    };
    await scheduleReminder(normalized, fullSubscription);
  }

  // Then remove stale jobs belonging to this subscription only.
  const response = await fetch("/api/schedules/sync", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: fullSubscription,
      reminderIds: reminders.map(reminder => String(reminder.id))
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not synchronize private schedules.");
}

async function sendTestNotification() {
  try {
    const subscription = await getActiveSubscription();
    if (!subscription) {
      setPushStatus("Enable Phone Notifications first.");
      return;
    }
    await saveSubscription(subscription);
    const response = await fetch("/api/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscriptionJSON(subscription) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Test notification failed.");
    setPushStatus("🧪 Test notification sent only to this phone/browser.");
  } catch (error) {
    setPushStatus("Test failed: " + error.message);
  }
}

function renderEvents(events) {
  const container = document.getElementById("events");
  if (!events.length) {
    container.innerHTML = '<p class="empty">No upcoming lectures or events.</p>';
    return;
  }

  const sorted = [...events].sort((a, b) => new Date(a.eventAt).getTime() - new Date(b.eventAt).getTime());
  container.innerHTML = sorted.map(event => {
    const date = new Date(event.eventAt);
    return `
      <div class="event" data-id="${escapeHtml(event.id)}">
        <strong>${escapeHtml(event.title)}</strong>
        <div class="meta">${escapeHtml(date.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "full", timeStyle: "short" }))}</div>
        ${event.note ? `<div class="meta">${escapeHtml(event.note)}</div>` : ""}
        <div class="meta">Reminder: ${escapeHtml(leadText(event.lead))}</div>
        <div class="actions"><button class="secondary delete-reminder" type="button" data-id="${escapeHtml(event.id)}">Delete</button></div>
      </div>`;
  }).join("");

  container.querySelectorAll(".delete-reminder").forEach(button => {
    button.addEventListener("click", () => deleteEvent(button.dataset.id));
  });
}

function leadText(minutes) {
  minutes = Number(minutes);
  if (minutes === 0) return "at event time";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} before`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day(s) before`;
  return `${minutes / 60} hour(s) before`;
}

function updatePushStatus() {
  if (!("Notification" in window)) return setPushStatus("Notifications are not supported.");
  if (Notification.permission === "granted") setPushStatus("🔔 Notifications are allowed.");
  else if (Notification.permission === "denied") setPushStatus("🔕 Notifications are blocked in browser settings.");
  else setPushStatus("🔔 Notifications are not enabled yet.");
}

function setStatus(message) {
  const element = document.getElementById("status");
  if (element) element.textContent = message;
}

function setPushStatus(message) {
  const element = document.getElementById("pushStatus");
  if (element) element.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(Array.from(rawData).map(character => character.charCodeAt(0)));
}
