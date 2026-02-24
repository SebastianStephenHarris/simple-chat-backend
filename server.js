import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", ws => {
  ws.on("message", msg => {
    // Send incoming message to all clients
    wss.clients.forEach(client => {
      if (client.readyState === ws.OPEN) {
        client.send(msg.toString());
      }
    });
  });
});

console.log(`WebSocket chat server running on wss://localhost:${PORT}`);