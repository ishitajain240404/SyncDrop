/**
 * utils/webrtc.js
 *
 * WebRTC DataChannel Engine with deferral-based ICE restarts and fallback rebuilds.
 */

const CHUNK_SIZE = 64 * 1024; // 64 KB
const BACKPRESSURE_LIMIT = 1 * 1024 * 1024; // 1 MB

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
  iceCandidatePoolSize: 10,
};

export class WebRTCManager {
  constructor(
    sendSignal,
    onStateChange,
    onProgress,
    onFileReceived,
    onError,
    onSendComplete,
  ) {
    this.sendSignal = sendSignal;
    this.onStateChange = onStateChange;
    this.onProgress = onProgress;
    this.onFileReceived = onFileReceived;
    this.onError = onError;
    this.onSendComplete = onSendComplete;

    this.peerConnection = null;
    this.dataChannel = null;
    this.isInitiator = false;

    // Presence Guard
    this.isRemotePeerPresent = false;

    this.iceCandidatesQueue = [];
    this.iceRestartTimer = null;
    this.isRestartingIce = false;

    // Transfer Locks
    this.isTransferring = false;
    this.pendingOutgoingFile = null;

    // Sender State
    this.isPumping = false;
    this.currentSendingFile = null;
    this.sendOffset = 0;

    // Receiver State
    this.fileMetadata = null;
    this.receivedSize = 0;
    this.opfsFileHandle = null;
    this.opfsWritable = null;

    // OPFS Readiness Barrier
    this.opfsReadyPromise = null;
    this.resolveOpfsReady = null;

    this.writeQueue = Promise.resolve();
    this.signalingChain = Promise.resolve();
  }

  setRemotePeerPresent(isPresent) {
    console.log(`[WebRTC] Remote peer presence changed: ${isPresent}`);
    this.isRemotePeerPresent = isPresent;

    if (!isPresent) {
      console.warn(
        "[WebRTC] Remote peer left or is absent. Stopping recovery & resetting WebRTC state...",
      );
      this.clearIceRestartTimer();
      this.cleanup();
      if (this.onStateChange) this.onStateChange("peer-absent");
    }
  }

  initConnection(isInitiator, forceReinit = true) {
    if (!this.isRemotePeerPresent) {
      console.warn("[WebRTC] Cannot init connection: Remote peer is absent.");
      return;
    }

    if (
      !forceReinit &&
      this.peerConnection &&
      (this.peerConnection.connectionState === "connecting" ||
        this.peerConnection.connectionState === "connected")
    ) {
      return;
    }

    console.warn("[WebRTC] Performing full teardown & re-initialization...");
    this.cleanup();
    this.isInitiator = isInitiator;
    this.setupPeerConnection(isInitiator);
  }

  setupPeerConnection(isInitiator) {
    this.peerConnection = new RTCPeerConnection(RTC_CONFIG);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        const payload = event.candidate.toJSON
          ? event.candidate.toJSON()
          : event.candidate;
        this.sendSignal({ type: "candidate", candidate: payload });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection) return;
      const state = this.peerConnection.connectionState;
      if (this.onStateChange) this.onStateChange(state);

      if (!this.isRemotePeerPresent) {
        console.log(
          `[WebRTC] Connection state transitioned to '${state}', but remote peer is absent. Suppressing recovery.`,
        );
        this.clearIceRestartTimer();
        return;
      }

      if (state === "connected") {
        this.clearIceRestartTimer();
      } else if (state === "failed") {
        console.warn(`[WebRTC] Peer connection state is 'failed'.`);
        if (this.isInitiator) {
          console.log(
            "[WebRTC] Initiator auto-triggering ICE restart on 'failed' state...",
          );
          this.restartIce();
        } else {
          console.log(
            "[WebRTC] Non-initiator waiting for initiator's restart offer...",
          );
          this.startIceRestartTimeout();
        }
      } else if (state === "disconnected") {
        console.warn(
          "[WebRTC] Connection 'disconnected'. Waiting 10s before attempting ICE restart...",
        );
        this.clearIceRestartTimer();

        // 10s grace period: if connection isn't restored, escalate to restartIce()
        this.iceRestartTimer = setTimeout(() => {
          if (
            this.peerConnection &&
            this.peerConnection.connectionState !== "connected"
          ) {
            console.warn(
              "[WebRTC] 10s disconnected timeout expired. Attempting ICE restart...",
            );
            this.restartIce();
          }
        }, 10000);
      }
    };

    if (isInitiator) {
      this.dataChannel = this.peerConnection.createDataChannel("fileTransfer", {
        ordered: true,
      });
      this.setupDataChannel();

      this.peerConnection
        .createOffer()
        .then((offer) => this.peerConnection.setLocalDescription(offer))
        .then(() => {
          this.sendSignal({
            type: "offer",
            offer: {
              type: this.peerConnection.localDescription.type,
              sdp: this.peerConnection.localDescription.sdp,
            },
          });
        })
        .catch((err) => this.handleError("Failed to create offer", err));
    } else {
      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };
    }
  }

  handleSignal(signalData) {
    this.signalingChain = this.signalingChain
      .then(() => this._processSignal(signalData))
      .catch((err) => {
        console.error("[WebRTC Signal Error]:", err);
      });
    return this.signalingChain;
  }

  async _processSignal(signalData) {
    if (
      !this.peerConnection ||
      this.peerConnection.connectionState === "closed"
    ) {
      this.cleanup();
      this.isInitiator = false;
      this.setupPeerConnection(false);
    }
    const connState = this.peerConnection.connectionState;
    const sigState = this.peerConnection.signalingState;

    try {
      if (signalData.type === "offer") {
        if (
          connState === "failed" ||
          connState === "disconnected" ||
          (sigState !== "stable" && sigState !== "have-local-offer")
        ) {
          console.warn(
            "[WebRTC] Incoming offer on degraded/unstable peer connection. Resetting connection context...",
          );
          this.cleanup();
          this.setupPeerConnection(false);
        }

        const remoteOffer = new RTCSessionDescription({
          type: signalData.offer.type || "offer",
          sdp: signalData.offer.sdp || signalData.offer,
        });

        await this.peerConnection.setRemoteDescription(remoteOffer);
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        this.sendSignal({
          type: "answer",
          answer: {
            type: this.peerConnection.localDescription.type,
            sdp: this.peerConnection.localDescription.sdp,
          },
        });

        await this.flushIceCandidates();
      } else if (signalData.type === "answer") {
        if (sigState !== "have-local-offer") {
          console.warn(
            `[WebRTC] Suppressing answer signal: PeerConnection is in '${sigState}' state (expected 'have-local-offer').`,
          );
          return;
        }
        const remoteAnswer = new RTCSessionDescription({
          type: signalData.answer.type || "answer",
          sdp: signalData.answer.sdp || signalData.answer,
        });

        await this.peerConnection.setRemoteDescription(remoteAnswer);
        await this.flushIceCandidates();
      } else if (signalData.type === "candidate") {
        if (!signalData.candidate) return;

        const candidateInit = {
          candidate: signalData.candidate.candidate || signalData.candidate,
          sdpMid: signalData.candidate.sdpMid ?? "0",
          sdpMLineIndex: signalData.candidate.sdpMLineIndex ?? 0,
        };

        if (
          this.peerConnection.remoteDescription &&
          this.peerConnection.remoteDescription.type
        ) {
          await this.peerConnection.addIceCandidate(
            new RTCIceCandidate(candidateInit),
          );
        } else {
          this.iceCandidatesQueue.push(candidateInit);
        }
      } else if (signalData.type === "request-ice-restart") {
        if (this.isInitiator) {
          console.log(
            "[WebRTC] Received 'request-ice-restart' signal. Initiator restarting ICE now...",
          );
          this.restartIce();
        }
      }
    } catch (err) {
      this.handleError("Error processing signaling payload", err);
    }
  }

  async flushIceCandidates() {
    while (this.iceCandidatesQueue.length > 0) {
      const candidatePayload = this.iceCandidatesQueue.shift();
      try {
        await this.peerConnection.addIceCandidate(
          new RTCIceCandidate(candidatePayload),
        );
      } catch (err) {
        console.warn("[ICE Candidate Flush Warning]:", err);
      }
    }
  }

  setupDataChannel() {
    if (!this.dataChannel) return;
    this.dataChannel.binaryType = "arraybuffer";
    this.dataChannel.bufferedAmountLowThreshold = BACKPRESSURE_LIMIT / 2;

    this.dataChannel.onopen = () => {
      this.clearIceRestartTimer();
      if (this.onStateChange) this.onStateChange("connected");

      if (this.fileMetadata && this.opfsWritable) {
        this.dataChannel.send(
          JSON.stringify({
            type: "request-resume",
            offset: this.receivedSize,
          }),
        );
      }
    };

    this.dataChannel.onclose = () => {
      if (this.onStateChange) this.onStateChange("disconnected");
    };

    this.dataChannel.onmessage = (event) =>
      this.handleIncomingMessage(event.data);

    this.dataChannel.onbufferedamountlow = () => {
      if (this.currentSendingFile && !this.isPumping) {
        this.pumpChunks();
      }
    };
  }

  requestSendFile(file) {
    if (!navigator.onLine) {
      this.handleError("Cannot send file while offline. Reconnecting...");
      return;
    }
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      this.handleError("DataChannel is not connected.");
      return;
    }

    if (this.isTransferring) {
      this.handleError("A transfer is already in progress.");
      return;
    }

    this.pendingOutgoingFile = file;

    this.dataChannel.send(
      JSON.stringify({
        type: "TRANSFER_REQUEST",
        fileName: file.name,
        fileSize: file.size,
      }),
    );
  }

  restartIce() {
    if (!this.isRemotePeerPresent) {
      console.warn(
        "[WebRTC] Skipping ICE restart because remote peer is not present.",
      );
      return;
    }
    if (this.peerConnection?.connectionState === "connected") {
      return;
    }
    if (this.isRestartingIce) {
      console.log(
        "[WebRTC] ICE restart already in progress. Ignoring duplicate request.",
      );
      return;
    }

    this.startIceRestartTimeout();

    if (this.isInitiator) {
      console.log("[WebRTC] Initiator restarting ICE...");
      this.peerConnection
        .createOffer({ iceRestart: true })
        .then((offer) => this.peerConnection.setLocalDescription(offer))
        .then(() => {
          this.sendSignal({
            type: "offer",
            offer: {
              type: this.peerConnection.localDescription.type,
              sdp: this.peerConnection.localDescription.sdp,
            },
          });
        })
        .catch((err) => {
          console.error(
            "[WebRTC] ICE Restart Offer error. Falling back to full re-init:",
            err,
          );
          this.clearIceRestartTimer();
          this.initConnection(this.isInitiator, true);
        });
    } else {
      console.log(
        "[WebRTC] Non-initiator sending 'request-ice-restart' signal to initiator...",
      );
      this.sendSignal({ type: "request-ice-restart" });
    }
  }

  startIceRestartTimeout() {
    this.clearIceRestartTimer();

    if (!this.isRemotePeerPresent) return;

    this.isRestartingIce = true;

    this.iceRestartTimer = setTimeout(() => {
      console.warn(
        "[WebRTC] ICE restart timed out without recovery. Re-initializing connection from scratch...",
      );
      this.initConnection(this.isInitiator, true);
    }, 10000);
  }

  clearIceRestartTimer() {
    this.isRestartingIce = false;
    if (this.iceRestartTimer) {
      clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }
  }

  async handleIncomingMessage(data) {
    if (typeof data === "string") {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case "TRANSFER_REQUEST":
          this.handleTransferRequestCollision(msg);
          break;

        case "TRANSFER_ACK":
          this.executePendingSend();
          break;

        case "TRANSFER_YIELD_PLEASE":
          this.pendingOutgoingFile = null;
          this.dataChannel.send(JSON.stringify({ type: "TRANSFER_ACK" }));
          break;

        case "metadata":
          this.isTransferring = true;
          await this.prepareOpfsStorage(msg);
          break;

        case "transfer-rejected":
          this.isTransferring = false;
          this.currentSendingFile = null;
          this.pendingOutgoingFile = null;
          this.handleError(`Transfer rejected: ${msg.reason}`);
          break;

        case "request-resume":
          this.sendOffset = msg.offset;
          if (!this.currentSendingFile) {
            this.handleError(
              "Connection restored! Please re-select your file to resume.",
            );
            return;
          }
          // Scenario A: Receiver already has 100% of the file in OPFS
          if (this.sendOffset >= this.currentSendingFile.size) {
            if (this.onProgress) this.onProgress(100);
            if (this.dataChannel && this.dataChannel.readyState === "open") {
              this.dataChannel.send(
                JSON.stringify({ type: "transfer-complete" }),
              );
            }
            this.currentSendingFile = null;
            this.sendOffset = 0;
            this.isTransferring = false;
            if (this.onSendComplete) this.onSendComplete();
            return;
          }

          // Scenario B: Resume or start pumping chunks from msg.offset
          this.isPumping = false;
          this.pumpChunks();
          break;

        case "transfer-complete":
          if (this.onProgress) this.onProgress(100);
          break;

        default:
          break;
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.receivedSize += data.byteLength;

      // Queue chunk write, waiting for OPFS storage handle to be ready
      this.writeQueue = this.writeQueue.then(async () => {
        if (this.opfsReadyPromise) {
          await this.opfsReadyPromise;
        }

        if (this.opfsWritable) {
          try {
            await this.opfsWritable.write(data);
          } catch (writeErr) {
            console.error("[OPFS Write Error]:", writeErr);
          }
        }
      });

      const progressPercent = Math.floor(
        (this.receivedSize / this.fileMetadata.fileSize) * 100,
      );
      if (this.onProgress) this.onProgress(progressPercent);

      if (
        this.receivedSize >= this.fileMetadata.fileSize &&
        this.isTransferring
      ) {
        this.isTransferring = false;
        await this.writeQueue;
        await this.finalizeOpfsTransfer(this.fileMetadata);
      }
    }
  }

  handleTransferRequestCollision(msg) {
    if (this.pendingOutgoingFile) {
      if (this.isInitiator) {
        this.dataChannel.send(
          JSON.stringify({ type: "TRANSFER_YIELD_PLEASE" }),
        );
        return;
      } else {
        this.pendingOutgoingFile = null;
        this.isTransferring = true;
        this.dataChannel.send(JSON.stringify({ type: "TRANSFER_ACK" }));
        return;
      }
    }

    this.isTransferring = true;
    this.dataChannel.send(JSON.stringify({ type: "TRANSFER_ACK" }));
  }

  executePendingSend() {
    if (this.pendingOutgoingFile) {
      const file = this.pendingOutgoingFile;
      this.pendingOutgoingFile = null;
      this.sendFile(file);
    }
  }

  sendFile(file) {
    this.isTransferring = true;
    this.currentSendingFile = file;
    this.sendOffset = 0;

    const fileId = `${file.name}_${file.size}_${file.lastModified}`.replace(
      /[^a-zA-Z0-9]/g,
      "_",
    );

    // Explicitly guarantee video/mp4 MIME detection from file extension if file.type is blank
    let detectedType = file.type;
    if (!detectedType && file.name.endsWith(".mp4")) {
      detectedType = "video/mp4";
    }

    const metadata = {
      type: "metadata",
      fileId: fileId,
      fileName: file.name,
      fileSize: file.size,
      fileType: detectedType || "application/octet-stream",
    };

    this.dataChannel.send(JSON.stringify(metadata));
  }

  async pumpChunks() {
    if (this.isPumping || !this.currentSendingFile) return;
    this.isPumping = true;

    const file = this.currentSendingFile;

    try {
      while (this.sendOffset < file.size) {
        if (
          this.dataChannel &&
          this.dataChannel.bufferedAmount > BACKPRESSURE_LIMIT
        ) {
          return;
        }

        const slice = file.slice(this.sendOffset, this.sendOffset + CHUNK_SIZE);
        const buffer = await slice.arrayBuffer();

        if (!this.dataChannel || this.dataChannel.readyState !== "open") {
          return;
        }

        this.dataChannel.send(buffer);
        this.sendOffset += buffer.byteLength;

        const progressPercent = Math.floor((this.sendOffset / file.size) * 100);
        if (this.onProgress) this.onProgress(progressPercent);
      }

      if (this.sendOffset >= file.size) {
        if (this.dataChannel && this.dataChannel.readyState === "open") {
          this.dataChannel.send(JSON.stringify({ type: "transfer-complete" }));
        }

        this.currentSendingFile = null;
        this.sendOffset = 0;
        this.isTransferring = false;

        if (this.onSendComplete) {
          this.onSendComplete();
        }
      }
    } catch (err) {
      this.handleError("Error pumping file chunks", err);
    } finally {
      this.isPumping = false;
    }
  }

  async prepareOpfsStorage(metadata) {
    this.fileMetadata = metadata;

    // Create a deferred promise barrier to pause incoming chunk writes
    this.opfsReadyPromise = new Promise((resolve) => {
      this.resolveOpfsReady = resolve;
    });

    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { quota, usage } = await navigator.storage.estimate();
        const availableSpace = quota - usage;

        if (metadata.fileSize > availableSpace) {
          this.isTransferring = false;
          this.handleError("Transfer aborted: Insufficient local disk space.");
          this.dataChannel.send(
            JSON.stringify({
              type: "transfer-rejected",
              reason: "Receiver has insufficient device disk storage.",
            }),
          );
          return;
        }
      }

      const root = await navigator.storage.getDirectory();
      const opfsName = `temp_${metadata.fileId}`;

      this.opfsFileHandle = await root.getFileHandle(opfsName, {
        create: true,
      });
      const existingFile = await this.opfsFileHandle.getFile();
      const existingSize = existingFile.size;

      this.opfsWritable = await this.opfsFileHandle.createWritable({
        keepExistingData: true,
      });

      if (existingSize > 0 && existingSize < metadata.fileSize) {
        await this.opfsWritable.seek(existingSize);
        this.receivedSize = existingSize;
        console.log(
          `[WebRTC] Resuming transfer from byte offset: ${existingSize}`,
        );
      } else if (existingSize >= metadata.fileSize) {
        // File is already completely received in OPFS
        this.receivedSize = metadata.fileSize;
      } else {
        this.receivedSize = 0;
      }

      this.writeQueue = Promise.resolve();

      // Release the barrier so queued chunk writes can process
      if (this.resolveOpfsReady) {
        this.resolveOpfsReady();
      }

      if (this.dataChannel && this.dataChannel.readyState === "open") {
        this.dataChannel.send(
          JSON.stringify({ type: "request-resume", offset: this.receivedSize }),
        );
      }
    } catch (err) {
      this.isTransferring = false;
      this.handleError("Failed initializing OPFS storage", err);
    }
  }

  async finalizeOpfsTransfer(fileMetadata) {
    try {
      await this.writeQueue;

      if (this.opfsWritable) {
        await this.opfsWritable.close();
        this.opfsWritable = null;
      }

      if (this.onFileReceived) {
        this.onFileReceived({
          fileId: fileMetadata.fileId,
          fileName: fileMetadata.fileName,
          fileSize: fileMetadata.fileSize,
          fileType: fileMetadata.fileType,
        });
      }
    } catch (err) {
      this.handleError("Failed finalizing received file.", err);
    } finally {
      this.isTransferring = false;
      this.opfsFileHandle = null;
      this.receivedSize = 0;
      this.opfsReadyPromise = null;
      this.resolveOpfsReady = null;
    }
  }

  async saveAndCleanupFile(fileId, fileName, fileType) {
    const root = await navigator.storage.getDirectory();
    const opfsName = `temp_${fileId}`;

    try {
      const opfsFileHandle = await root.getFileHandle(opfsName);
      const rawOpfsFile = await opfsFileHandle.getFile();

      // Ensure proper MIME type resolution
      let mimeType = fileType;
      if (!mimeType || mimeType === "application/octet-stream") {
        const ext = fileName.split(".").pop().toLowerCase();
        const mimeMap = {
          mp4: "video/mp4",
          mkv: "video/x-matroska",
          webm: "video/webm",
          mov: "video/quicktime",
          avi: "video/x-msvideo",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          pdf: "application/pdf",
          zip: "application/zip",
        };
        mimeType = mimeMap[ext] || "application/octet-stream";
      }

      const extMatch = fileName.match(/\.([^.]+)$/);
      const extension = extMatch ? `.${extMatch[1]}` : "";

      const options = {
        suggestedName: fileName,
      };

      if (mimeType && extension) {
        options.types = [
          {
            description: "Transferred File",
            accept: { [mimeType]: [extension] },
          },
        ];
      }

      // Stream directly from OPFS to disk via ReadableStream without full arrayBuffer allocation in RAM
      const localFileHandle = await window.showSaveFilePicker(options);
      const localWritable = await localFileHandle.createWritable();

      // pipeTo streams byte-for-byte directly, preserving exact MP4 container headers
      await rawOpfsFile.stream().pipeTo(localWritable);

      await root.removeEntry(opfsName);
      return { success: true };
    } catch (err) {
      if (err.name === "AbortError") {
        return { success: false, canceled: true };
      }
      throw new Error("Disk write failed: " + err.message);
    }
  }

  static async autoSweepStaleFiles(maxAgeHours = 24) {
    try {
      const root = await navigator.storage.getDirectory();
      const now = Date.now();
      const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

      for await (const [name, handle] of root.entries()) {
        if (name.startsWith("temp_") && handle.kind === "file") {
          try {
            const file = await handle.getFile();
            if (now - file.lastModified > maxAgeMs) {
              await root.removeEntry(name);
            }
          } catch (fileErr) {
            console.warn(`[OPFS Sweep Error] ${name}:`, fileErr);
          }
        }
      }
    } catch (err) {
      console.warn("[OPFS Startup Sweep Error]:", err);
    }
  }

  async deleteOpfsFile(fileId) {
    try {
      const root = await navigator.storage.getDirectory();
      if (fileId) {
        await root.removeEntry(`temp_${fileId}`);
      }
    } catch (err) {
      console.warn(`[OPFS Delete Warning] temp_${fileId}:`, err);
    }
  }

  handleError(msg, err) {
    console.error(`[WebRTC Engine Error]: ${msg}`, err || "");
    if (this.onError) this.onError(msg);
  }

  cleanup() {
    this.isRestartingIce = false;
    this.clearIceRestartTimer();

    if (this.opfsWritable) {
      try {
        this.opfsWritable.close();
      } catch (err) {
        console.warn("[OPFS Cleanup] Failed closing stream:", err);
      }
      this.opfsWritable = null;
    }

    if (this.dataChannel) {
      this.dataChannel.onmessage = null;
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onbufferedamountlow = null;
      try {
        this.dataChannel.close();
      } catch (e) {}
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.onconnectionstatechange = null;
      try {
        this.peerConnection.close();
      } catch (e) {}
      this.peerConnection = null;
    }

    this.isTransferring = false;
    this.pendingOutgoingFile = null;
    this.currentSendingFile = null;
    this.opfsFileHandle = null;
    this.opfsReadyPromise = null;
    this.resolveOpfsReady = null;
    this.sendOffset = 0;
    this.receivedSize = 0;
    this.iceCandidatesQueue = [];
  }
}
