import express from "express";
import cors from "cors";
import type { Request, Response } from "express";
import { faker } from "@faker-js/faker";

const app = express();
const PORT = 3001;

app.use(
  cors({
    origin: true,
    credentials: true,
    // Why: makes streaming headers visible to the browser/devtools
    exposedHeaders: ["Content-Type", "Cache-Control", "Connection", "X-Accel-Buffering"],
  })
);
app.use(express.json());

/**
 * SSE test server (minimal simple event emitter) for front-end testing (polyfill + hook).
 *
 * Polyfill server-side requirements (padding, lastEventId query param, heartbeat comments):
 * https://github.com/Yaffle/EventSource#server-side-requirements
 *
 * SSE stream format (id/event/data/retry and comment lines starting with ':'):
 * https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
 */

type EventName = "connected" | "task" | "notification";
type RequestDebug = Record<string, unknown>;

function timestamps() {
  const d = new Date();
  return {
    utcIso: d.toISOString(),
    // “Local” here is the server machine’s local time string (fine for demo/testing)
    localIso: d.toString(),
    tzOffsetMinutes: -d.getTimezoneOffset(),
    epochMs: d.getTime(),
  };
}

// Polyfill commonly uses `lastEventId` query param; native EventSource uses `Last-Event-ID` header.
// Why: lets the client verify what the server received (diagnostics), even though we don't replay.
// https://github.com/Yaffle/EventSource#server-side-requirements
function parseLastEventId(req: Request): number {
  const q = req.query.lastEventId;
  const h = req.header("last-event-id");

  const n1 = typeof h === "string" ? Number(h) : Number.NaN;
  const n2 = typeof q === "string" ? Number(q) : Number.NaN;

  if (Number.isFinite(n1)) return n1;
  if (Number.isFinite(n2)) return n2;
  return 0;
}

// SSE comment heartbeat (":" prefix).
// Why: keeps the connection alive without triggering event handlers.
// https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
function writeComment(res: Response, comment: string) {
  res.write(`: ${ comment }\n\n`);
}

function buildRequestDebug(req: express.Request): RequestDebug {
  const h = req.headers;

  // Why: JS in the browser cannot read these request headers directly.
  // Echoing them in the initial SSE "connected" event makes cross-browser debugging easier.
  return {
    host: h.host,
    origin: h.origin,
    referer: h.referer,

    userAgent: h["user-agent"],
    secChUa: h["sec-ch-ua"],
    secChUaMobile: h["sec-ch-ua-mobile"],
    secChUaPlatform: h["sec-ch-ua-platform"],

    secFetchDest: h["sec-fetch-dest"],
    secFetchMode: h["sec-fetch-mode"],
    secFetchSite: h["sec-fetch-site"],

    accept: h.accept,
    acceptLanguage: h["accept-language"],
    acceptEncoding: h["accept-encoding"],
    cacheControl: h["cache-control"],
    pragma: h.pragma,
    connection: h.connection,
    dnt: h.dnt,

    // Credentials (don’t echo cookie contents; just presence/size)
    hasCookieHeader: typeof h.cookie === "string" && h.cookie.length > 0,
    cookieBytes: typeof h.cookie === "string" ? h.cookie.length : 0,

    ip: req.ip,
    ips: req.ips,
    httpVersion: req.httpVersion,
    method: req.method,
    path: req.path,
    query: req.query,
  };
}


const taskTemplates = [
  () => `Approve wire to ${ faker.person.fullName() }`,
  () => `Review transfer - $${ faker.finance.amount({ min: 1000, max: 50000 }) }`,
  () => `Verify payee: ${ faker.company.name() }`,
  () => `Authorize ACH to ${ faker.person.lastName() }`,
  () => `Confirm payment to ${ faker.company.name() }`,
  () => `Review check deposit #${ faker.string.numeric(6) }`,
];

const notifTemplates = [
  () => `Payment received from ${ faker.person.fullName() }`,
  () => `Login from ${ faker.location.city() }, ${ faker.location.countryCode() }`,
  () => `Deposit posted - ${ faker.company.name() }`,
  () => `Wire completed to ${ faker.person.lastName() }`,
  () => `New payee added: ${ faker.company.name() }`,
  () => `Account balance updated for ${ faker.company.name() }`,
];

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const pickAndRun = (a: Array<() => string>): string => pick(a)();

app.get("/v1/sse/connect", (req, res) => {
  // --- SSE headers ---
  // - no-transform reduces buffering/proxy interference
  // - X-Accel-Buffering disables Nginx buffering (common SSE gotcha)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // --- Explicit streaming CORS (Safari/WebKit is sensitive here) ---
  // - Safari often requires explicit CORS headers on the streaming response itself
  // - If you set Allow-Credentials:true, you MUST NOT use "*" for Allow-Origin.
  // - Vary: Origin prevents caches from mixing responses between origins
  const origin = (req.headers.origin as string | undefined) ?? "";
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  } else {
    // curl / non-browser clients: no Origin header
    res.setHeader("Access-Control-Allow-Origin", "*");
  }


  // 2KB padding at top (polyfill requirement)
  // https://github.com/Yaffle/EventSource#server-side-requirements
  res.write(`:${ " ".repeat(2048) }\n`);

  // retry is an SSE field that tells client how long to wait before reconnecting
  // https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events

  res.write("retry: 3000\n\n");

  // Flush headers early so the browser starts processing the stream immediately.
  // (Express/Node may buffer some headers otherwise.)
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Stable connectionId for this stream (stays constant until the connection is replaced).
  // Why: Safari/iOS can silently kill/restart streams; the UI can confirm a new connection started.
  const connectionId = `c-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 10) }`;


  // --- Per-connection id counter seeded from lastEventId ---
  // Why: If you have Chrome + Safari open at the same time, global IDs would interleave and create fake “gaps”.
  // - IDs are sequential per connection, so gap detection is meaningful even with multiple browsers open
  // - We don't replay (server stays “dumb”), but the connected payload echoes what we received
  const clientLastEventId = parseLastEventId(req);
  let nextId = clientLastEventId;

  const requestDebug = buildRequestDebug(req);

  //SSE event format(id / event / data).
  // Why: "id:" drives MessageEvent.lastEventId (gap detection)
  // "event:" enables named listeners. (task/notification/connected)
  // SSE Format reference: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format
  const writeEvent = (event: EventName, data: Record<string, unknown>) => {
    const id = ++nextId;

    // Always include connectionId in every payload so the client can correlate events to a specific stream.
    const payload = { connectionId, ...data, ...timestamps() };

    res.write(`id: ${ id }\n`);
    res.write(`event: ${ event }\n`);
    res.write(`data: ${ JSON.stringify(payload) }\n\n`);
    return id;
  };

  // --- Connected event (named) ---
  // Why:
  // - UI can confirm stream is alive
  // - UI can see what lastEventId the server received
  // - UI can render browser details as seen by server (headers)
  // Initial connected handshake:

  writeEvent("connected", {
    type: "connected",
    // Match client expectation (some clients look specifically for `lastEventId`)
    lastEventId: clientLastEventId,
    // Keep the explicit name too (nice for clarity in logs/UI)
    clientLastEventId,
    request: requestDebug,
  });


  // Small “repeat” connected after a short delay.
  // Why: the client-side diagnostics attaches listeners via a polling wrapper;
  // repeating reduces the chance of missing the first connected event.
  const connectedRepeat = setTimeout(() => {
    if (!res.writableEnded) {
      writeEvent("connected", { type: "connected", clientLastEventId, request: requestDebug });
    }
  }, 350);

  // --- Scenario knobs for easy browser testing ---
  // - intervalMs lets you increase/decrease message rate
  // - closeAfter forces disconnects to test reconnect behavior
  // - heartbeat=0 lets you test behavior without keep-alives (Safari vs Chrome/Edge)
  const intervalMs = Number(req.query.intervalMs ?? 4000);
  const closeAfter = Number(req.query.closeAfter ?? 0);
  const heartbeatOn = String(req.query.heartbeat ?? "1") !== "0";


  // --- Heartbeat comments ---
  // Why: keeps the connection alive without triggering app-level handlers.
  // Polyfill library recommends periodic data/comments to avoid idle timeouts.
  // https://github.com/Yaffle/EventSource#server-side-requirements
  const hb = heartbeatOn
    ? setInterval(() => writeComment(res, `ping ${ new Date().toISOString() }`), 20000)
    : null;

  // closeAfter counts business events only (task/notification)
  // Why: more intuitive testing (connected + heartbeat shouldn't count).
  let sentBusinessEvents = 0;
  const safeInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 4000;

  const timer = setInterval(() => {
    const isTask = Math.random() < 0.5;

    if (isTask) {
      writeEvent("task", {
        type: "task",
        taskId: `t-${ Math.random().toString(36).slice(2, 10) }`,
        title: pickAndRun(taskTemplates),
        amount: Math.floor(Math.random() * 20000) + 10,
      });
    } else {
      writeEvent("notification", {
        type: "notification",
        notificationId: `n-${ Math.random().toString(36).slice(2, 10) }`,
        title: pickAndRun(notifTemplates),
        severity: pick(["INFO", "WARN", "CRITICAL"] as const),
      });
    }

    sentBusinessEvents += 1;
    if (closeAfter > 0 && sentBusinessEvents >= closeAfter) {
      clearInterval(timer);
      if (hb) clearInterval(hb);
      res.end();
    }
  }, safeInterval);

  req.on("close", () => {
    clearTimeout(connectedRepeat);
    clearInterval(timer);
    if (hb) clearInterval(hb);
  });
});

// Disconnect beacon endpoint.
// Why: lets you confirm unload behavior and compare UA/origin across browsers.
// sendBeacon background:
// https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
app.post("/v1/sse/disconnect", (req, res) => {
  console.log("[beacon] disconnect received", {
    ua: req.headers["user-agent"],
    origin: req.headers.origin,
  });
  res.status(200).end();
});

// Dual health endpoints.
// Why: prevents "wrong URL" 404 confusion during setup.
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`SSE server: http://localhost:${ PORT }`);
});
