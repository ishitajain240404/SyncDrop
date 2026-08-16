// App.jsx
import React, { useState, useEffect, useRef } from "react";
import { useSignaling } from "./hooks/useSignaling";
import { WebRTCManager } from "./utils/webrtc";
import { FileTransfer } from "./components/FileTransfer";
import { RoomSetup } from "./components/RoomSetup";
import {
  saveRoomId,
  saveTransferState,
  clearSenderFile,
  clearFileMetadataOnly,
  getSessionState,
  clearSessionState,
} from "./utils/storage";
import "./App.css";

export default function App() {
  const webrtcManagerRef = useRef(null);
  const [connectionState, setConnectionState] = useState("disconnected");
  const [progress, setProgress] = useState(0);
  const [receivedFile, setReceivedFile] = useState(null);

  // Session Restoration State
  const [savedSession, setSavedSession] = useState(null);
  const [activeSenderFile, setActiveSenderFile] = useState(null);

  const {
    isConnected,
    roomId,
    clientId,
    isInitiator,
    peerJoined,
    peerDisconnected,
    error,
    isReconnecting,
    reconnectFailed,
    reconnectAttempt,
    joinRoom,
    sendSignal,
    onSignal,
    leaveRoom,
    manualReconnect,
  } = useSignaling(webrtcManagerRef);

  const sendSignalRef = useRef(sendSignal);
  useEffect(() => {
    sendSignalRef.current = sendSignal;
  }, [sendSignal]);

  // App.jsx

  useEffect(() => {
    WebRTCManager.autoSweepStaleFiles(24);

    getSessionState().then(async (session) => {
      if (session && session.roomId) {
        try {
          const backendUrl =
            import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
          const response = await fetch(
            `${backendUrl}/api/rooms/${session.roomId}/exists`,
          );
          const data = await response.json();

          // If room no longer exists on server, purge stale session state
          if (!data.exists) {
            console.warn(
              "[App] Stale room session detected. Clearing IndexedDB session...",
            );
            if (session.fileId) {
              await webrtcManagerRef.current?.deleteOpfsFile(session.fileId);
            }
            await clearSessionState();
            return;
          }

          // Room exists, proceed with restore UI setup
          setSavedSession(session);

          if (session.role === "sender" && session.senderFile) {
            setActiveSenderFile(session.senderFile);
          }

          if (session.role === "receiver" && session.fileId) {
            try {
              const root = await navigator.storage.getDirectory();
              await root.getFileHandle(`temp_${session.fileId}`);

              setReceivedFile({
                fileId: session.fileId,
                fileName: session.fileName,
                fileSize: session.fileSize,
                fileType: session.fileType,
              });
            } catch (e) {
              await clearFileMetadataOnly();
            }
          }
        } catch (err) {
          console.error("[App] Failed to verify room status with server:", err);
        }
      }
    });
  }, []);

  useEffect(() => {
    if (peerDisconnected && webrtcManagerRef.current) {
      console.warn("[App] Peer disconnected. Cleaning up WebRTC instance...");

      webrtcManagerRef.current.cleanup();
      setConnectionState("disconnected");
      setProgress(0);
    }
  }, [peerDisconnected]);

  // Initialize WebRTCManager
  useEffect(() => {
    webrtcManagerRef.current = new WebRTCManager(
      (signalData) => sendSignalRef.current(signalData),
      (state) => setConnectionState(state),
      (p) => setProgress(p),
      async (fileData) => {
        setReceivedFile(fileData);
        // Persist receiver state & metadata into IndexedDB
        await saveTransferState({
          role: "receiver",
          fileId: fileData.fileId,
          fileName: fileData.fileName,
          fileSize: fileData.fileSize,
          fileType: fileData.fileType,
        });
      },
      (err) => console.warn("[WebRTC Warning]:", err),
      async () => {
        await clearSenderFile();
        setActiveSenderFile(null);
      },
    );

    return () => {
      webrtcManagerRef.current?.cleanup();
    };
  }, []);

  // Attach signaling handler
  useEffect(() => {
    if (!onSignal) return;

    const unsubscribe = onSignal((signalData) => {
      webrtcManagerRef.current?.handleSignal(signalData);
    });

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [onSignal]);

  useEffect(() => {
    if (roomId) {
      saveRoomId(roomId);
    }
  }, [roomId]);

  // Initiator Connection Logic
  useEffect(() => {
    if (
      peerJoined &&
      !peerDisconnected &&
      isConnected &&
      webrtcManagerRef.current
    ) {
      if (isInitiator) {
        console.log("[App] Peer joined and I am initiator. Creating offer...");
        webrtcManagerRef.current.initConnection(true, false);
      } else {
        console.log(
          "[App] Peer joined and I am receiver. Waiting for offer...",
        );
        // Initialize internal peer connection state as non-initiator without creating an offer
        webrtcManagerRef.current.initConnection(false, false);
      }
    }
  }, [peerJoined, peerDisconnected, isConnected, isInitiator]);

  const handleCreateRoom = async () => {
    await clearSessionState();
    setReceivedFile(null);
    setProgress(0);
    setActiveSenderFile(null);
    joinRoom(null);
  };

  const handleJoinRoom = async (code) => {
    if (code) {
      await clearSessionState();
      setReceivedFile(null);
      setProgress(0);
      setActiveSenderFile(null);
      joinRoom(code);
    }
  };

  const handleRestoreSession = (resumeFile = true) => {
    if (!savedSession) return;

    const targetRoomId = savedSession.roomId;
    const restoredFile = resumeFile ? savedSession.senderFile : null;

    setSavedSession(null);

    if (restoredFile) {
      setActiveSenderFile(restoredFile);
    } else if (savedSession.role === "sender") {
      clearSenderFile();
    }

    joinRoom(targetRoomId);
  };

  const handleDiscardSession = async () => {
    if (receivedFile?.fileId && webrtcManagerRef.current) {
      await webrtcManagerRef.current.deleteOpfsFile(receivedFile.fileId);
    }
    await clearSessionState();
    setSavedSession(null);
    setReceivedFile(null);
  };

  const handleSendFile = async (file) => {
    // 1. If user was previously a receiver with an unsaved file, delete its OPFS entry
    if (receivedFile?.fileId && webrtcManagerRef.current) {
      await webrtcManagerRef.current.deleteOpfsFile(receivedFile.fileId);
    }

    // 2. Clear receiver UI states
    setReceivedFile(null);
    setProgress(0);

    // 3. Clear existing metadata and store 'sender' role & file in IndexedDB (preserving roomId)
    await clearFileMetadataOnly();
    await saveTransferState({
      role: "sender",
      senderFile: file,
      fileName: file.name,
      fileSize: file.size,
    });

    // 4. Update UI & dispatch file send
    setActiveSenderFile(file);
    if (webrtcManagerRef.current) {
      webrtcManagerRef.current.requestSendFile(file);
    }
  };

  const handleDownloadFile = async () => {
    if (!receivedFile || !webrtcManagerRef.current) return;

    try {
      const result = await webrtcManagerRef.current.saveAndCleanupFile(
        receivedFile.fileId,
        receivedFile.fileName,
        receivedFile.fileType,
      );

      // Immediate cleanup ONLY on successful save:
      // OPFS file was deleted in saveAndCleanupFile, now clear metadata in IndexedDB while preserving roomId
      if (result && result.success) {
        await clearFileMetadataOnly();
        setReceivedFile(null);
        setProgress(0);
      }
      // If result.canceled === true (OS file picker canceled), do NOTHING!
      // The banner, OPFS binary, and IndexedDB metadata remain intact.
    } catch (err) {
      alert("Failed to save file: " + err.message);
    }
  };

  const handleLeave = async () => {
    // Delete target OPFS file if present
    if (receivedFile?.fileId && webrtcManagerRef.current) {
      await webrtcManagerRef.current.deleteOpfsFile(receivedFile.fileId);
    }

    if (webrtcManagerRef.current) {
      webrtcManagerRef.current.cleanup();
    }

    await clearSessionState();
    leaveRoom();
    setReceivedFile(null);
    setProgress(0);
    setActiveSenderFile(null);
    setSavedSession(null);
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <h1>SyncDrop</h1>
        <p>Encrypted Peer-to-Peer File Transfer Engine</p>
      </header>

      {!roomId ? (
        <RoomSetup
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          savedSession={savedSession}
          onRestoreSession={handleRestoreSession}
          onDiscardSession={handleDiscardSession}
          error={error}
        />
      ) : (
        <FileTransfer
          roomId={roomId}
          connectionState={connectionState}
          peerJoined={peerJoined}
          peerDisconnected={peerDisconnected}
          progress={progress}
          initialFile={activeSenderFile}
          onSendFile={handleSendFile}
          receivedFile={receivedFile}
          onDownloadFile={handleDownloadFile}
          onLeaveRoom={handleLeave}
          isReconnecting={isReconnecting}
          reconnectFailed={reconnectFailed}
          reconnectAttempt={reconnectAttempt}
          onManualReconnect={manualReconnect}
          onResetProgress={() => setProgress(0)}
        />
      )}
    </div>
  );
}
