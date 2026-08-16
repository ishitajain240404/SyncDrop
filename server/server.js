import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import { PORT } from "./src/config.js";
import { handleWebSocketConnection } from "./src/handlers/wsHandler.js";
import roomManager from "./src/services/roomManager.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/rooms/:roomId/exists", (req, res) => {
  const { roomId } = req.params;
  const exists = roomManager.hasRoom(roomId);
  return res.json({ exists });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", handleWebSocketConnection);

// --- HEARTBEAT INTERVAL ENGINE ---
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    // If the client didn't respond to the ping from the LAST interval cycle
    if (ws.isAlive === false) {
      console.log("[Server]: Peer timed out. Terminating connection.");
      return ws.terminate(); // Closes connection instantly without waiting for a graceful handshake
      // .terminate() will still run the ws.on("close") event, which will trigger the cleanup logic in wsHandler.js
    }

    // Assume they're dead until they prove they're alive by answering this ping
    ws.isAlive = false;
    ws.ping(); // Sends a ping frame to the browser
  });
}, 30000); // 30 seconds

// Clear the interval loop if the server shuts down to prevent memory leaks
wss.on("close", () => {
  clearInterval(interval);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
