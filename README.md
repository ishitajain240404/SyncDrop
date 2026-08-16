# SyncDrop

SyncDrop is a light-themed, high-performance, peer-to-peer (P2P) progressive web application engineered for zero-cloud, direct browser-to-browser file sharing. Built using WebRTC Data Channels and the browser-native Origin Private File System (OPFS), SyncDrop streams arbitrary-sized files directly to local disk handles without intermediate server storage, memory overhead, or size limitations.

---

## Technical Architecture

SyncDrop separates the signaling control plane from the direct P2P data engine. All file payload content travels strictly peer-to-peer across DTLS-encrypted WebRTC channels, while signaling metadata is routed via a lightweight WebSocket server.

---

### 1. WebRTC Signaling & ICE Candidate Exchange

![WebRTC Connection & ICE Candidate Exchange Flow](assets/ICE%20Candidates%20Exchange.png)

**Figure 1: Signaling and Connection Handshake Diagram**

- **Room Discovery & Pairing**: Both peers connect to the signaling server via WebSockets and join a shared 6-character room ID. Upon pairing, the server dynamically designates Peer A as the initiator.
- **SDP Offer/Answer Exchange**: Peer A creates a local WebRTC session description (SDP Offer) and routes it to Peer B through the WebSocket relay. Peer B sets its remote description, constructs an SDP Answer, and sends it back to Peer A.
- **Trickle ICE Exchange**: Both clients discover their public/local IP endpoints via Google STUN servers and exchange ICE candidates asynchronously over the signaling WebSocket.
- **Direct P2P Channel Opening**: Once candidate pairs are matched, an end-to-end encrypted `RTCDataChannel` opens directly between the two browsers, bypassing the server entirely for all subsequent file transfer operations.

---

### 2. OPFS Byte-Offset Resumption & Backpressure Flow Control

![OPFS Byte-Offset Resumption & Backpressure Flow](assets/Receiver%20Offset.png)

**Figure 2: Protocol Flow for Resumable Transfers & Flow Control**

- **Metadata & Offset Discovery**: Before streaming begins, the sender transmits file metadata (`fileId`, `fileName`, `fileSize`). The receiver queries its local OPFS storage for any existing temporary file (`temp_${fileId}`) to determine how many bytes were previously written.
- **Byte-Offset Resume Request**: If a partial download exists (e.g., 5,242,880 bytes), the receiver issues a `request-resume` signal with the byte offset. The sender seeks its file reader slice directly to that offset.
- **Chunk Streaming & Backpressure Management**: The sender streams binary data in 64 KB chunks. If the sender's `dataChannel.bufferedAmount` exceeds 1 MB (`BACKPRESSURE_LIMIT`), reading pauses automatically to prevent browser memory exhaustion. Pumping resumes once the `onbufferedamountlow` event fires.
- **Zero-RAM Export**: Received binary chunks write synchronously to OPFS disk storage. Upon completion, the file is piped directly from OPFS to the native OS file system via `showSaveFilePicker()`, ensuring zero RAM consumption during export.

---

### 3. Comprehensive System Architecture & Component Mapping

![SyncDrop System Architecture](assets/SyncDrop%20Flow.png)

**Figure 3: System Component and Module Interaction Map**

- **Peer A / Sending Client**:
  - `App.jsx` (React UI): Manages file selection, upload interface, progress states, and room events.
  - `webrtc.js`: Initializes `RTCPeerConnection`, slices binary files into 64 KB array buffers, and monitors the 1 MB backpressure threshold.
  - `storage.js`: Interfaces with IndexedDB to store `roomId` and `fileName` metadata, preserving room state across accidental page reloads.
- **Peer B / Receiving Client**:
  - `webrtc.js`: Receives incoming array buffers, calculates resume byte offsets, and runs the ICE restart watchdog for network resilience.
  - `storage.js`: Handles OPFS synchronous writes and persists state in IndexedDB. Pipes finished transfers directly from OPFS to the destination disk handle without loading files into browser RAM.
- **Node.js / Express Signaling Server (Control Plane)**:
  - `wsHandler.js`: Listens to incoming WebSocket message events, manages message routing, and informs paired clients when a new peer joins the room.
  - `roomManager.js`: Allocates isolated 6-character Nanoid room codes and strictly enforces a 2-peer limit per room.

---

## Comprehensive Application Features

### Core WebRTC Streaming & Protocol Features

- **Serverless Direct P2P Transfer**: File payloads are never stored, logged, or cached on intermediate servers or cloud storage. Content travels directly between client memory and client disk handles.
- **64 KB Chunk Streaming**: Large files are sliced into uniform 64 KB binary array buffers before transmission across the SCTP data channel.
- **Dynamic Backpressure Control**: Monitors `dataChannel.bufferedAmount` during active streaming. If the buffer exceeds 1 MB (`BACKPRESSURE_LIMIT`), chunk reads pause instantly and resume upon triggering the `onbufferedamountlow` event, preventing browser crashes or socket frame loss.
- **End-to-End DTLS Encryption**: WebRTC channels enforce standard DTLS encryption out of the box, ensuring privacy across local and public network links.

### Storage & Zero-RAM Memory Management

- **Zero-RAM Disk Piping**: Incoming files are written directly into OPFS during download. When saving, files are piped straight from OPFS to the user's local disk via `showSaveFilePicker()`, preventing browser RAM saturation regardless of file size.
- **IndexedDB Session State Preservation (`storage.js`)**: Automatically stores the active `roomId` and `fileName` in IndexedDB. If a user accidentally refreshes the page, SyncDrop restores the session context without kicking them from the workflow.
- **Deterministic Transfer Resumability**: File identifiers are generated deterministically using `fileName_fileSize_lastModified`. On connection drops or refreshes, receivers inspect existing byte lengths on disk and send a byte-offset resume signal (`request-resume`) to the sender.
- **Automatic 24-Hour Garbage Collection**: A startup background worker (`autoSweepStaleFiles`) scans the OPFS directory tree and unlinks orphan temporary files (`temp_*`) older than 24 hours to free local storage.

### Resilience & Event Handling

- **WebSocket Message Dispatcher (`wsHandler.js`)**: Listens to real-time client events and broadcasts peer arrival, disconnection, and signaling updates instantly to connected room members.
- **Automatic ICE Restart Watchdog**: Monitors network disruptions and triggers WebRTC renegotiation and ICE restarts seamlessly upon transient drops.
- **Dynamic Initiator Promotion**: Rooms strictly enforce a 2-peer limit. When an active host disconnects, the server dynamically promotes the remaining peer to initiator status.

---

## Deployment Architecture

- **Frontend**: Hosted on **Vercel** (React 18, Vite, Tailwind CSS)
- **Backend**: Hosted on **Railway** (Node.js, Express, WebSocket `ws`)

---

## Tech Stack & Project Dependencies

### Frontend (`/client`)

- **Framework**: React 18, Vite
- **Protocols & Storage**: WebRTC (`RTCPeerConnection`, `RTCDataChannel`), OPFS, IndexedDB, WebSockets
- **System APIs**: File System Access API (`showSaveFilePicker`), Streams API

### Backend (`/server`)

- **Runtime**: Node.js v18+
- **Framework**: Express.js
- **WebSocket Engine**: `ws`
- **Utilities**: `nanoid` (room/client ID generation), `cors`

---

## Local Setup & Development Guide

### Prerequisites

- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher

### 1. Repository Setup

```bash
git clone https://github.com/ishitajain240404/SyncDrop.git
cd SyncDrop
```

### 2. Backend Installation & Run

```bash
cd server
npm install
```

Create a `.env` file inside `/server`:

```env
PORT=5000
```

Start the signaling server:

```bash
npm start
```

### 3. Frontend Installation & Run

Open a new terminal window and navigate to the frontend directory:

```bash
cd client
npm install
```

Create a `.env` file inside `/client`:

```env
VITE_BACKEND_URL=http://localhost:5000
VITE_SIGNALING_URL=ws://localhost:5000
```

Launch the Vite client:

```bash
npm run dev
```

---

## Network Considerations & NAT Traversal

> **Deployment Notice**:
>
> - **STUN Configuration**: SyncDrop relies on public Google STUN servers (`stun:stun.l.google.com:19302`) to resolve ICE candidates across standard public and NAT networks.
> - **Symmetric NATs & Enterprise Firewalls**: Without a dedicated TURN relay server, connections may fail on strict corporate networks or symmetric NAT configurations that block direct UDP peer traffic.
> - **Production Extension**: To guarantee 100% connectivity across enterprise environments, integrate a TURN server (such as Coturn) within `RTC_CONFIG` in `webrtc.js`.
