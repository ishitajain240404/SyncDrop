import { nanoid } from "nanoid";

class RoomManager {
  constructor() {
    // Map<roomId, Map<clientId, WebSocket>>
    this.rooms = new Map();
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  createRoom() {
    const roomId = nanoid(6);
    this.rooms.set(roomId, new Map());
    return roomId;
  }

  hasRoom(roomId) {
    return this.rooms.has(roomId);
  }

  addClient(roomId, clientId, ws) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Map());
    }
    const room = this.rooms.get(roomId);
    room.set(clientId, ws);
  }

  removeClient(roomId, clientId) {
    if (!this.rooms.has(roomId)) return;
    const room = this.rooms.get(roomId);
    room.delete(clientId);

    if (room.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  broadcastToRoom(roomId, senderClientId, payload) {
    const room = this.getRoom(roomId);
    if (!room) return;

    for (const [peerId, peerWs] of room.entries()) {
      if (peerId !== senderClientId && peerWs.readyState === 1) {
        // 1 = OPEN
        peerWs.send(JSON.stringify(payload));
      }
    }
  }
}

export default new RoomManager();
