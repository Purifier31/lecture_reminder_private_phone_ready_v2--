LECTURE REMINDER — PRIVATE PHONE-READY VERSION

PRIVACY MODEL
- Each browser/device keeps its own reminder list in localStorage under: lectureReminders.
- The Upcoming list is rendered only from localStorage. There is no public GET /api/reminders.
- A different browser/device starts empty.
- Deleting a reminder removes it from that browser only.
- The server stores push subscriptions and private schedule jobs, not a global student reminder list.
- Every schedule/test/delete/sync request must include the FULL PushSubscription JSON: endpoint + keys.p256dh + keys.auth.
- The server compares all three values with the stored subscription before allowing the operation.
- Schedule jobs are tied to one subscription endpoint and are never broadcast.

PUBLIC / DATA LAYOUT
- public/index.html
- public/main.js
- public/sw.js
- public/manifest.json
- public/icon.svg
- server.js stays outside public/.
- SQLite lives in DATA_DIR (recommended Railway mount: /data), which is outside public/.
- express.static serves ONLY public/, so /data/lecture-reminder.db is not downloadable over HTTP.

FEATURES
- Web Push notifications while the website is closed
- SQLite subscriptions, VAPID settings and private schedule jobs
- Africa/Lagos time (UTC+1)
- HH:MM and HH:MM:SS input are accepted and normalized to HH:MM
- Invalid calendar dates such as 31 February are rejected
- No Firebase, accounts, passwords, JWT or OAuth

PUSH FLOW
1. Student enables notifications. The browser creates/loads its PushSubscription.
2. The full subscription JSON is registered on the server.
3. Existing local reminders are synchronized for that subscription.
4. Sync removes only stale jobs belonging to that same subscription.
5. Saving a reminder stores it in localStorage and, if push is active, creates/updates its private server job.
6. Deleting a reminder removes it locally and requests deletion of that job using the full subscription.
7. Test Notification uses the full subscription and targets only that subscription.

SCHEDULER RELIABILITY
- The server checks jobs every 30 seconds.
- A due job is retried after temporary push failures instead of being immediately dropped.
- The server keeps retrying until delivery succeeds, 20 attempts are reached, or the job is more than 2 hours past eventAt.
- Successful delivery sets notified=1.
- Permanent subscription failures (404/410), 20 failed attempts, or the two-hour post-event window mark the job failed and it is removed by cleanup.
- Temporary server restarts/outages do not delete a due job because schedule jobs are stored durably in SQLite.

LOCAL TEST
1. Install Node.js LTS.
2. Open a terminal in this folder.
3. Run: npm install
4. Run: npm start
5. Open http://localhost:8000

RAILWAY
- Attach a persistent Railway volume and set DATA_DIR=/data.
- Deploy the whole project.
- The app must use its Railway HTTPS domain for phone Web Push.
- VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY may be supplied as environment variables. If omitted, keys are generated and saved in SQLite; persistent storage is therefore required.

SECURITY NOTES
- Never place DATA_DIR inside public/.
- Do not log reminder titles or push endpoint URLs in production logs.
- The full PushSubscription acts as the no-account authorization proof for this browser's push subscription. It is not an account identity system.
