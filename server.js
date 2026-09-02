import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import webpush from "web-push";

const ALLOWED_TYPES = new Set(["message", "image", "gif"]);
const MAX_TEXT_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 32;
const MAX_ID_LENGTH = 64;
const MAX_URL_LENGTH = 1_000_000; // room for large base64 image data URLs
const MAX_PAYLOAD = 2 * 1024 * 1024; // 2 MB WebSocket frame cap
const MAX_TRACKED_MESSAGES = 2000;
const MAX_HISTORY = 10;
const PUSH_ENDPOINT_MAX = 500;
const PUSH_KEY_MAX = 200;

// VAPID: private key and subject must come from environment (Render).
// The public key can be fetched via GET /vapid-public and is safe to share.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "";

let vapidConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

// messageId -> { senderId, senderUsername, seenBy:Set<clientId> }
const messages = new Map();
// clientId -> { ws, username, color }
const clients = new Map();
// last MAX_HISTORY chat messages, oldest -> newest (in-memory only)
let history = [];
// push endpoint -> { endpoint, keys:{p256dh,auth}, clientId, username, updatedAt }
const pushSubs = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, pushSubs: pushSubs.size }));
    return;
  }

  if (url.pathname === "/vapid-public") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify({ key: VAPID_PUBLIC_KEY }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit("connection", ws, request);
  });
});

function clampName(name) {
  if (typeof name !== "string") return "";
  return name.trim().slice(0, MAX_USERNAME_LENGTH);
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(typeof payload === "string" ? payload : JSON.stringify(payload), err => {
      if (err) console.error("send error:", err.message);
    });
  }
}

function sendTo(clientId, payload) {
  const c = clients.get(clientId);
  if (c) send(c.ws, payload);
}

function broadcast(payload, exceptId = null) {
  for (const [id, client] of clients) {
    if (exceptId && id === exceptId) continue;
    if (client.ws.readyState === WebSocket.OPEN) send(client.ws, payload);
  }
}

function roster() {
  return [...clients.values()].map(c => c.username).filter(Boolean);
}

function pruneMessages() {
  while (messages.size > MAX_TRACKED_MESSAGES) {
    const first = messages.keys().next().value;
    if (first === undefined) break;
    messages.delete(first);
  }
}

function normalizeMedia(data, client) {
  if (!data || typeof data !== "object") return null;

  const type = ALLOWED_TYPES.has(String(data.type)) ? String(data.type) : "";
  if (!type) return null;

  const username = client.username || clampName(data.username);
  if (!username) return null;

  if (type === "message") {
    const text = String(data.text || "");
    if (!text.trim() || text.length > MAX_TEXT_LENGTH) return null;

    return {
      type,
      username,
      color: client.color || (typeof data.color === "string" ? data.color.slice(0, 7) : undefined),
      text,
      reply: typeof data.reply === "string" && data.reply ? String(data.reply).slice(0, 500) : undefined
    };
  }

  const urlKey = type === "image" ? "image" : "gif";
  const url = data[urlKey];
  if (typeof url !== "string" || !url || url.length > MAX_URL_LENGTH) return null;

  return { type, username, [urlKey]: url };
}

function broadcastChatMessage(payload) {
  for (const [, rc] of clients) {
    if (rc.ws.readyState !== WebSocket.OPEN) continue;
    send(rc.ws, payload);
  }
  notifySubscribers(payload);
}

function updateSubUsername(clientId, username) {
  for (const s of pushSubs.values()) {
    if (s.clientId === clientId) s.username = username;
  }
}

function notifySubscribers(payload) {
  if (!vapidConfigured || pushSubs.size === 0) return;

  let preview = "";
  if (payload.type === "image") preview = "[Image]";
  else if (payload.type === "gif") preview = "[GIF]";
  else {
    preview = String(payload.text || "").replace(/\r?\n/g, " ").trim().slice(0, 80);
    if (!preview) return;
  }

  const notification = {
    title: "Chatroom",
    body: `${payload.username}: ${preview}`,
    tag: String(payload.id),
    data: {}
  };

  for (const sub of pushSubs.values()) {
    if (sub.username === payload.username) continue; // never notify the sender

    webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(notification))
      .catch(err => {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          pushSubs.delete(sub.endpoint);
        } else {
          console.error("push error:", err ? (err.statusCode || err.message) : "unknown");
        }
      });
  }
}

wss.on("connection", (ws, request) => {
  const clientId = crypto.randomUUID();
  const client = { ws, username: "", color: "" };
  clients.set(clientId, client);

  const remote = request.socket.remoteAddress;
  console.log(`Client connected (${remote})`);

  send(ws, { type: "welcome", clientId, users: roster(), history: [...history] });

  ws.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!data || typeof data !== "object") return;

    switch (data.type) {
      case "join": {
        const name = clampName(data.username);
        if (!name) return;

        client.username = name;
        client.color = typeof data.color === "string" ? data.color.slice(0, 7) : "";
        updateSubUsername(clientId, name);

        broadcast({ type: "join", username: name });
        broadcast({ type: "online", users: roster() });
        break;
      }

      case "rename": {
        const oldName = client.username;
        const newName = clampName(data.username);
        if (!newName) return;

        client.username = newName;
        if (typeof data.color === "string") client.color = data.color.slice(0, 7);
        updateSubUsername(clientId, newName);

        if (oldName === newName) break; // colour-only update, nothing to announce

        broadcast({ type: "rename", from: oldName, username: newName });
        broadcast({ type: "online", users: roster() });
        break;
      }

      case "typing": {
        if (!client.username) return;
        broadcast(
          { type: "typing", username: client.username, typing: !!data.typing },
          clientId
        );
        break;
      }

      case "seen": {
        const id = String(data.id || "");
        const entry = messages.get(id);
        if (!entry || id.length > MAX_ID_LENGTH) return;
        if (entry.senderId === clientId) return;
        if (!client.username) return;

        if (!entry.seenBy.has(clientId)) {
          entry.seenBy.add(clientId);
          sendTo(entry.senderId, { type: "status", id, username: client.username, status: "seen" });
        }
        break;
      }

      case "subscribe": {
        if (!client.username) return;
        if (!data.subscription || typeof data.subscription !== "object") return;

        const endpoint = typeof data.subscription.endpoint === "string" && /^https:\/\//i.test(data.subscription.endpoint)
          ? data.subscription.endpoint.slice(0, PUSH_ENDPOINT_MAX)
          : "";
        const keys = data.subscription.keys;
        const p256dh = keys && typeof keys.p256dh === "string" ? keys.p256dh.slice(0, PUSH_KEY_MAX) : "";
        const auth = keys && typeof keys.auth === "string" ? keys.auth.slice(0, PUSH_KEY_MAX) : "";
        if (!endpoint || !p256dh || !auth) return;

        pushSubs.set(endpoint, {
          endpoint,
          keys: { p256dh, auth },
          clientId,
          username: client.username,
          updatedAt: Date.now()
        });
        break;
      }

      case "unsubscribe": {
        const endpoint = typeof data.endpoint === "string" ? data.endpoint.slice(0, PUSH_ENDPOINT_MAX) : "";
        const sub = pushSubs.get(endpoint);
        if (sub && sub.clientId === clientId) pushSubs.delete(endpoint);
        break;
      }

      case "message":
      case "image":
      case "gif": {
        const safe = normalizeMedia(data, client);
        if (!safe) return;

        const id = typeof data.id === "string" && data.id.length <= MAX_ID_LENGTH
          ? data.id
          : crypto.randomUUID();

        const entry = {
          senderId: clientId,
          senderUsername: safe.username,
          seenBy: new Set()
        };
        messages.set(id, entry);
        pruneMessages();

        const out = { ...safe, id, senderId: clientId };
        history.push(out);
        if (history.length > MAX_HISTORY) history.shift();

        broadcastChatMessage(out);
        break;
      }
    }
  });

  ws.on("error", err => {
    console.error("WebSocket error:", err.message);
  });

  ws.on("close", () => {
    const name = client.username;
    clients.delete(clientId);

    for (const m of messages.values()) {
      m.seenBy.delete(clientId);
    }

    if (name) {
      broadcast({ type: "leave", username: name });
      broadcast({ type: "online", users: roster() });
    }

    console.log(`Client disconnected (${remote}), ${clients.size} remaining`);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running and listening on port ${port}`);
});