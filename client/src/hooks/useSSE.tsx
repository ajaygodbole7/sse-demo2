import { NativeEventSource, EventSourcePolyfill } from "event-source-polyfill";
import {
  useEffect,
  useRef,
  createContext,
  FC,
  PropsWithChildren,
  useContext,
  useCallback,
  useState,
  useMemo,
} from "react";

/**
 * SSE Connection Manager
 *
 * Manages SSE connection lifecycle with a reactive signal (instanceId) that
 * ensures ALL micro-frontends rebind their listeners simultaneously when
 * the connection is recreated.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │                    The iOS Safari Problem                          │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │ Symptom: Tasks widget works, Notifications widget stops receiving events    │
 * │                                                                             │
 * │ Root Cause:                                                                 │
 * │ - Connection recreated after background/error                              │
 * │ - If instanceId updates AFTER EventSource is created (e.g., in onopen)     │
 * │ - There's a timing gap where events arrive before listeners are rebound    │
 * │ - One widget catches events by luck, the other misses them                 │
 * │                                                                             │
 * │ Solution:                                                                   │
 * │ - Update instanceId IMMEDIATELY when new EventSource is created            │
 * │ - This triggers synchronous re-render in ALL consumers                     │
 * │ - All consumer effects re-run and bind listeners BEFORE events arrive      │
 * │ - No timing gap, no race condition                                         │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */

interface SSEContextValue {
  /**
   * The current EventSource instance (or null if disconnected).
   * Use this to add/remove event listeners.
   */
  esRef: React.RefObject<EventSourcePolyfill | null>;

  /**
   * Increments IMMEDIATELY when a new connection is created.
   * Use this in useEffect deps to rebind listeners on reconnect.
   *
   * CRITICAL: This updates synchronously when EventSource is created,
   * NOT when onopen fires. This eliminates the timing gap that causes
   * the iOS Safari issue.
   */
  instanceId: number;
}

const SSEContext = createContext<SSEContextValue | null>(null);

interface SSEProviderProps {
  notificationsHost: string;
  path?: string;
  queryString?: string;
  backgroundThresholdMs?: number;
}

export const SSEContextProvider: FC<PropsWithChildren<SSEProviderProps>> = ({
  children,
  notificationsHost,
  path = "/v1/sse/connect",
  queryString,
  backgroundThresholdMs = 10000,
}) => {
  // ─────────────────────────────────────────────────────────────────────────────
  // State & Refs
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * REACTIVE: Triggers re-render in ALL consumers when connection changes.
   * Updated IMMEDIATELY when new EventSource is created.
   */
  const [instanceId, setInstanceId] = useState(0);

  const eventSourceRef = useRef<EventSourcePolyfill | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const attemptCountRef = useRef(0);
  const hiddenAtRef = useRef<number | null>(null);

  // Props in refs to avoid stale closures
  const hostRef = useRef(notificationsHost);
  const pathRef = useRef(path);
  const queryRef = useRef(queryString);
  const backgroundThresholdRef = useRef(backgroundThresholdMs);
  const connectRef = useRef<() => void>(() => { });

  useEffect(() => {
    hostRef.current = notificationsHost;
    pathRef.current = path;
    queryRef.current = queryString;
    backgroundThresholdRef.current = backgroundThresholdMs;
  }, [notificationsHost, path, queryString, backgroundThresholdMs]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const closeCurrent = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  const connect = useCallback(() => {
    closeCurrent();
    clearRetryTimer();

    attemptCountRef.current += 1;

    const EventSourceCtor = NativeEventSource || EventSourcePolyfill;

    const url = new URL(`${ hostRef.current }${ pathRef.current }`);
    if (queryRef.current) {
      const params = new URLSearchParams(queryRef.current);
      params.forEach((value, key) => url.searchParams.set(key, value));
    }

    const es = new EventSourceCtor(url.toString(), {
      withCredentials: true,
      heartbeatTimeout: 410000,
    }) as EventSourcePolyfill;

    // ┌─────────────────────────────────────────────────────────────────────────┐
    // │ CRITICAL: Update instanceId IMMEDIATELY, BEFORE publishing the ref.    │
    // │                                                                         │
    // │ This ensures:                                                           │
    // │ 1. setInstanceId triggers re-render in all consumers                   │
    // │ 2. During re-render, esRef.current is updated                          │
    // │ 3. Consumer effects run with new instanceId AND new esRef.current      │
    // │ 4. Listeners are bound BEFORE any events can arrive                    │
    // │                                                                         │
    // │ Previous bug: instanceId updated in onopen (too late!)                 │
    // │ - Events could arrive between ES creation and onopen                   │
    // │ - Some widgets caught them, others missed them                         │
    // └─────────────────────────────────────────────────────────────────────────┘

    // Publish instance to ref
    eventSourceRef.current = es;

    // IMMEDIATELY notify consumers (this is the fix!)
    setInstanceId((id) => id + 1);

    es.onopen = () => {
      // Reset backoff on successful connection
      attemptCountRef.current = 0;
      // Note: instanceId already updated above, no need to update here
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      const attempt = attemptCountRef.current;
      const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt - 1, 5)));

      clearRetryTimer();
      retryTimerRef.current = window.setTimeout(() => {
        connectRef.current();
      }, delay);
    };
  }, [closeCurrent, clearRetryTimer]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle effect
  // ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    connect();

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }

      if (document.visibilityState === "visible") {
        const es = eventSourceRef.current;
        const hiddenAt = hiddenAtRef.current;
        hiddenAtRef.current = null;

        if (!es || es.readyState === 2) {
          clearRetryTimer();
          connectRef.current();
          return;
        }

        if (hiddenAt !== null) {
          const hiddenDuration = Date.now() - hiddenAt;
          const threshold = backgroundThresholdRef.current;

          if (threshold === 0 || hiddenDuration > threshold) {
            closeCurrent();
            clearRetryTimer();
            connectRef.current();
          }
        }
      }
    };

    const onOnline = () => {
      closeCurrent();
      clearRetryTimer();
      connectRef.current();
    };

    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      navigator.sendBeacon(`${ hostRef.current }/v1/sse/disconnect`);
      closeCurrent();
    };

    const onBeforeUnload = () => {
      navigator.sendBeacon(`${ hostRef.current }/v1/sse/disconnect`);
      closeCurrent();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      clearRetryTimer();
      closeCurrent();
    };
  }, [connect, clearRetryTimer, closeCurrent]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Context value
  // ─────────────────────────────────────────────────────────────────────────────

  const contextValue = useMemo<SSEContextValue>(
    () => ({
      esRef: eventSourceRef,
      instanceId,
    }),
    [instanceId]
  );

  return <SSEContext.Provider value={contextValue}>{children}</SSEContext.Provider>;
};

/**
 * Hook for micro-frontends to access the shared SSE connection.
 *
 * @returns {SSEContextValue}
 * - esRef: RefObject to the EventSource instance
 * - instanceId: Number that changes when connection is recreated
 *
 * CRITICAL USAGE PATTERN:
 * Always include `instanceId` in useEffect dependencies!
 *
 * @example
 * ```tsx
 * function NotificationsWidget() {
 *   const { esRef, instanceId } = useSSE();
 *   const [notifications, setNotifications] = useState([]);
 *
 *   useEffect(() => {
 *     const es = esRef.current;
 *     if (!es) return;
 *
 *     const handler = (evt: MessageEvent) => {
 *       const data = JSON.parse(evt.data);
 *       setNotifications(prev => [data, ...prev]);
 *     };
 *
 *     es.addEventListener("notification", handler);
 *     return () => es.removeEventListener("notification", handler);
 *   }, [instanceId]); // ← CRITICAL: ensures rebind on reconnect
 *
 *   return <ul>{notifications.map(n => <li key={n.id}>{n.title}</li>)}</ul>;
 * }
 * ```
 */
export const useSSE = (): SSEContextValue => {
  const context = useContext(SSEContext);
  if (!context) {
    throw new Error("useSSE must be used within an SSEContextProvider");
  }
  return context;
};