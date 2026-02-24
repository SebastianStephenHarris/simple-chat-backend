import http from "http";
import { WebSocketServer } from "ws";

// Create regular HTTP server
const server = http.createServer();

// Create WebSocket server and attach to HTTP server
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrades
server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit("connection", ws, request);
  });
});

// Broadcast messages
wss.on("connection", ws => {
  ws.on("message", msg => {
    wss.clients.forEach(client => {
      if (client.readyState === ws.OPEN) {
        client.send(msg.toString());
      }
    });
  });
});

// Listen on the port assigned by Render
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server running and listening on port ${port}`);
});
