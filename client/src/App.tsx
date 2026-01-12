import { useCallback, useEffect, useState } from "react";
import type { EventSourcePolyfill } from "event-source-polyfill";
import { SSEContextProvider, useSSE } from "./hooks/useSSE";

/**
 * SSE Diagnostics & Consumer Contract Demo
 *
 * This app demonstrates:
 * 1. The correct consumer pattern for using the SSE hook
 * 2. Connection status monitoring
 * 3. Error handling for event parsing
 * 4. How instanceId ensures reliable listener rebinding
 *
 * The key insight: instanceId changes IMMEDIATELY when a new connection is created,
 * triggering re-render in all consumers. Their useEffect hooks re-run and bind
 * listeners to the new EventSource BEFORE any events arrive.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

type BaseEvent = {
  connectionId: string;
  utcIso: string;
  epochMs: number;
};

type Task = BaseEvent & {
  type: "task";
  taskId: string;
  title: string;
  amount: number;
  receivedAt: number;
};

type Notification = BaseEvent & {
  type: "notification";
  notificationId: string;
  title: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  receivedAt: number;
};

type RequestDebug = {
  host?: string;
  origin?: string;
  userAgent?: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
  secFetchDest?: string;
  secFetchMode?: string;
  secFetchSite?: string;
  hasCookieHeader?: boolean;
  cookieBytes?: number;
};

type Connected = BaseEvent & {
  type: "connected";
  lastEventId: number;
  request?: RequestDebug;
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safe JSON parse with type guard.
 * Returns null on parse failure instead of throwing.
 */
function safeJsonParse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Format epoch timestamp to local time string.
 */
function formatTimeMs(epochMs: number): string {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${ time }.${ ms }`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Status Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Displays connection status and instanceId for debugging.
 *
 * This component shows:
 * - Whether EventSource is attached
 * - Current instanceId (increments on each reconnect)
 * - Connection state (CONNECTING/OPEN/CLOSED)
 * - Server-reported connection ID
 */
function ConnectionStatus() {
  const { esRef, instanceId } = useSSE();
  const [readyState, setReadyState] = useState<number | null>(null);
  const [serverConnectionId, setServerConnectionId] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  useEffect(() => {
    const es = esRef.current;
    if (!es) {
      setReadyState(null);
      return;
    }

    // Update readyState on open/error
    const updateState = () => setReadyState(es.readyState);
    es.addEventListener("open", updateState);
    es.addEventListener("error", updateState);

    // Capture server connection ID from "connected" event
    const onConnected = (evt: MessageEvent) => {
      const data = safeJsonParse<Connected>(evt.data);
      if (data?.type === "connected") {
        setServerConnectionId(data.connectionId);
        setLastEventAt(formatTimeMs(Date.now()));
      }
    };
    es.addEventListener("connected", onConnected as EventListener);

    // Track any event arrival
    const onAnyEvent = () => setLastEventAt(formatTimeMs(Date.now()));
    es.addEventListener("task", onAnyEvent as EventListener);
    es.addEventListener("notification", onAnyEvent as EventListener);

    // Initial state
    setReadyState(es.readyState);

    return () => {
      es.removeEventListener("open", updateState);
      es.removeEventListener("error", updateState);
      es.removeEventListener("connected", onConnected as EventListener);
      es.removeEventListener("task", onAnyEvent as EventListener);
      es.removeEventListener("notification", onAnyEvent as EventListener);
    };
  }, [instanceId]); // ← Re-run when connection changes

  const readyStateLabel = {
    0: "CONNECTING",
    1: "OPEN",
    2: "CLOSED",
  }[readyState ?? -1] ?? "NO CONNECTION";

  const statusColor = {
    0: "text-yellow-600",
    1: "text-green-600",
    2: "text-red-600",
  }[readyState ?? -1] ?? "text-gray-500";

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-lg font-semibold">Connection Status</h2>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600">Status:</span>
          <span className={`font-mono font-medium ${ statusColor }`}>
            {readyStateLabel}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-600">Instance ID:</span>
          <span className="font-mono font-medium text-blue-600">
            {instanceId}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-600">Server Connection:</span>
          <span className="font-mono text-xs">
            {serverConnectionId ?? "—"}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-600">Last Event:</span>
          <span className="font-mono">{lastEventAt ?? "—"}</span>
        </div>
      </div>

      <div className="mt-4 rounded bg-blue-50 p-2 text-xs text-blue-800">
        <strong>Tip:</strong> instanceId increments on each reconnect.
        All widgets should rebind their listeners when this changes.
      </div>
    </div>
  );
}

const DetailRow: React.FC<{ label: string; value?: string | boolean | number }> = ({
  label,
  value
}) => (
  <div className="flex justify-between text-sm">
    <span className="text-gray-600">{label}:</span>
    <span
      className="font-mono text-xs truncate max-w-[180px]"
      title={value !== undefined ? String(value) : undefined}
    >
      {value ?? "—"}
    </span>
  </div>
);

function BrowserDetails() {
  const { esRef, instanceId } = useSSE();
  const [request, setRequest] = useState<RequestDebug | null>(null);

  useEffect(() => {
    const es = esRef.current;
    if (!es) return;

    const handler = (evt: MessageEvent) => {
      const data = safeJsonParse<Connected>(evt.data);
      if (data?.type === "connected" && data.request) {
        setRequest(data.request);
      }
    };

    es.addEventListener("connected", handler as EventListener);
    return () => es.removeEventListener("connected", handler as EventListener);
  }, [instanceId]);

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-lg font-semibold">Browser Details (Server-Seen)</h2>

      {!request ? (
        <p className="text-sm text-gray-500">Waiting for connected event...</p>
      ) : (
        <div className="space-y-2">
          <DetailRow label="Origin" value={request.origin} />
          <DetailRow label="User-Agent" value={request.userAgent?.slice(0, 40)} />
          <DetailRow label="sec-ch-ua" value={request.secChUa?.slice(0, 40)} />
          <DetailRow label="sec-ch-ua-platform" value={request.secChUaPlatform} />
          <DetailRow label="sec-ch-ua-mobile" value={request.secChUaMobile} />
          <DetailRow label="sec-fetch-mode" value={request.secFetchMode} />
          <DetailRow label="Credentials sent" value={request.hasCookieHeader ? "Yes" : "No"} />
        </div>
      )}

      <div className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-800">
        <strong>Tip:</strong> Safari/iOS won't show sec-ch-* headers (no client hints support).
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Tasks Widget (Correct Pattern)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tasks Widget - demonstrates the CORRECT consumer pattern.
 *
 * Key points:
 * 1. useSSE() returns { esRef, instanceId }
 * 2. useEffect has [instanceId] in deps → rebinds on reconnect
 * 3. Guard: if (!es) return → handles null during reconnect
 * 4. try/catch around JSON.parse → handles malformed data
 * 5. Cleanup function removes listener
 */
function TasksWidget() {
  const { esRef, instanceId } = useSSE();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);

  useEffect(() => {
    const es = esRef.current;

    // Guard: connection may be null during reconnect window
    if (!es) return;

    const handler = (evt: MessageEvent) => {
      const receivedAt = Date.now();
      const data = safeJsonParse<Omit<Task, "receivedAt">>(evt.data);

      if (!data || data.type !== "task") {
        setErrorCount((c) => c + 1);
        return;
      }

      setEventCount((c) => c + 1);
      setTasks((prev) => [{ ...data, receivedAt }, ...prev].slice(0, 20));
    };

    // Add listener to current EventSource instance
    es.addEventListener("task", handler as EventListener);

    // Cleanup: remove listener when effect re-runs or component unmounts
    return () => {
      es.removeEventListener("task", handler as EventListener);
    };
  }, [instanceId]); // ← CRITICAL: rebind when instanceId changes

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Tasks</h2>
        <div className="text-xs text-gray-500">
          events: {eventCount} | errors: {errorCount}
        </div>
      </div>

      {tasks.length === 0 ? (
        <p className="text-sm text-gray-500">Waiting for task events...</p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => {
            const latencyMs = t.receivedAt - t.epochMs;
            return (
              <li key={t.taskId} className="rounded border border-gray-100 bg-gray-50 p-2">
                <div>
                  <span className="font-medium">{t.title}</span>
                  <span className="font-bold"> · ${t.amount.toLocaleString()}</span>
                </div>
                <div className="text-xs text-gray-500">
                  server sent {formatTimeMs(t.epochMs)} · client received {formatTimeMs(t.receivedAt)} · latency {" "}
                  <span className={latencyMs > 100 ? "text-amber-600 font-medium" : "text-green-600 font-medium"}>
                    {latencyMs}ms
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications Widget (Correct Pattern)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notifications Widget - same correct pattern as Tasks.
 *
 * Having two widgets demonstrates that BOTH receive events after reconnect,
 * unlike the buggy pattern where one widget works but the other doesn't.
 */
function NotificationsWidget() {
  const { esRef, instanceId } = useSSE();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);

  useEffect(() => {
    const es = esRef.current;
    if (!es) return;

    const handler = (evt: MessageEvent) => {
      const receivedAt = Date.now();
      const data = safeJsonParse<Omit<Notification, "receivedAt">>(evt.data);

      if (!data || data.type !== "notification") {
        setErrorCount((c) => c + 1);
        return;
      }

      setEventCount((c) => c + 1);
      setNotifications((prev) => [{ ...data, receivedAt }, ...prev].slice(0, 20));
    };

    es.addEventListener("notification", handler as EventListener);
    return () => {
      es.removeEventListener("notification", handler as EventListener);
    };
  }, [instanceId]); // ← CRITICAL: must include instanceId

  const severityColors = {
    INFO: "bg-blue-100 text-blue-800",
    WARN: "bg-yellow-100 text-yellow-800",
    CRITICAL: "bg-red-100 text-red-800",
  };

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Notifications</h2>
        <div className="text-xs text-gray-500">
          events: {eventCount} | errors: {errorCount}
        </div>
      </div>

      {notifications.length === 0 ? (
        <p className="text-sm text-gray-500">
          Waiting for notification events...
        </p>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => {
            const latencyMs = n.receivedAt - n.epochMs;
            return (
              <li key={n.notificationId} className="rounded border border-gray-100 bg-gray-50 p-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${ severityColors[n.severity] }`}>
                    {n.severity}
                  </span>
                  <span className="font-medium">{n.title}</span>
                </div>
                <div className="text-xs text-gray-500">
                  server sent {formatTimeMs(n.epochMs)} · client received {formatTimeMs(n.receivedAt)} · latency {" "}
                  <span className={latencyMs > 100 ? "text-amber-600 font-medium" : "text-green-600 font-medium"}>
                    {latencyMs}ms
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-Pattern Demo (DO NOT USE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ ANTI-PATTERN DEMO - Shows the WRONG way to use the hook.
 *
 * This component intentionally omits instanceId from deps to demonstrate
 * the bug. After a reconnect, this widget will STOP receiving events.
 *
 * DO NOT copy this pattern!
 */
function BrokenWidget() {
  const { esRef } = useSSE(); // ← Note: not using instanceId
  const [events, setEvents] = useState<string[]>([]);
  const [isBroken, setIsBroken] = useState(false);

  useEffect(() => {
    const es = esRef.current;
    if (!es) return;

    const handler = (evt: MessageEvent) => {
      const data = safeJsonParse<{ type: string }>(evt.data);
      if (data) {
        setEvents((prev) =>
          [`${ data.type } @ ${ formatTimeMs(Date.now()) }`, ...prev].slice(0, 5)
        );
      }
    };

    // Listen to all event types
    es.addEventListener("task", handler as EventListener);
    es.addEventListener("notification", handler as EventListener);

    return () => {
      es.removeEventListener("task", handler as EventListener);
      es.removeEventListener("notification", handler as EventListener);
    };
  }, []); // ← BUG: Empty deps! Listener never rebinds on reconnect!

  // Detect when we've stopped receiving events
  useEffect(() => {
    const timeout = setTimeout(() => {
      setIsBroken(true);
    }, 15000);

    if (events.length > 0) {
      setIsBroken(false);
    }

    return () => clearTimeout(timeout);
  }, [events]);

  return (
    <div className="rounded-lg border-2 border-dashed border-red-300 bg-red-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-red-800">
          ⚠️ Broken Widget (Anti-Pattern)
        </h2>
        {isBroken && (
          <span className="rounded bg-red-600 px-2 py-0.5 text-xs text-white">
            STOPPED
          </span>
        )}
      </div>

      <div className="mb-3 rounded bg-red-100 p-2 text-xs text-red-800">
        <strong>Bug:</strong> This widget uses <code>[]</code> as deps instead
        of <code>[instanceId]</code>. After a reconnect, it stops receiving
        events because its listener is still attached to the old (dead)
        EventSource.
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-red-600">No events received yet...</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {events.map((e, i) => (
            <li key={i} className="text-red-700">
              {e}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 text-xs text-red-600">
        <strong>To test:</strong> Wait for events to flow, then stop/restart
        the server. This widget will stop updating while others continue.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App Component
// ─────────────────────────────────────────────────────────────────────────────

function DiagnosticsApp() {
  const [showBrokenWidget, setShowBrokenWidget] = useState(false);

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            SSE Connection Manager Demo
          </h1>
          <p className="mt-1 text-gray-600">
            Demonstrates the consumer contract for the SSE hook. All widgets
            should continue receiving events after reconnection.
          </p>
        </header>

        {/* Connection Status + Browser Details */}
        <div className="mb-6 grid gap-6 md:grid-cols-2">
          <ConnectionStatus />
          <BrowserDetails />
        </div>

        {/* Widget Grid */}
        <div className="grid gap-6 md:grid-cols-2">
          <TasksWidget />
          <NotificationsWidget />
        </div>

        {/* Anti-Pattern Demo Toggle */}
        <div className="mt-6">
          <button
            onClick={() => setShowBrokenWidget(!showBrokenWidget)}
            className="rounded bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
          >
            {showBrokenWidget ? "Hide" : "Show"} Anti-Pattern Demo
          </button>

          {showBrokenWidget && (
            <div className="mt-4">
              <BrokenWidget />
            </div>
          )}
        </div>

        {/* Consumer Contract Summary */}
        <div className="mt-6 rounded-lg border bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">Consumer Contract</h2>

          <div className="space-y-3 text-sm">
            <div className="rounded bg-gray-50 p-3">
              <div className="mb-2 font-medium">✅ Correct Pattern</div>
              <pre className="overflow-x-auto text-xs">
                {`const { esRef, instanceId } = useSSE();

useEffect(() => {
  const es = esRef.current;
  if (!es) return;

  const handler = (evt) => { /* ... */ };
  es.addEventListener("myevent", handler);
  return () => es.removeEventListener("myevent", handler);
}, [instanceId]); // ← CRITICAL`}
              </pre>
            </div>

            <div className="rounded bg-red-50 p-3">
              <div className="mb-2 font-medium text-red-800">
                ❌ Wrong Pattern
              </div>
              <pre className="overflow-x-auto text-xs text-red-700">
                {`useEffect(() => {
  // ...
}, []); // ← BUG: Won't rebind on reconnect!`}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// App Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <SSEContextProvider
      notificationsHost="http://localhost:3001"
      backgroundThresholdMs={10000}
    >
      <DiagnosticsApp />
    </SSEContextProvider>
  );
}