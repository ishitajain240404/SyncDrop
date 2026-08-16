// useSignaling.js
import { useState, useEffect, useRef, useCallback } from "react";

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL;
const MAX_RETRY_ATTEMPTS = 5;

export function useSignaling(webrtcManagerRef) {
  const [isConnected, setIsConnected] = useState(false);
  const [roomId, setRoomId] = useState(null);
  const [clientId, setClientId] = useState(null);
  const [isInitiator, setIsInitiator] = useState(false);
  const [peerJoined, setPeerJoined] = useState(false);
  const [peerDisconnected, setPeerDisconnected] = useState(false);
  const [error, setError] = useState(null);

  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectFailed, setReconnectFailed] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const wsRef = useRef(null);
  const signalHandlerRef = useRef(null);
  const currentRoomIdRef = useRef(null);
  const retryCountRef = useRef(0);
  const isIntentionalCloseRef = useRef(false);

  useEffect(() => {
    currentRoomIdRef.current = roomId;
  }, [roomId]);

  const connect = useCallback(() => {
    isIntentionalCloseRef.current = false;

    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setIsReconnecting(false);
      setReconnectFailed(false);
      retryCountRef.current = 0;
      setReconnectAttempt(0);
      setError(null);

      // Re-join room on WebSocket reconnection
      if (currentRoomIdRef.current) {
        ws.send(
          JSON.stringify({
            type: "join-room",
            roomId: currentRoomIdRef.current,
          }),
        );
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case "room-joined": {
            setRoomId(message.roomId);
            setClientId(message.clientId);
            setIsInitiator(message.isInitiator);
            setPeerDisconnected(false);

            const hasPeer = !!message.peerJoined;
            setPeerJoined(hasPeer);

            if (webrtcManagerRef?.current) {
              webrtcManagerRef.current.setRemotePeerPresent(hasPeer);
            }
            break;
          }

          case "role-update": {
            setIsInitiator(message.isInitiator);
            if (message.peerDisconnected) {
              setPeerDisconnected(true);
              setPeerJoined(false);

              if (webrtcManagerRef?.current) {
                webrtcManagerRef.current.setRemotePeerPresent(false);
              }
            }
            break;
          }

          case "peer-joined": {
            setPeerJoined(true);
            setPeerDisconnected(false);

            if (webrtcManagerRef?.current) {
              webrtcManagerRef.current.setRemotePeerPresent(true);
            }
            break;
          }

          case "peer-disconnected": {
            setPeerDisconnected(true);
            setPeerJoined(false);

            if (webrtcManagerRef?.current) {
              webrtcManagerRef.current.setRemotePeerPresent(false);
            }
            break;
          }

          case "signal": {
            if (webrtcManagerRef?.current) {
              webrtcManagerRef.current.handleSignal(message.signalData);
            }
            if (signalHandlerRef.current) {
              signalHandlerRef.current(message.signalData);
            }
            break;
          }

          case "error": {
            setError(message.message);
            break;
          }

          default:
            break;
        }
      } catch (err) {
        console.error("Failed to parse incoming signaling message:", err);
      }
    };

    ws.onerror = () => {
      setError("Signaling connection error.");
    };

    ws.onclose = () => {
      setIsConnected(false);

      if (isIntentionalCloseRef.current) {
        return;
      }

      if (retryCountRef.current < MAX_RETRY_ATTEMPTS) {
        setIsReconnecting(true);
        retryCountRef.current += 1;
        setReconnectAttempt(retryCountRef.current);

        const timeout = Math.min(
          1000 * Math.pow(2, retryCountRef.current),
          10000,
        );
        setTimeout(() => {
          connect();
        }, timeout);
      } else {
        setIsReconnecting(false);
        setReconnectFailed(true);
      }
    };
  }, [webrtcManagerRef]);

  // Online status event listener logic
  useEffect(() => {
    const checkAndRecoverConnection = () => {
      console.log("[Network/Lifecycle] Checking connection health...");

      const rtcManager = webrtcManagerRef?.current;
      const pc = rtcManager?.peerConnection;

      const isWsConnected =
        wsRef.current && wsRef.current.readyState === WebSocket.OPEN;

      // 1. If WebSocket is down, reconnect WebSocket first.
      if (!isWsConnected) {
        console.log(
          "[Network] WebSocket disconnected. Reconnecting WebSocket...",
        );
        connect();
        return;
      }

      // 2. Check WebRTC status only if remote peer is present
      if (rtcManager && rtcManager.isRemotePeerPresent) {
        const rtcState = pc?.connectionState;
        const iceState = pc?.iceConnectionState;
        const isHealthy = rtcState === "connected" && iceState === "connected";

        if (!isHealthy) {
          console.log(
            `[Network] WebRTC needs recovery (State: ${rtcState}, ICE: ${iceState}). Triggering ICE restart...`,
          );
          rtcManager.restartIce();
        }
      } else {
        console.log(
          "[Network] Remote peer not in room. Skipping WebRTC recovery.",
        );
      }
    };

    const handleOnline = () => {
      console.log("[Network] Device back online.");
      checkAndRecoverConnection();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log("[Lifecycle] Tab came back to foreground.");
        checkAndRecoverConnection();
      }
    };

    const handleOffline = () => {
      console.warn("[Network] Device went offline!");
      setIsConnected(false);
      setPeerDisconnected(true);

      const rtcManager = webrtcManagerRef?.current;
      if (rtcManager) {
        rtcManager.setRemotePeerPresent(false);
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [connect, webrtcManagerRef]);

  useEffect(() => {
    connect();

    return () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        isIntentionalCloseRef.current = true;
        wsRef.current.close();
      }
    };
  }, [connect]);

  const joinRoom = useCallback(
    (targetRoomId = null) => {
      isIntentionalCloseRef.current = false;

      if (
        !wsRef.current ||
        wsRef.current.readyState === WebSocket.CLOSED ||
        wsRef.current.readyState === WebSocket.CLOSING
      ) {
        currentRoomIdRef.current = targetRoomId;
        connect();
        return;
      }

      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "join-room",
            roomId: targetRoomId,
          }),
        );
      }
    },
    [connect],
  );

  const sendSignal = useCallback((signalData) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "signal",
          signalData: signalData,
        }),
      );
    }
  }, []);

  const onSignal = useCallback((handler) => {
    signalHandlerRef.current = handler;
  }, []);

  const leaveRoom = useCallback(() => {
    isIntentionalCloseRef.current = true;
    if (wsRef.current) {
      wsRef.current.close();
    }
    setRoomId(null);
    setClientId(null);
    setIsInitiator(false);
    setPeerJoined(false);
    setPeerDisconnected(false);
    currentRoomIdRef.current = null;

    if (webrtcManagerRef?.current) {
      webrtcManagerRef.current.setRemotePeerPresent(false);
    }
  }, [webrtcManagerRef]);

  const manualReconnect = useCallback(() => {
    retryCountRef.current = 0;
    setReconnectAttempt(0);
    setReconnectFailed(false);
    setIsReconnecting(true);
    connect();
  }, [connect]);

  return {
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
  };
}
