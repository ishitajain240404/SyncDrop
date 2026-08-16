import { nanoid } from "nanoid";
import roomManager from "../services/roomManager.js";

export function handleWebSocketConnection(ws) {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  let currentRoomId = null;
  let currentClientId = null;

  // Centralized Cleanup Function
  const handleDisconnect = () => {
    if (currentRoomId && currentClientId) {
      const roomIdToClean = currentRoomId;
      const clientIdToClean = currentClientId;

      // Clear references immediately to avoid duplicate execution
      currentRoomId = null;
      currentClientId = null;

      // 1. Remove client from room memory map
      roomManager.removeClient(roomIdToClean, clientIdToClean);

      // 2. Check if a peer remains in the room
      const remainingRoom = roomManager.getRoom(roomIdToClean);

      if (remainingRoom && remainingRoom.size > 0) {
        // Promote the remaining client to Initiator
        const [remainingClientId, remainingWs] = Array.from(
          remainingRoom.entries(),
        )[0];

        // Notify the remaining peer that they are now the Initiator
        if (remainingWs && remainingWs.readyState === remainingWs.OPEN) {
          remainingWs.send(
            JSON.stringify({
              type: "role-update",
              isInitiator: true,
              peerDisconnected: true,
            }),
          );
        }
      }
    }
  };

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "join-room": {
          const requestedRoomId = data.roomId?.trim();
          const clientId = nanoid(8);

          if (requestedRoomId) {
            if (!roomManager.hasRoom(requestedRoomId)) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Room does not exist. Please check the Room ID.",
                }),
              );
              return;
            }
            currentRoomId = requestedRoomId;
          } else {
            currentRoomId = roomManager.createRoom();
          }

          const room = roomManager.getRoom(currentRoomId);

          if (room && room.size >= 2) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Room is full (Max 2 peers permitted).",
              }),
            );
            return;
          }

          roomManager.addClient(currentRoomId, clientId, ws);
          currentClientId = clientId;

          const activeRoom = roomManager.getRoom(currentRoomId);
          const currentRoomSize = activeRoom ? activeRoom.size : 1;
          const isFirstUser = currentRoomSize === 1;

          // 1. Confirm room joined state to connecting user
          ws.send(
            JSON.stringify({
              type: "room-joined",
              roomId: currentRoomId,
              clientId: clientId,
              isInitiator: isFirstUser,
              peerJoined: currentRoomSize === 2,
            }),
          );

          // 2. If 2 peers are now present, notify both peers
          if (currentRoomSize === 2) {
            // Notify existing peer that a new peer joined
            roomManager.broadcastToRoom(currentRoomId, clientId, {
              type: "peer-joined",
              peerId: clientId,
            });

            // Notify joining peer that existing peer is ready
            ws.send(
              JSON.stringify({
                type: "peer-joined",
                peerId: "existing-peer",
              }),
            );
          }
          break;
        }

        case "signal": {
          if (!currentRoomId) return;
          roomManager.broadcastToRoom(currentRoomId, currentClientId, {
            type: "signal",
            senderId: currentClientId,
            signalData: data.signalData,
          });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error("[WS Handler Error]:", err);
    }
  });

  // Fires on ANY close trigger (graceful close, network drop, OR ws.terminate())
  ws.on("close", handleDisconnect);
  ws.on("error", handleDisconnect);
}
