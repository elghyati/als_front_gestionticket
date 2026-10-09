import { http } from "msw";
import type { Schemas } from "../../api/client";
import type { KioskRecord } from "../fixtures";
import { computeKioskService, computeKioskServices, toKiosk } from "../kms/availability";
import { now, state } from "../state";
import {
  api,
  CODE_PATTERN,
  conflict,
  guard,
  invalid,
  isNonEmptyString,
  isOneOf,
  json,
  KIOSK_HEALTHS,
  KIOSK_STATUSES,
  KMS_ADMIN,
  KMS_READ,
  noContent,
  notFound,
  readBody,
  Validator,
} from "./http";

type KioskParams = { kioskId: string };
type KioskServiceParams = { kioskId: string; serviceCode: string };

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function validateKioskFields(v: Validator, body: Partial<Schemas["KioskCreate"]>) {
  return v
    .optional(body.name, isNonEmptyString(body.name), "name", "must be a non-empty string")
    .optional(
      body.location,
      isNonEmptyString(body.location?.branchName) && isNonEmptyString(body.location?.city),
      "location",
      "branchName and city are required",
    )
    .optional(body.ipAddress, typeof body.ipAddress === "string" && IPV4.test(body.ipAddress), "ipAddress", "must be an IPv4 address")
    .optional(body.softwareVersion, typeof body.softwareVersion === "string", "softwareVersion", "must be a string")
    .optional(body.status, isOneOf(KIOSK_STATUSES, body.status), "status", `must be one of ${KIOSK_STATUSES.join(", ")}`);
}

export const kioskHandlers = [
  http.get(api("/kms/kiosks"), async ({ request }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    const query = new URL(request.url).searchParams;
    const status = query.get("status");
    const health = query.get("health");
    const city = query.get("city")?.toLowerCase();
    const q = query.get("q")?.toLowerCase();
    const v = new Validator()
      .optional(status ?? undefined, isOneOf(KIOSK_STATUSES, status), "status", "unknown status")
      .optional(health ?? undefined, isOneOf(KIOSK_HEALTHS, health), "health", "unknown health");
    if (!v.valid) return invalid(request, v.details);

    const items = [...state.kiosks.values()]
      .map((k) => toKiosk(state, k))
      .filter((k) => !status || k.status === status)
      .filter((k) => !health || k.health === health)
      .filter((k) => !city || k.location.city.toLowerCase() === city)
      .filter((k) => !q || k.kioskId.toLowerCase().includes(q) || k.name.toLowerCase().includes(q));
    return json<{ items: Schemas["Kiosk"][] }>(request, { items });
  }),

  http.post(api("/kms/kiosks"), async ({ request }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const body = await readBody<Schemas["KioskCreate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["kioskId", "name", "location", "ipAddress", "softwareVersion", "status"])
      .check(typeof body.kioskId === "string" && CODE_PATTERN.test(body.kioskId), "kioskId", "must match ^[A-Z0-9][A-Z0-9_-]{1,31}$")
      .check(body.name !== undefined, "name", "is required")
      .check(body.location !== undefined, "location", "is required");
    if (!validateKioskFields(v, body).valid) return invalid(request, v.details);

    const valid = body as Schemas["KioskCreate"];
    if (state.kiosks.has(valid.kioskId)) return conflict(request, "KIOSK_ALREADY_EXISTS", `Kiosk ${valid.kioskId} already exists`);

    const at = now();
    const kiosk: KioskRecord = { ...valid, status: valid.status ?? "MAINTENANCE", createdAt: at, updatedAt: at };
    state.kiosks.set(kiosk.kioskId, kiosk);
    return json<Schemas["Kiosk"]>(request, toKiosk(state, kiosk), 201);
  }),

  http.get<KioskParams>(api("/kms/kiosks/:kioskId"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    const kiosk = state.kiosks.get(params.kioskId);
    if (!kiosk) return notFound(request, "Kiosk", params.kioskId);
    return json<Schemas["Kiosk"]>(request, toKiosk(state, kiosk));
  }),

  http.patch<KioskParams>(api("/kms/kiosks/:kioskId"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const kiosk = state.kiosks.get(params.kioskId);
    if (!kiosk) return notFound(request, "Kiosk", params.kioskId);

    const body = await readBody<Schemas["KioskUpdate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["name", "location", "ipAddress", "softwareVersion", "status"])
      .check(Object.keys(body).length > 0, "body", "at least one field is required");
    if (!validateKioskFields(v, body).valid) return invalid(request, v.details);

    Object.assign(kiosk, body, { updatedAt: now() });
    return json<Schemas["Kiosk"]>(request, toKiosk(state, kiosk));
  }),

  http.delete<KioskParams>(api("/kms/kiosks/:kioskId"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const kiosk = state.kiosks.get(params.kioskId);
    if (!kiosk) return notFound(request, "Kiosk", params.kioskId);
    if (kiosk.status === "ONLINE") {
      return conflict(request, "KIOSK_ONLINE", "Put the kiosk in MAINTENANCE or OFFLINE before deleting it");
    }

    state.kiosks.delete(params.kioskId);
    state.kioskDevices = state.kioskDevices.filter((d) => d.kioskId !== params.kioskId);
    state.kioskServices = state.kioskServices.filter((a) => a.kioskId !== params.kioskId);
    return noContent(request);
  }),

  // Any authenticated user: the kiosk app builds its menu from it.
  http.get<KioskParams>(api("/kms/kiosks/:kioskId/services"), async ({ request, params }) => {
    const g = await guard(request, "KMS");
    if (g.response) return g.response;

    if (!state.kiosks.has(params.kioskId)) return notFound(request, "Kiosk", params.kioskId);
    return json<{ items: Schemas["KioskService"][] }>(request, { items: computeKioskServices(state, params.kioskId) });
  }),

  http.put<KioskServiceParams>(api("/kms/kiosks/:kioskId/services/:serviceCode"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    if (!state.kiosks.has(params.kioskId)) return notFound(request, "Kiosk", params.kioskId);
    if (!state.services.has(params.serviceCode)) return notFound(request, "Service", params.serviceCode);

    const body = await readBody<Schemas["KioskServiceAssignment"]>(request);
    const v = new Validator()
      .unknownFields(body, ["enabled"])
      .check(typeof body.enabled === "boolean", "enabled", "must be a boolean");
    if (!v.valid) return invalid(request, v.details);

    let assignment = state.kioskServices.find(
      (a) => a.kioskId === params.kioskId && a.serviceCode === params.serviceCode,
    );
    if (assignment) {
      assignment.enabled = body.enabled!;
    } else {
      assignment = { kioskId: params.kioskId, serviceCode: params.serviceCode, enabled: body.enabled!, assignedAt: now() };
      state.kioskServices.push(assignment);
    }
    return json<Schemas["KioskService"]>(request, computeKioskService(state, assignment));
  }),

  http.delete<KioskServiceParams>(api("/kms/kiosks/:kioskId/services/:serviceCode"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const index = state.kioskServices.findIndex(
      (a) => a.kioskId === params.kioskId && a.serviceCode === params.serviceCode,
    );
    if (index < 0) return notFound(request, "Kiosk service", `${params.kioskId}/${params.serviceCode}`);
    state.kioskServices.splice(index, 1);
    return noContent(request);
  }),
];
