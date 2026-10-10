/**
 * Serves the MSW mock as a real HTTP server, for Postman, curl or an app
 * running on another origin. Same handlers, data and scenarios as the tests.
 *
 *   npm run mock:server              → http://localhost:4000/api/v1
 *   PORT=5000 npm run mock:server    (Windows cmd: set PORT=5000 && npm run mock:server)
 *
 * Control endpoints (no auth):
 *   GET  /__mock                     current scenario and the list of scenarios
 *   POST /__mock/scenario            body {"scenario": "cbsDown", "timeoutDelayMs"?: 500}
 *   POST /__mock/reset               restores the demo data and the "ok" scenario
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getResponse } from "msw";
import { users } from "./fixtures";
import { handlers } from "./handlers";
import { getScenario, getTimeoutDelay, isScenario, resetScenario, SCENARIOS, setScenario, setTimeoutDelay } from "./scenarios";
import { resetMockState } from "./state";

const PORT = Number(process.env.PORT ?? 4000);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Correlation-Id, Idempotency-Key, X-Mock-Scenario",
  "Access-Control-Expose-Headers": "X-Correlation-Id",
};

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

const mockInfo = () => ({ scenario: getScenario(), timeoutDelayMs: getTimeoutDelay(), scenarios: SCENARIOS });

async function handleControl(req: IncomingMessage, res: ServerResponse, path: string, body: Buffer) {
  if (req.method === "GET" && path === "/__mock") return sendJson(res, 200, mockInfo());

  if (req.method === "POST" && path === "/__mock/reset") {
    resetMockState();
    resetScenario();
    return sendJson(res, 200, mockInfo());
  }

  if (req.method === "POST" && path === "/__mock/scenario") {
    let payload: { scenario?: unknown; timeoutDelayMs?: unknown } = {};
    try {
      payload = JSON.parse(body.toString() || "{}");
    } catch {
      // handled below as an invalid scenario
    }
    if (!isScenario(payload.scenario)) {
      return sendJson(res, 400, { error: `scenario must be one of ${SCENARIOS.join(", ")}` });
    }
    setScenario(payload.scenario);
    if (typeof payload.timeoutDelayMs === "number") setTimeoutDelay(payload.timeoutDelayMs);
    return sendJson(res, 200, mockInfo());
  }

  return sendJson(res, 404, { error: "Unknown control endpoint" });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${PORT}`}`);
    const body = await readRawBody(req);

    if (url.pathname.startsWith("/__mock")) return await handleControl(req, res, url.pathname, body);

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const request = new Request(url, {
      method: req.method,
      headers,
      ...(body.length > 0 && req.method !== "GET" && req.method !== "HEAD" && { body: new Uint8Array(body) }),
    });

    const response = await getResponse(handlers, request);
    if (!response) {
      return sendJson(res, 404, {
        error: `No mock for ${req.method} ${url.pathname}. The API is served under /api/v1, e.g. /api/v1/kms/kiosks`,
      });
    }

    const responseHeaders: Record<string, string> = { ...CORS_HEADERS };
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    res.writeHead(response.status, responseHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
    console.log(`${req.method} ${url.pathname}${url.search} → ${response.status}  [${getScenario()}]`);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: "Mock server error", detail: String(err) });
  }
});

server.listen(PORT, () => {
  const base = `http://localhost:${PORT}/api/v1`;
  console.log(`\nMock API (MSW) listening on ${base}\n`);
  console.log("Demo tokens (header  Authorization: Bearer <token>):");
  for (const u of users) console.log(`  ${u.roles.join(",").padEnd(10)} mock-token-${u.id}`);
  console.log("\nEvery call needs the header  X-Correlation-Id: <uuid>");
  console.log(`Example: curl -H "Authorization: Bearer mock-token-U-AGENT-1" -H "X-Correlation-Id: 3f1c1b0e-0000-4000-8000-000000000001" ${base}/kms/kiosks`);
  console.log(`\nScenario: GET http://localhost:${PORT}/__mock · POST /__mock/scenario {"scenario":"cbsDown"} · POST /__mock/reset\n`);
});
