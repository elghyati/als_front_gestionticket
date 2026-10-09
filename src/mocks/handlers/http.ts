/** Shared building blocks for the mock handlers: responses, checks, validation, pagination. */
import { delay, HttpResponse, type JsonBodyType } from "msw";
import type { Schemas } from "../../api/client";
import { tokenFor, users, type MockUser } from "../fixtures";
import { getTimeoutDelay, scenarioFor } from "../scenarios";

export type ErrorBody = Schemas["Error"];
export type Details = NonNullable<ErrorBody["details"]>;
type Role = Schemas["Role"];

/** Matches any origin so the same handlers work in the browser and in Node tests. */
export const api = (path: string) => `*/api/v1${path}`;

const CORRELATION_HEADER = "X-Correlation-Id";

export const correlationIdOf = (request: Request): string =>
  request.headers.get(CORRELATION_HEADER) ?? crypto.randomUUID();

export function json<T extends JsonBodyType>(request: Request, body: T, status = 200) {
  return HttpResponse.json(body, { status, headers: { [CORRELATION_HEADER]: correlationIdOf(request) } });
}

export function noContent(request: Request) {
  return new HttpResponse(null, { status: 204, headers: { [CORRELATION_HEADER]: correlationIdOf(request) } });
}

export function error(
  request: Request,
  status: number,
  code: string,
  message: string,
  extra: Pick<ErrorBody, "retryable" | "details"> = {},
) {
  return json<ErrorBody>(request, { code, message, correlationId: correlationIdOf(request), ...extra }, status);
}

export const notFound = (request: Request, what: string, id: string) =>
  error(request, 404, `${what.toUpperCase().replace(/ /g, "_")}_NOT_FOUND`, `${what} ${id} not found`);

export const conflict = (request: Request, code: string, message: string) => error(request, 409, code, message);

export const invalid = (request: Request, details: Details, code = "INVALID_REQUEST") =>
  error(request, 400, code, "Request is invalid", { details });

// ───────────────────────── roles ─────────────────────────

export const KMS_READ: Role[] = ["AGENT", "SUPERVISOR", "ADMIN"];
export const KMS_OPERATE: Role[] = ["SUPERVISOR", "ADMIN"];
export const KMS_ADMIN: Role[] = ["ADMIN"];

// ───────────────────────── checks ─────────────────────────

/** Which downstream system answers the call: drives the `cbsDown` / `kmsDown` scenarios. */
export type Upstream = "CBS" | "KMS";

/** Checks shared by every endpoint: correlation id, then the infrastructure scenarios. */
export async function precheck(request: Request, upstream: Upstream): Promise<Response | undefined> {
  if (!request.headers.get(CORRELATION_HEADER)) {
    return error(request, 400, "MISSING_CORRELATION_ID", `${CORRELATION_HEADER} header is required`);
  }

  const scenario = scenarioFor(request);
  if (scenario === "timeout") {
    await delay(getTimeoutDelay());
    return error(request, 504, "UPSTREAM_TIMEOUT", "Downstream system did not answer in time", { retryable: true });
  }
  if ((scenario === "cbsDown" && upstream === "CBS") || (scenario === "kmsDown" && upstream === "KMS")) {
    return error(request, 503, `${upstream}_UNAVAILABLE`, `${upstream} is unavailable`, { retryable: true });
  }
  return undefined;
}

function userFromToken(request: Request): MockUser | undefined {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  return users.find((u) => tokenFor(u) === token);
}

type Guarded = { response: Response; user?: never } | { response?: never; user: MockUser };

/**
 * `precheck`, then a valid bearer token and, when `roles` is given, one of
 * those roles. The `refused` scenario turns a role-protected call into 403.
 */
export async function guard(request: Request, upstream: Upstream, roles?: Role[]): Promise<Guarded> {
  const response = await precheck(request, upstream);
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

// ───────────────────────── validation ─────────────────────────

export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

/** Fails to compile when `A` misses a value of the union `T`. */
type CoversAll<T, A extends readonly T[]> = [Exclude<T, A[number]>] extends [never] ? true : never;

export const KIOSK_STATUSES = ["ONLINE", "OFFLINE", "MAINTENANCE"] as const satisfies readonly Schemas["KioskStatus"][];
export const KIOSK_HEALTHS = ["HEALTHY", "DEGRADED", "OUT_OF_SERVICE"] as const satisfies readonly Schemas["KioskHealth"][];
export const DEVICE_STATUSES = ["OPERATIONAL", "WARNING", "ERROR", "OFFLINE", "MAINTENANCE", "DISABLED"] as const satisfies readonly Schemas["DeviceStatus"][];
export const DEVICE_CATEGORIES = ["CASH", "CARD", "PRINTER", "INPUT", "DISPLAY", "SENSOR", "OTHER"] as const satisfies readonly Schemas["DeviceCategory"][];
export const REQUIREMENT_LEVELS = ["MANDATORY", "RECOMMENDED", "OPTIONAL"] as const satisfies readonly Schemas["RequirementLevel"][];
export const CHANGE_SOURCES = ["DEVICE", "OPERATOR", "SYSTEM"] as const satisfies readonly Schemas["StatusChangeSource"][];
export const RECEIPT_MODES = ["ALWAYS", "ON_REQUEST", "NEVER"] as const satisfies readonly Schemas["ReceiptMode"][];

const covers: [
  CoversAll<Schemas["KioskStatus"], typeof KIOSK_STATUSES>,
  CoversAll<Schemas["KioskHealth"], typeof KIOSK_HEALTHS>,
  CoversAll<Schemas["DeviceStatus"], typeof DEVICE_STATUSES>,
  CoversAll<Schemas["DeviceCategory"], typeof DEVICE_CATEGORIES>,
  CoversAll<Schemas["RequirementLevel"], typeof REQUIREMENT_LEVELS>,
  CoversAll<Schemas["StatusChangeSource"], typeof CHANGE_SOURCES>,
  CoversAll<Schemas["ReceiptMode"], typeof RECEIPT_MODES>,
] = [true, true, true, true, true, true, true];
void covers;

export const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/** Collects field errors; `details` is empty when the body is valid. */
export class Validator {
  readonly details: Details = [];

  check(ok: boolean, field: string, issue: string): this {
    if (!ok) this.details.push({ field, issue });
    return this;
  }

  /** Optional field: checked only when present. */
  optional(value: unknown, ok: boolean, field: string, issue: string): this {
    return value === undefined ? this : this.check(ok, field, issue);
  }

  unknownFields(body: object, allowed: readonly string[]): this {
    for (const key of Object.keys(body)) this.check(allowed.includes(key), key, "unknown field");
    return this;
  }

  get valid(): boolean {
    return this.details.length === 0;
  }
}

export const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Reads a JSON object body; anything else counts as an empty object. */
export async function readBody<T extends object>(request: Request): Promise<Partial<T>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Partial<T>) : {};
  } catch {
    return {};
  }
}

// ───────────────────────── query parameters ─────────────────────────

type Paged<T> = { response: Response; page?: never } | { response?: never; page: { items: T[]; nextCursor?: string } };

/** Offset pagination behind the contract's opaque `cursor` / `nextCursor`. */
export function paginate<T>(request: Request, items: T[]): Paged<T> {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const offset = Number(url.searchParams.get("cursor") ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    return {
      response: error(request, 400, "INVALID_PAGINATION", "limit must be 1..100 and cursor must come from nextCursor"),
    };
  }
  const next = offset + limit;
  return {
    page: { items: items.slice(offset, next), ...(next < items.length && { nextCursor: String(next) }) },
  };
}

type DateRange = { response: Response; from?: never; to?: never } | { response?: never; from?: string; to?: string };

/** `from` (inclusive) and `to` (exclusive) as ISO strings, comparable with `localeCompare`. */
export function dateRange(request: Request): DateRange {
  const url = new URL(request.url);
  const parse = (name: string) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return { ok: true as const, value: undefined };
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? { ok: false as const } : { ok: true as const, value: date.toISOString() };
  };
  const from = parse("from");
  const to = parse("to");
  const v = new Validator().check(from.ok, "from", "must be a date-time").check(to.ok, "to", "must be a date-time");
  if (!v.valid || !from.ok || !to.ok) return { response: invalid(request, v.details) };
  return { from: from.value, to: to.value };
}

export const newestFirst = <T extends { changedAt?: string; createdAt?: string }>(a: T, b: T) =>
  (b.changedAt ?? b.createdAt ?? "").localeCompare(a.changedAt ?? a.createdAt ?? "");
