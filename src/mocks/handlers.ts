import { delay, http, HttpResponse, type JsonBodyType } from "msw";
import type { Schemas } from "../api/client";
import { CURRENCY, state, tokenFor, users, type MockUser } from "./fixtures";
import { getTimeoutDelay, scenarioFor } from "./scenarios";

type ErrorBody = Schemas["Error"];
type Role = Schemas["Role"];

/** Matches any origin so the same handlers work in the browser and in Node tests. */
const api = (path: string) => `*/api/v1${path}`;

const CORRELATION_HEADER = "X-Correlation-Id";

function json<T extends JsonBodyType>(request: Request, body: T, status = 200) {
  const correlationId = request.headers.get(CORRELATION_HEADER) ?? crypto.randomUUID();
  return HttpResponse.json(body, { status, headers: { [CORRELATION_HEADER]: correlationId } });
}

function error(
  request: Request,
  status: number,
  code: string,
  message: string,
  extra: Pick<ErrorBody, "retryable" | "details"> = {},
) {
  const correlationId = request.headers.get(CORRELATION_HEADER) ?? crypto.randomUUID();
  return json<ErrorBody>(request, { code, message, correlationId, ...extra }, status);
}

function userFromToken(request: Request): MockUser | undefined {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  return users.find((u) => tokenFor(u) === token);
}

/** Checks shared by every endpoint: correlation id, then the infrastructure scenarios. */
async function precheck(request: Request): Promise<Response | undefined> {
  if (!request.headers.get(CORRELATION_HEADER)) {
    return error(request, 400, "MISSING_CORRELATION_ID", `${CORRELATION_HEADER} header is required`);
  }

  const scenario = scenarioFor(request);
  if (scenario === "timeout") {
    await delay(getTimeoutDelay());
    return error(request, 504, "UPSTREAM_TIMEOUT", "Downstream system did not answer in time", { retryable: true });
  }
  if (scenario === "cbsDown") {
    return error(request, 503, "CBS_UNAVAILABLE", "Core banking system is unavailable", { retryable: true });
  }
  return undefined;
}

type Guarded = { response: Response; user?: never } | { response?: never; user: MockUser };

/** `precheck`, then a valid bearer token and, when `roles` is given, one of those roles. */
async function guard(request: Request, roles?: Role[]): Promise<Guarded> {
  const response = await precheck(request);
  if (response) return { response };

  const scenario = scenarioFor(request);
  const user = userFromToken(request);
  if (!user || scenario === "unauthorized") {
    return { response: error(request, 401, "UNAUTHORIZED", "Missing, invalid or expired token") };
  }
  if (roles && (scenario === "refused" || !user.roles.some((r) => roles.includes(r)))) {
    return { response: error(request, 403, "FORBIDDEN", `Requires one of: ${roles.join(", ")}`) };
  }
  return { user };
}

const canAccessAccount = (user: MockUser, accountId: string) =>
  !user.roles.includes("CUSTOMER") || (user.accountIds ?? []).includes(accountId);

const TERMINAL_ROLES: Role[] = ["AGENT", "SUPERVISOR", "ADMIN"];

export const handlers = [
  http.post<never, Schemas["LoginRequest"]>(api("/auth/login"), async ({ request }) => {
    const rejected = await precheck(request);
    if (rejected) return rejected;

    const body = await request.json();
    const user =
      body.channel === "KIOSK"
        ? users.find((u) => u.cardNumber === body.cardNumber && u.pin === body.pin)
        : users.find((u) => u.username === body.username && u.password === body.password);

    if (!user || scenarioFor(request) === "refused") {
      return error(request, 401, "INVALID_CREDENTIALS", "Invalid credentials");
    }

    const { id, displayName, roles, accountIds } = user;
    return json<Schemas["Session"]>(request, {
      accessToken: tokenFor(user),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      user: { id, displayName, roles, ...(accountIds && { accountIds }) },
    });
  }),

  http.get<{ accountId: string }>(api("/accounts/:accountId/balance"), async ({ request, params }) => {
    const g = await guard(request);
    if (g.response) return g.response;

    const balance = state.balances.get(params.accountId);
    if (!balance || !canAccessAccount(g.user, params.accountId)) {
      return error(request, 404, "ACCOUNT_NOT_FOUND", `Account ${params.accountId} not found`);
    }
    return json<Schemas["Balance"]>(request, balance);
  }),

  http.get<{ accountId: string }>(api("/accounts/:accountId/transactions"), async ({ request, params }) => {
    const g = await guard(request);
    if (g.response) return g.response;

    if (!state.balances.has(params.accountId) || !canAccessAccount(g.user, params.accountId)) {
      return error(request, 404, "ACCOUNT_NOT_FOUND", `Account ${params.accountId} not found`);
    }

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      return error(request, 400, "INVALID_PAGINATION", "limit must be 1..100 and cursor must come from nextCursor");
    }

    const all = state.transactions
      .filter((t) => t.accountId === params.accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const items = all.slice(offset, offset + limit);
    const next = offset + limit;
    return json<Schemas["TransactionPage"]>(request, {
      items,
      ...(next < all.length && { nextCursor: String(next) }),
    });
  }),

  http.post<never, Schemas["DepositRequest"]>(api("/deposits"), async ({ request }) => {
    const g = await guard(request);
    if (g.response) return g.response;

    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      return error(request, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
    }
    const previous = state.depositsByIdempotencyKey.get(idempotencyKey);
    if (previous) return json<Schemas["TransactionEnvelope"]>(request, previous, 201);

    const body = await request.json();
    const details: NonNullable<ErrorBody["details"]> = [];
    if (!(body.amount?.amount > 0)) details.push({ field: "amount.amount", issue: "must be greater than 0" });
    if (body.amount?.currency !== CURRENCY) details.push({ field: "amount.currency", issue: `must be ${CURRENCY}` });
    if (!body.terminalId) details.push({ field: "terminalId", issue: "is required" });
    const balance = state.balances.get(body.accountId);
    if (!balance || !canAccessAccount(g.user, body.accountId)) {
      details.push({ field: "accountId", issue: "unknown account" });
    }
    if (details.length > 0 || !balance) {
      return error(request, 400, "INVALID_DEPOSIT", "Deposit request is invalid", { details });
    }

    if (scenarioFor(request) === "refused") {
      return error(request, 422, "DEPOSIT_LIMIT_EXCEEDED", "Daily deposit limit exceeded", { retryable: false });
    }

    const transaction: Schemas["TransactionEnvelope"] = {
      transactionId: `TX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      correlationId: request.headers.get(CORRELATION_HEADER)!,
      type: "DEPOSIT",
      status: "ACCEPTED",
      accountId: body.accountId,
      terminalId: body.terminalId,
      amount: body.amount,
      createdAt: new Date().toISOString(),
    };
    balance.available.amount += body.amount.amount;
    balance.ledger.amount += body.amount.amount;
    balance.asOf = transaction.createdAt;
    state.transactions.push(transaction);
    state.depositsByIdempotencyKey.set(idempotencyKey, transaction);
    return json<Schemas["TransactionEnvelope"]>(request, transaction, 201);
  }),

  http.get(api("/terminals"), async ({ request }) => {
    const g = await guard(request, TERMINAL_ROLES);
    if (g.response) return g.response;

    const status = new URL(request.url).searchParams.get("status");
    const items = state.terminals
      .filter((t) => !status || t.status === status)
      .map(({ terminalId, name, location, status, lastSeenAt }) => ({ terminalId, name, location, status, lastSeenAt }));
    return json<{ items: Schemas["TerminalSummary"][] }>(request, { items });
  }),

  http.get<{ terminalId: string }>(api("/terminals/:terminalId"), async ({ request, params }) => {
    const g = await guard(request, TERMINAL_ROLES);
    if (g.response) return g.response;

    const terminal = state.terminals.find((t) => t.terminalId === params.terminalId);
    if (!terminal) return error(request, 404, "TERMINAL_NOT_FOUND", `Terminal ${params.terminalId} not found`);
    return json<Schemas["TerminalDetail"]>(request, terminal);
  }),
];
