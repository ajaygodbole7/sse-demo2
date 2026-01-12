# SSE Connection Manager for React Micro-Frontends

A production-ready React hook for managing Server-Sent Events (SSE) connections across multiple micro-frontends, with specific fixes for iOS Safari reliability issues.

---

## Table of Contents

- [Overview](#overview)
- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Consumer Contract](#consumer-contract)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Testing Guide](#testing-guide)
- [Troubleshooting](#troubleshooting)
- [References](#references)

---

## Overview

This repository provides:

1. **`useSSE` hook** — A connection manager that handles SSE lifecycle, reconnection, and cross-browser quirks
2. **Demo application** — Shows correct usage patterns and common anti-patterns
3. **Test server** — Emits `task` and `notification` events for testing

**Key Features:**

- Single shared SSE connection across multiple widgets
- Automatic reconnection with exponential backoff
- iOS Safari background tab recovery
- Network transition handling (WiFi ↔ cellular)
- Reactive `instanceId` for reliable listener rebinding

---

## The Problem

### Symptom

On iOS Safari, after the app returns from background:

- ✅ Tasks widget receives events
- ❌ Notifications widget stops receiving events

### Root Cause

When an SSE connection is recreated, each widget must rebind its event listeners to the new `EventSource` instance. The original implementation updated `instanceId` inside `onopen`:

```typescript
// ❌ BUG: instanceId updates too late
es.onopen = () => {
  setInstanceId(id => id + 1);
};
```

**Timeline of the bug:**

```
T0  new EventSource()           → Listeners still on OLD instance
T1  Server sends "task"         → MISSED
T2  Server sends "notification" → MISSED
T3  onopen fires                → NOW instanceId updates
T4  Listeners rebind            → Too late, events already lost
```

---

## The Solution

Update `instanceId` **immediately** when creating the new `EventSource`:

```typescript
// ✅ FIX: instanceId updates immediately
const es = new EventSourceCtor(url);
eventSourceRef.current = es;
setInstanceId(id => id + 1); // Triggers rebind BEFORE events arrive

es.onopen = () => {
  attemptCountRef.current = 0; // Just reset backoff
};
```

**Timeline after fix:**

```
T0  new EventSource()           → Listeners on OLD instance
T1  setInstanceId(2)            → React re-renders all consumers
T2  Listeners rebind            → Now on NEW instance
T3  Server sends "task"         → ✅ RECEIVED
T4  Server sends "notification" → ✅ RECEIVED
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd sse-diagnostics

# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install
```

### Running

**Terminal 1 — Start the server:**

```bash
cd server
npx ts-node server.ts
# or
npx tsx server.ts
```

**Terminal 2 — Start the client:**

```bash
cd client
npm run dev
```

**Open in browser:**

```
http://localhost:5173
```

### Testing Cross-Browser

1. Open the app in Chrome and Safari side-by-side
2. Observe events flowing to both Tasks and Notifications widgets
3. Switch Safari to background for 30+ seconds
4. Return to Safari — both widgets should resume receiving events

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              React Application                               │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     SSEContextProvider                                  │ │
│  │                                                                         │ │
│  │   Provides: { esRef, instanceId }                                       │ │
│  │                                                                         │ │
│  │   ✅ Creates EventSource                                                │ │
│  │   ✅ Reconnects on error (exponential backoff)                          │ │
│  │   ✅ Handles iOS Safari background suspension                           │ │
│  │   ✅ Handles network transitions                                        │ │
│  │   ✅ Updates instanceId IMMEDIATELY on reconnect                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                    │                                         │
│                    Context: { esRef, instanceId }                            │
│                                    │                                         │
│          ┌─────────────────────────┼─────────────────────────┐              │
│          ▼                         ▼                         ▼              │
│  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐        │
│  │ Tasks Widget │         │ Notif Widget │         │ Other Widget │        │
│  │              │         │              │         │              │        │
│  │ useEffect    │         │ useEffect    │         │ useEffect    │        │
│  │ [instanceId] │         │ [instanceId] │         │ [instanceId] │        │
│  └──────────────┘         └──────────────┘         └──────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP (text/event-stream)
                                    ▼
                         ┌─────────────────────┐
                         │     SSE Server      │
                         │                     │
                         │ Events:             │
                         │ ├── connected       │
                         │ ├── task            │
                         │ └── notification    │
                         └─────────────────────┘
```

---

## Consumer Contract

### ✅ Correct Pattern

```tsx
function MyWidget() {
  const { esRef, instanceId } = useSSE();
  const [items, setItems] = useState([]);

  useEffect(() => {
    const es = esRef.current;
    if (!es) return;

    const handler = (evt: MessageEvent) => {
      const receivedAt = Date.now();
      try {
        const data = JSON.parse(evt.data);
        setItems(prev => [{ ...data, receivedAt }, ...prev]);
      } catch (err) {
        console.error('Parse error:', err);
      }
    };

    es.addEventListener('myevent', handler);
    return () => es.removeEventListener('myevent', handler);
  }, [instanceId]); // ← CRITICAL: rebind when connection changes

  return <ul>{items.map(/* ... */)}</ul>;
}
```

### Key Rules

| Rule                             | Why                                     |
| -------------------------------- | --------------------------------------- |
| Include `instanceId` in deps     | Effect re-runs when connection changes  |
| Guard `if (!es) return`          | Connection may be null during reconnect |
| Wrap `JSON.parse` in try/catch   | Handle malformed server data            |
| Return cleanup function          | Remove listener on re-run or unmount    |
| Capture `receivedAt` immediately | Accurate latency measurement            |

### ❌ Anti-Pattern

```tsx
// BUG: Missing instanceId — listener never rebinds!
useEffect(() => {
  const es = esRef.current;
  if (!es) return;
  es.addEventListener('myevent', handler);
  return () => es.removeEventListener('myevent', handler);
}, []); // ← Empty deps = broken after reconnect
```

---

## Project Structure

```
sse-demo2/
├── README.md                 # This file
├── DESIGN.md                 # Technical design document
├── client/
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── src/
│       ├── main.tsx          # Entry point
│       ├── App.tsx           # Demo app with micro frontend widgets
│       ├── index.css         # Tailwind styles
│       └── hooks/
│           └── useSSE.tsx    # The SSE connection manager
└── server/
    ├── package.json
    └── server.ts             # SSE test server
```

---

## Configuration

### SSEContextProvider Props

| Prop                    | Type     | Default             | Description                                      |
| ----------------------- | -------- | ------------------- | ------------------------------------------------ |
| `notificationsHost`     | `string` | _required_          | SSE server URL (e.g., `"http://localhost:3001"`) |
| `path`                  | `string` | `"/v1/sse/connect"` | SSE endpoint path                                |
| `queryString`           | `string` | `undefined`         | Query params (e.g., `"intervalMs=1000"`)         |
| `backgroundThresholdMs` | `number` | `10000`             | Ms hidden before forcing reconnect               |

### Server Query Parameters

| Param        | Default | Description                                 |
| ------------ | ------- | ------------------------------------------- |
| `intervalMs` | `4000`  | Milliseconds between events                 |
| `closeAfter` | `0`     | Close connection after N events (0 = never) |
| `heartbeat`  | `1`     | Send heartbeat comments (0 = disable)       |

**Examples:**

```
/v1/sse/connect?intervalMs=1000           # Fast events (1/sec)
/v1/sse/connect?closeAfter=5              # Auto-close after 5 events
/v1/sse/connect?intervalMs=2000&closeAfter=10
```

---

## Testing Guide

### Test Scenarios

| Scenario              | How to Test                   | Expected                                    |
| --------------------- | ----------------------------- | ------------------------------------------- |
| Initial connection    | Load page                     | All widgets receive events                  |
| Server restart        | Stop server, wait 5s, restart | All widgets resume (backoff: 1s, 2s, 4s...) |
| iOS Safari background | Switch apps for 30s, return   | All widgets resume immediately              |
| Network offline       | Disable WiFi, wait, re-enable | All widgets resume                          |
| Tab switch            | Switch tabs for 30s, return   | All widgets resume                          |

### What to Observe

1. **instanceId** — Increments on each reconnect
2. **Latency (ms)** — Compare across browsers (should be similar)
3. **Event counts** — Both widgets should have same count after reconnect
4. **Connection status** — CONNECTING → OPEN cycle on reconnect

### Anti-Pattern Demo

The app includes a "Broken Widget" toggle that demonstrates the bug:

1. Click "Show Anti-Pattern Demo"
2. Wait for events to flow
3. Stop and restart the server
4. Observe: Tasks and Notifications resume, but Broken Widget stops

---

## Troubleshooting

### Widget stops receiving events after reconnect

**Cause:** Missing `instanceId` in useEffect deps.

**Fix:**

```tsx
useEffect(() => {
  // ...
}, [instanceId]); // ← Add this
```

### Connection never establishes

**Check:**

- Server is running (`http://localhost:3001/health`)
- CORS is configured (check browser console for errors)
- Correct URL in `notificationsHost` prop

### High latency on Safari

**Cause:** Safari throttles background tabs aggressively.

**Solution:** The hook forces reconnect after `backgroundThresholdMs` (default 10s). Reduce this value if needed:

```tsx
<SSEContextProvider
  notificationsHost="..."
  backgroundThresholdMs={5000}  // More aggressive
>
```

### Events received but not displayed

**Check:** JSON parsing in your handler:

```tsx
const handler = (evt: MessageEvent) => {
  console.log('Raw data:', evt.data); // Debug
  try {
    const data = JSON.parse(evt.data);
    console.log('Parsed:', data); // Debug
  } catch (err) {
    console.error('Parse failed:', err);
  }
};
```

---

## How the Hook Handles iOS Safari

iOS Safari kills network sockets when tabs are backgrounded. The hook uses four strategies:

### 1. Visibility Change Detection

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Check if we were hidden too long
    if (hiddenDuration > backgroundThresholdMs) {
      reconnect();
    }
  }
});
```

### 2. Network Recovery

```typescript
window.addEventListener('online', () => {
  // Network changed, reconnect
  reconnect();
});
```

### 3. Page Lifecycle (iOS-preferred)

```typescript
window.addEventListener('pagehide', event => {
  if (!event.persisted) {
    navigator.sendBeacon('/v1/sse/disconnect');
    close();
  }
});
```

### 4. Exponential Backoff

```typescript
// Retry delays: 1s, 2s, 4s, 8s, 16s, 30s (max)
const delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
```

---

## Server Requirements

For the polyfill to work correctly, the SSE server must:

### Send Correct Headers

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

### Include 2KB Padding (Polyfill Requirement)

```typescript
res.write(`:${' '.repeat(2048)}\n`);
```

### Send Heartbeat Comments

```typescript
setInterval(() => {
  res.write(`: ping ${Date.now()}\n\n`);
}, 20000);
```

### Use Correct Event Format

```
id: 123
event: task
data: {"type":"task","title":"Review transfer"}

```

Note: Double newline (`\n\n`) terminates each event.

---

## Dependencies

### Client

- React 18+
- [event-source-polyfill](https://github.com/Yaffle/EventSource) — Cross-browser SSE support
- Tailwind CSS — Styling

### Server

- Express — HTTP server
- [@faker-js/faker](https://fakerjs.dev/) — Realistic test data
- cors — CORS middleware

---

## References

### SSE Specification

- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [MDN: EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
- [HTML Living Standard: SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)

### Polyfill

- [EventSource Polyfill](https://github.com/Yaffle/EventSource)
- [Server-Side Requirements](https://github.com/Yaffle/EventSource#server-side-requirements)

### Browser APIs

- [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [Navigator.sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)
- [Page Lifecycle API](https://developer.chrome.com/blog/page-lifecycle-api)

### React

- [useEffect](https://react.dev/reference/react/useEffect)
- [useRef](https://react.dev/reference/react/useRef)
- [useCallback](https://react.dev/reference/react/useCallback)
- [Context API](https://react.dev/reference/react/useContext)

---

## License

MIT
