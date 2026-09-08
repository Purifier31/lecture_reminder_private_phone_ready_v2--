self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {
      title: "Lecture Reminder",
      body: event.data ? event.data.text() : "You have an upcoming lecture."
    };
  }

  const options = {
    body: data.body || "You have an upcoming lecture.",
    tag: data.id ? `lecture-${data.id}` : "lecture-reminder",
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.url || "/"
    }
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || "Lecture Reminder",
      options
    )
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(clientList => {
      const existing = clientList.find(client => "focus" in client);

      if (existing) {
        existing.navigate(url);
        return existing.focus();
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }

      return undefined;
    })
  );
});