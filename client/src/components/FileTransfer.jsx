import React, { useState, useRef, useEffect } from "react";

export function FileTransfer({
  roomId,
  connectionState,
  peerJoined,
  peerDisconnected,
  progress,
  initialFile,
  onSendFile,
  receivedFile,
  onDownloadFile,
  onLeaveRoom,
  isReconnecting,
  reconnectFailed,
  reconnectAttempt,
  onManualReconnect,
  onResetProgress, // <-- New prop passed from App.jsx
}) {
  const [selectedFile, setSelectedFile] = useState(initialFile || null);
  const [isDragging, setIsDragging] = useState(false);
  const [dismissReceived, setDismissReceived] = useState(false);
  const [transferSpeed, setTransferSpeed] = useState(0);
  const [eta, setEta] = useState(null);

  const lastProgressRef = useRef({ progress: 0, time: Date.now() });
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (receivedFile) {
      setDismissReceived(false);
    }
  }, [receivedFile]);

  useEffect(() => {
    const totalSizeBytes = selectedFile?.size || receivedFile?.fileSize || null;
    if (progress > 0 && progress < 100 && totalSizeBytes) {
      const now = Date.now();
      const timeDiff = (now - lastProgressRef.current.time) / 1000;
      const progressDiff = progress - lastProgressRef.current.progress;

      if (timeDiff >= 0.5 && progressDiff > 0) {
        const bytesTransferred = (progressDiff / 100) * totalSizeBytes;
        const speed = bytesTransferred / timeDiff;
        const remainingBytes = ((100 - progress) / 100) * totalSizeBytes;
        const remainingTime = speed > 0 ? Math.ceil(remainingBytes / speed) : 0;

        setTransferSpeed(speed);
        setEta(remainingTime);
        lastProgressRef.current = { progress, time: now };
      }
    } else if (progress === 0 || progress === 100) {
      setTransferSpeed(0);
      setEta(null);
      lastProgressRef.current = { progress: 0, time: Date.now() };
    }
  }, [progress, selectedFile, receivedFile]);

  // Helper to handle new file selection and reset state
  const handleNewFileSelection = (file) => {
    setSelectedFile(file);
    setDismissReceived(true); // Hide download card to reveal sending controls
    if (onResetProgress) onResetProgress(); // Reset progress in parent state
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleNewFileSelection(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      handleNewFileSelection(e.target.files[0]);
    }
  };

  const handleSendClick = () => {
    if (selectedFile && onSendFile) {
      onSendFile(selectedFile);
    }
  };

  const formatBytes = (bytes) => {
    if (bytes === 0 || !bytes) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatEta = (seconds) => {
    if (seconds === null || seconds === undefined) return "";
    if (seconds < 60) return `${seconds}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s remaining`;
  };

  const isTransferring = progress > 0 && progress < 100;
  const isTransferComplete = progress === 100;
  const isReadyToSend =
    peerJoined && connectionState === "connected" && !isReconnecting;
  const isSender = Boolean(selectedFile);

  return (
    <div className="transfer-card">
      <div className="transfer-header">
        <div className="room-info">
          <span className="label">Room Code: </span>
          <span className="room-code">{roomId}</span>
          <button
            className="btn-copy"
            onClick={() => navigator.clipboard.writeText(roomId)}
            title="Copy Code"
          >
            Copy
          </button>
        </div>
        <button className="btn-leave" onClick={onLeaveRoom}>
          Leave Room
        </button>
      </div>

      {/* Connection Status Banner */}
      <div className={`status-badge status-${connectionState}`}>
        {isReconnecting ? (
          <span>
            ⚠️ Reconnecting to server... (Attempt {reconnectAttempt}/5)
          </span>
        ) : reconnectFailed ? (
          <div className="reconnect-failed-box">
            <span>🔴 Connection lost. Reconnect failed.</span>
            <button
              className="btn btn-warning btn-sm"
              onClick={onManualReconnect}
              disabled={isReconnecting}
            >
              {isReconnecting ? "Retrying..." : "Reconnect"}
            </button>
          </div>
        ) : peerDisconnected ? (
          "Partner lost connection. Waiting for auto-reconnect..."
        ) : !peerJoined || connectionState === "peer-absent" ? (
          "Waiting for peer to join room..."
        ) : connectionState === "connected" ? (
          "Connected & Ready for Stream Transfer"
        ) : (
          `Connection Status: ${connectionState}`
        )}
      </div>

      {receivedFile && !dismissReceived ? (
        <div className="download-card success-box">
          <div className="download-icon">📥</div>
          <div className="download-details">
            <h3>File Received Successfully!</h3>
            <p>
              <strong>{receivedFile.fileName}</strong> (
              {formatBytes(receivedFile.fileSize)})
            </p>
          </div>
          <div className="download-actions">
            <button className="btn btn-success" onClick={onDownloadFile}>
              Save File
            </button>
            <button
              className="btn btn-outline-success"
              onClick={() => {
                setDismissReceived(true);
                setSelectedFile(null);
                if (onResetProgress) onResetProgress();
              }}
            >
              Send a File →
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`dropzone ${isDragging ? "dragging" : ""} ${
            !isReadyToSend ? "disabled" : ""
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => isReadyToSend && fileInputRef.current?.click()}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            className="hidden-file-input"
            disabled={!isReadyToSend}
          />
          <div className="dropzone-content">
            <div className="upload-icon">📁</div>
            {selectedFile ? (
              <div className="selected-file-info">
                <span className="file-name">{selectedFile.name}</span>
                <span className="file-size">
                  {formatBytes(selectedFile.size)}
                </span>
              </div>
            ) : (
              <>
                <p className="primary-text">
                  {isReadyToSend
                    ? "Drag & drop a file here, or click to browse"
                    : "Connect with a partner to enable file transfers"}
                </p>
                <p className="secondary-text">
                  Streams directly peer-to-peer via OPFS disk engine.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Action Button: Visible whenever a file is chosen and download card is dismissed */}
      {selectedFile && (dismissReceived || !receivedFile) && (
        <div className="action-bar">
          <button
            className="btn btn-primary btn-full"
            onClick={handleSendClick}
            disabled={!isReadyToSend || isTransferring}
          >
            {isTransferring
              ? "Transferring..."
              : isTransferComplete
                ? "Send Selected File"
                : `Send ${selectedFile.name}`}
          </button>
        </div>
      )}

      {progress > 0 && (
        <div className="progress-section">
          <div
            className={`progress-labels ${
              isTransferComplete ? "text-success" : ""
            }`}
          >
            <span>
              {isTransferComplete
                ? isSender
                  ? "Transfer Complete!"
                  : "Assembling file from OPFS storage..."
                : `Transferring ${
                    isTransferring && transferSpeed > 0
                      ? `(${formatBytes(transferSpeed)}/s)`
                      : ""
                  }`}
            </span>
            <span>
              {progress}% {isTransferring && eta !== null ? formatEta(eta) : ""}
            </span>
          </div>
          <div className="progress-bar-bg">
            <div
              className={`progress-bar-fill ${
                isTransferComplete ? "bg-success" : ""
              }`}
              style={{ width: `${progress}%` }}
            ></div>
          </div>
        </div>
      )}
    </div>
  );
}
