import React, { useState } from "react";

export function RoomSetup({
  onCreateRoom,
  onJoinRoom,
  savedSession,
  onRestoreSession,
  onDiscardSession,
  error,
}) {
  const [inputRoomId, setInputRoomId] = useState("");

  const handleJoinSubmit = (e) => {
    e.preventDefault();
    if (inputRoomId.trim()) {
      onJoinRoom(inputRoomId.trim());
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const hasPendingSenderFile = Boolean(savedSession?.senderFile);

  return (
    <div className="lobby-card">
      <h2>Welcome to SyncDrop</h2>
      <p className="subtitle">
        Secure, fast, peer-to-peer file sharing directly between browsers.
      </p>

      {error && <div className="error-banner">{error}</div>}

      {/* DISCONNECTION / RESTORATION PROMPT */}
      {savedSession && (
        <div className="restore-session-card">
          <div className="restore-header">
            <h3>⚠️ Previous Session Found</h3>
            <p>
              You were connected to room <strong>{savedSession.roomId}</strong>.
            </p>
          </div>

          {hasPendingSenderFile && (
            <div className="restore-file-details">
              <span>Unfinished Upload: </span>
              <strong>{savedSession.senderFile.name}</strong> (
              {formatBytes(savedSession.senderFile.size)})
            </div>
          )}

          <div className="restore-actions">
            <button
              className="btn btn-success btn-full"
              onClick={() => onRestoreSession(true)}
            >
              {hasPendingSenderFile
                ? "Rejoin & Resume Sending File"
                : `Rejoin Room ${savedSession.roomId}`}
            </button>

            {hasPendingSenderFile && (
              <button
                className="btn btn-outline-secondary btn-full"
                onClick={() => onRestoreSession(false)}
              >
                Rejoin Room Only (Discard File)
              </button>
            )}

            <button
              className="btn btn-link btn-full"
              onClick={onDiscardSession}
            >
              Dismiss & Start New Session
            </button>
          </div>
        </div>
      )}

      <div className="lobby-actions">
        <button className="btn btn-primary" onClick={onCreateRoom}>
          Create New Room
        </button>
        <div className="divider">OR</div>
        <form onSubmit={handleJoinSubmit} className="join-form">
          <input
            type="text"
            maxLength="6"
            placeholder="Enter 6-char Room Code"
            value={inputRoomId}
            onChange={(e) => setInputRoomId(e.target.value)}
            required
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!inputRoomId.trim()}
          >
            Join Room
          </button>
        </form>
      </div>
    </div>
  );
}
