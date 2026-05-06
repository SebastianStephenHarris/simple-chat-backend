import http from "http";
import { WebSocketServer } from "ws";

// Create HTTP server
const server = http.createServer();

// WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Handle upgrades
server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit("connection", ws, request);
  });
});

// Handle connections
wss.on("connection", ws => {
  ws.on("message", msg => {
    let data;

    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    // Broadcast to all clients
    wss.clients.forEach(client => {
      if (client.readyState === ws.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  });
});

// Listen
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
