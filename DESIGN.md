# SSE Connection Manager for React Micro-Frontends

## Technical Design Document v2.0

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Architecture Overview](#2-architecture-overview)
3. [The Core Bug and Fix](#3-the-core-bug-and-fix)
4. [Consumer Contract](#4-consumer-contract)
5. [Anti-Patterns (What NOT To Do)](#5-anti-patterns-what-not-to-do)
6. [React Concepts Explained](#6-react-concepts-explained)
7. [iOS Safari Deep Dive](#7-ios-safari-deep-dive)
8. [Hook API Reference](#8-hook-api-reference)
9. [Server Requirements](#9-server-requirements)
10. [Testing Guide](#10-testing-guide)
11. [Troubleshooting](#11-troubleshooting)
12. [References](#12-references)

---

## 1. Problem Statement

### What We're Building

A React hook that manages Server-Sent Events (SSE) connections for micro-frontend architectures. Multiple independent UI widgets (Tasks, Notifications, Payments, etc.) share a single SSE connection.

### The Bug We Solved

| Browser | Tasks Widget | Notifications Widget |
|---------|--------------|---------------------|
| Chrome/Edge | ✅ Works | ✅ Works |
| iOS Safari (after reconnect) | ✅ Works | ❌ Stops receiving |

**Root Cause:** Race condition in listener rebinding when connection is recreated.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              React Application                               │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     SSEContextProvider                                  │ │
│  │                    (Connection Manager)                                 │ │
│  │                                                                         │ │
│  │   Provides: { esRef, instanceId }                                       │ │
│  │                                                                         │ │
│  │   Responsibilities:                                                     │ │
│  │   ├── Create/manage EventSource instance                                │ │
│  │   ├── Reconnect on error (exponential backoff)                          │ │
│  │   ├── Handle iOS Safari background suspension                           │ │
│  │   ├── Handle network transitions (WiFi ↔ cellular)                      │ │
│  │   └── Update instanceId IMMEDIATELY on new connection                   │ │
│  │                                                                         │ │
│  │   NOT Responsible For:                                                  │ │
│  │   ├── Event parsing (consumers do this)                                 │ │
│  │   ├── Event routing (consumers subscribe directly)                      │ │
│  │   └── Business logic (consumers own this)                               │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│                    Context Value: { esRef, instanceId }                      │
│                                    │                                         │
│          ┌─────────────────────────┼─────────────────────────┐              │
│          ▼                         ▼                         ▼              │
│  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐        │
│  │ Tasks Widget │         │ Notif Widget │         │Payment Widget│        │
│  │ (MicroFE A)  │         │ (MicroFE B)  │         │ (MicroFE C)  │        │
│  │              │         │              │         │              │        │
│  │ useEffect    │         │ useEffect    │         │ useEffect    │        │
│  │ deps:        │         │ deps:        │         │ deps:        │        │
│  │ [instanceId] │         │ [instanceId] │         │ [instanceId] │        │
│  │      ↓       │         │      ↓       │         │      ↓       │        │
│  │ Subscribes   │         │ Subscribes   │         │ Subscribes   │        │
│  │ to "task"    │         │ to "notif"   │         │ to "payment" │        │
│  └──────────────┘         └──────────────┘         └──────────────┘        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP (text/event-stream)
                                    ▼
                         ┌─────────────────────┐
                         │     SSE Server      │
                         │                     │
                         │ Emits named events: │
                         │ ├── task            │
                         │ ├── notification    │
                         │ └── payment         │
                         └─────────────────────┘
```

---

## 3. The Core Bug and Fix

### 3.1 The Buggy Code

```typescript
const connect = useCallback(() => {
  const es = new EventSourceCtor(url);
  eventSourceRef.current = es;        // ← Step 1: Instance published
  
  es.onopen = () => {
    setInstanceId((id) => id + 1);    // ← Step 2: TOO LATE!
  };
});
```

### 3.2 Timeline: Why This Fails

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           BUGGY TIMELINE                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Time │ Action                        │ Tasks Listener  │ Notif Listener      │
│──────┼───────────────────────────────┼─────────────────┼─────────────────────│
│ T0   │ new EventSource()             │ (on OLD inst)   │ (on OLD inst)       │
│ T1   │ esRef.current = newES         │ (on OLD inst)   │ (on OLD inst)       │
│ T2   │ HTTP handshake completes      │ (on OLD inst)   │ (on OLD inst)       │
│ T3   │ Server sends "task" event     │ ❌ MISSED       │ -                   │
│ T4   │ Server sends "notification"   │ -               │ ❌ MISSED           │
│ T5   │ onopen fires                  │ (on OLD inst)   │ (on OLD inst)       │
│ T6   │ setInstanceId(2)              │ → re-renders    │ → re-renders        │
│ T7   │ Effects re-run, rebind        │ (on NEW inst)   │ (on NEW inst)       │
│ T8   │ Server sends "task"           │ ✅ received     │ -                   │
│ T9   │ Server sends "notification"   │ -               │ ✅ received         │
│                                                                               │
│ RESULT: Events at T3-T4 were LOST. Both widgets missed their first event.    │
│         Due to timing, one widget might catch T8/T9 while other still misses.│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 The Fixed Code

```typescript
const connect = useCallback(() => {
  const es = new EventSourceCtor(url);
  eventSourceRef.current = es;        // ← Step 1: Instance published
  setInstanceId((id) => id + 1);      // ← Step 2: IMMEDIATELY notify!
  
  es.onopen = () => {
    attemptCountRef.current = 0;      // Just reset backoff, no instanceId
  };
});
```

### 3.4 Timeline: Why This Works

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            FIXED TIMELINE                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Time │ Action                        │ Tasks Listener  │ Notif Listener      │
│──────┼───────────────────────────────┼─────────────────┼─────────────────────│
│ T0   │ new EventSource()             │ (on OLD inst)   │ (on OLD inst)       │
│ T1   │ esRef.current = newES         │ (on OLD inst)   │ (on OLD inst)       │
│ T2   │ setInstanceId(2)              │ → re-renders    │ → re-renders        │
│ T3   │ Effects re-run, rebind        │ (on NEW inst)   │ (on NEW inst)       │
│ T4   │ HTTP handshake completes      │ (on NEW inst)   │ (on NEW inst)       │
│ T5   │ Server sends "task" event     │ ✅ RECEIVED     │ -                   │
│ T6   │ Server sends "notification"   │ -               │ ✅ RECEIVED         │
│ T7   │ onopen fires                  │ (already bound) │ (already bound)     │
│                                                                               │
│ RESULT: Listeners bound BEFORE events arrive. Both widgets work correctly.   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Key Insight

**React's state update (setInstanceId) is synchronous.** When we call `setInstanceId`:
1. React immediately schedules a re-render
2. All components using `instanceId` re-render
3. Their useEffects with `[instanceId]` dependency re-run
4. Listeners get bound to the new instance

This all happens BEFORE the HTTP handshake completes and events start arriving.

---

## 4. Consumer Contract

### 4.1 Correct Pattern

```tsx
function TasksWidget() {
  const { esRef, instanceId } = useSSE();
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    const es = esRef.current;
    if (!es) return; // Guard: connection may be null during reconnect

    const handler = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data);
        setTasks((prev) => [data, ...prev].slice(0, 50));
      } catch (err) {
        console.error("Failed to parse task event:", err);
      }
    };

    es.addEventListener("task", handler);
    return () => es.removeEventListener("task", handler);
  }, [instanceId]); // ← CRITICAL: rebind when connection changes

  return (
    <ul>
      {tasks.map((t) => (
        <li key={t.taskId}>{t.title}</li>
      ))}
    </ul>
  );
}
```

### 4.2 The Contract

| Rule | Why |
|------|-----|
| Include `instanceId` in useEffect deps | Ensures effect re-runs when connection changes |
| Check `if (!es) return` | Connection may be null during reconnect window |
| Wrap JSON.parse in try/catch | Server may send malformed data |
| Return cleanup function | Remove listener when effect re-runs or unmounts |

---

## 5. Anti-Patterns (What NOT To Do)

### ❌ Anti-Pattern 1: Forgetting instanceId

```tsx
// ❌ WRONG: Missing instanceId in deps
useEffect(() => {
  const es = esRef.current;
  if (!es) return;
  es.addEventListener("task", handler);
  return () => es.removeEventListener("task", handler);
}, []); // ← BUG: Effect never re-runs on reconnect!
```

**Result:** Listener stays on old (dead) instance. Widget stops receiving events after reconnect.

### ❌ Anti-Pattern 2: Polling for Instance Changes

```tsx
// ❌ WRONG: Polling-based detection
useEffect(() => {
  const interval = setInterval(() => {
    if (esRef.current !== lastInstance) {
      rebindListeners();
    }
  }, 250);
  return () => clearInterval(interval);
}, []);
```

**Result:** Race condition. Polling may miss the window between instance creation and first event.

### ❌ Anti-Pattern 3: Creating EventSource in Consumer

```tsx
// ❌ WRONG: Each widget creates its own connection
function TasksWidget() {
  const [es] = useState(() => new EventSource(url));
  // ...
}
```

**Result:** Multiple connections to same server. Wastes resources, complicates state.

### ❌ Anti-Pattern 4: Storing EventSource in State

```tsx
// ❌ WRONG: EventSource in useState
const [es, setEs] = useState<EventSource | null>(null);

useEffect(() => {
  const newEs = new EventSource(url);
  setEs(newEs); // Triggers re-render
  
  return () => {
    es?.close(); // ← Stale! Still references old es
  };
}, []);
```

**Result:** Cleanup references stale `es` from closure. Memory leaks and zombie connections.

---

## 6. React Concepts Explained

### 6.1 useRef vs useState

| Aspect | `useRef` | `useState` |
|--------|----------|-----------|
| Changes trigger re-render? | ❌ No | ✅ Yes |
| Access pattern | `ref.current` | `[value, setValue]` |
| Use for | Mutable values, DOM refs | Render values |
| Persists across renders? | ✅ Yes | ✅ Yes |

**EventSource belongs in a ref** — it's a mutable resource, not a "render value."

**instanceId belongs in state** — we WANT re-renders when it changes.

### 6.2 Stale Closures

A closure "captures" variables at creation time:

```tsx
function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const handler = () => {
      console.log(count); // ⚠️ Always logs 0!
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []); // Empty deps = handler captures initial count
}
```

**Solution: Use refs for values accessed in long-lived handlers:**

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  const countRef = useRef(count);
  
  // Keep ref in sync
  useEffect(() => {
    countRef.current = count;
  }, [count]);

  useEffect(() => {
    const handler = () => {
      console.log(countRef.current); // ✅ Always current!
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);
}
```

### 6.3 useCallback

Memoizes a function so it has stable reference across renders:

```tsx
// ❌ New function every render
const connect = () => { /* ... */ };

// ✅ Same function reference (unless deps change)
const connect = useCallback(() => {
  /* ... */
}, [dep1, dep2]);
```

Why it matters: Functions in useEffect deps should be stable, otherwise effect re-runs every render.

---

## 7. iOS Safari Deep Dive

### 7.1 The Problem

Safari (especially iOS) aggressively manages background tabs:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     iOS Safari Background Behavior                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. User switches to another app or tab                                      │
│ 2. Safari suspends the tab (typically within 30 seconds)                    │
│ 3. Network sockets are KILLED silently                                      │
│ 4. onerror may NOT fire (this is the tricky part)                           │
│ 5. readyState may still show OPEN (Safari lies!)                            │
│ 6. User returns to app                                                      │
│ 7. App thinks connection is alive, but no events flow                       │
│ 8. Widgets stop updating → user thinks app is broken                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 The Solution: Multiple Lifecycle Handlers

The hook listens to four browser events:

```typescript
useEffect(() => {
  connect();

  // 1. VISIBILITY CHANGE: Tab goes to background/foreground
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      // Record when we went to background
      hiddenAtRef.current = Date.now();
      return;
    }

    if (document.visibilityState === "visible") {
      const es = eventSourceRef.current;
      const hiddenAt = hiddenAtRef.current;
      
      // If no connection or explicitly closed
      if (!es || es.readyState === 2 /* CLOSED */) {
        connect();
        return;
      }

      // If hidden too long, assume connection is dead
      if (hiddenAt && (Date.now() - hiddenAt) > 10000) {
        closeCurrent();
        connect();
      }
    }
  };

  // 2. ONLINE: Network connectivity restored
  const onOnline = () => {
    // Network changed, existing connection is probably dead
    closeCurrent();
    connect();
  };

  // 3. PAGE HIDE: iOS Safari prefers this over beforeunload
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return; // Page might be restored from bfcache
    navigator.sendBeacon(`${host}/v1/sse/disconnect`);
    closeCurrent();
  };

  // 4. BEFORE UNLOAD: Desktop browser fallback
  const onBeforeUnload = () => {
    navigator.sendBeacon(`${host}/v1/sse/disconnect`);
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
  };
}, [connect]);
```

### 7.3 Why Each Handler?

| Event | When It Fires | Why We Need It |
|-------|--------------|----------------|
| `visibilitychange` | Tab hidden/shown | Detect return from background, check if connection is stale |
| `online` | Network reconnects | WiFi↔cellular switches kill connections |
| `pagehide` | Page is being unloaded | iOS Safari doesn't fire `beforeunload` reliably |
| `beforeunload` | Page is closing | Desktop browser cleanup |

---

## 8. Hook API Reference

### 8.1 SSEContextProvider Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `notificationsHost` | `string` | *required* | Base URL of SSE server (e.g., `"http://localhost:3001"`) |
| `path` | `string` | `"/v1/sse/connect"` | SSE endpoint path |
| `queryString` | `string` | `undefined` | Query params to append (e.g., `"intervalMs=1000&closeAfter=5"`) |
| `backgroundThresholdMs` | `number` | `10000` | Ms hidden before forcing reconnect (0 = always reconnect) |

### 8.2 useSSE() Return Value

| Property | Type | Description |
|----------|------|-------------|
| `esRef` | `RefObject<EventSourcePolyfill \| null>` | The EventSource instance (null during reconnect) |
| `instanceId` | `number` | Counter that increments on each new connection |

### 8.3 Usage Example

```tsx
function App() {
  return (
    <SSEContextProvider
      notificationsHost="http://localhost:3001"
      path="/v1/sse/connect"
      queryString="intervalMs=4000"
      backgroundThresholdMs={10000}
    >
      <TasksWidget />
      <NotificationsWidget />
    </SSEContextProvider>
  );
}
```

---

## 9. Server Requirements

### 9.1 Required HTTP Headers

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### 9.2 CORS for Cross-Origin Requests

```http
Access-Control-Allow-Origin: <origin>
Access-Control-Allow-Credentials: true
Vary: Origin
```

### 9.3 Polyfill Requirements

**2KB Padding at Start** (required by polyfill):
```typescript
res.write(`:${" ".repeat(2048)}\n`);
```

**Retry Field** (tells client reconnect delay):
```typescript
res.write("retry: 3000\n\n");
```

**Heartbeat Comments** (keep connection alive):
```typescript
setInterval(() => {
  res.write(`: ping ${Date.now()}\n\n`);
}, 20000);
```

### 9.4 SSE Event Format

```
id: 123
event: task
data: {"type":"task","taskId":"t-abc123","title":"Review transfer"}

```

**Note:** Double newline (`\n\n`) terminates each event.

---

## 10. Testing Guide

### 10.1 Test Scenarios

| Scenario | How to Test | Expected Result |
|----------|-------------|-----------------|
| Initial connection | Load page | All widgets receive events |
| Server restart | Stop/start server | All widgets resume after ~1-3s |
| Network offline | Disable network, wait, enable | All widgets resume |
| iOS background | Switch apps for 30s, return | All widgets resume immediately |
| Tab switch | Switch tabs for 30s, return | All widgets resume |
| Multiple widgets | Add 5+ widgets | All receive their events |

### 10.2 Server Test Flags

Use query parameters to simulate scenarios:

```
http://localhost:3001/v1/sse/connect?intervalMs=1000      # Fast events
http://localhost:3001/v1/sse/connect?closeAfter=5         # Server closes after 5 events
http://localhost:3001/v1/sse/connect?heartbeat=0          # No heartbeats
```

### 10.3 Debugging Tips

1. **Check instanceId in DevTools** — Should increment on each reconnect
2. **Watch Network tab** — SSE connection should show `EventStream` type
3. **Console log in handlers** — Verify events are being received
4. **Check `readyState`** — 0=CONNECTING, 1=OPEN, 2=CLOSED

---

## 11. Troubleshooting

### Widget stops receiving events after reconnect

**Check:** Is `instanceId` in your useEffect deps?
```tsx
useEffect(() => { ... }, [instanceId]); // ← Must include this
```

### Events received but not displayed

**Check:** Is JSON parsing working?
```tsx
try {
  const data = JSON.parse(evt.data);
} catch (err) {
  console.error("Parse error:", err);
}
```

### Connection never establishes

**Check:** CORS headers, server running, correct URL.

### Safari-specific issues

**Check:** Is `backgroundThresholdMs` set appropriately? Default 10s works for most cases.

---

## 12. References

### Official Documentation
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [MDN: EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
- [MDN: Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [MDN: Navigator.sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)

### Libraries
- [EventSource Polyfill](https://github.com/Yaffle/EventSource)

### Browser-Specific
- [Chrome Page Lifecycle API](https://developer.chrome.com/blog/page-lifecycle-api)
- [WebKit Background Tab Behavior](https://webkit.org/blog/7675/intelligent-tracking-prevention/)

### React
- [React useEffect](https://react.dev/reference/react/useEffect)
- [React useRef](https://react.dev/reference/react/useRef)
- [React useCallback](https://react.dev/reference/react/useCallback)
