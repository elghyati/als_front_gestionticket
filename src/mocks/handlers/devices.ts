import { http } from "msw";
import type { Schemas } from "../../api/client";
import { now, nextId, state } from "../state";
import {
  api,
  CHANGE_SOURCES,
  conflict,
  correlationIdOf,
  dateRange,
  DEVICE_STATUSES,
  guard,
  invalid,
  isNonEmptyString,
  isOneOf,
  json,
  KMS_ADMIN,
  KMS_OPERATE,
  KMS_READ,
  newestFirst,
  noContent,
  notFound,
  paginate,
  readBody,
  Validator,
} from "./http";

type Device = Schemas["KioskDevice"];
type StatusChange = Schemas["DeviceStatusChange"];
type KioskParams = { kioskId: string };
type DeviceParams = { kioskId: string; deviceId: string };

const findDevice = (kioskId: string, deviceId: string) =>
  state.kioskDevices.find((d) => d.kioskId === kioskId && d.deviceId === deviceId);

const serialTaken = (deviceTypeCode: string, serialNumber: string, exceptDeviceId?: string) =>
  state.kioskDevices.some(
    (d) => d.deviceTypeCode === deviceTypeCode && d.serialNumber === serialNumber && d.deviceId !== exceptDeviceId,
  );

function recordChange(request: Request, device: Device, change: Omit<StatusChange, "changeId" | "kioskId" | "deviceId" | "deviceTypeCode" | "correlationId">) {
  state.statusHistory.push({
    changeId: nextId("CHG"),
    kioskId: device.kioskId,
    deviceId: device.deviceId,
    deviceTypeCode: device.deviceTypeCode,
    correlationId: correlationIdOf(request),
    ...change,
  });
}

/** Filters by date range, sorts newest first and paginates. */
function historyPage(request: Request, entries: StatusChange[]) {
  const range = dateRange(request);
  if (range.response) return range.response;
  const filtered = entries
    .filter((c) => (!range.from || c.changedAt >= range.from) && (!range.to || c.changedAt < range.to))
    .sort(newestFirst);
  const p = paginate(request, filtered);
  if (p.response) return p.response;
  return json<Schemas["DeviceStatusHistoryPage"]>(request, p.page);
}

function validateDeviceFields(v: Validator, body: Partial<Schemas["KioskDeviceCreate"]>) {
  return v
    .optional(body.serialNumber, isNonEmptyString(body.serialNumber), "serialNumber", "must be a non-empty string")
    .optional(body.manufacturer, typeof body.manufacturer === "string", "manufacturer", "must be a string")
    .optional(body.model, typeof body.model === "string", "model", "must be a string")
    .optional(body.firmwareVersion, typeof body.firmwareVersion === "string", "firmwareVersion", "must be a string");
}

export const deviceHandlers = [
  http.get<KioskParams>(api("/kms/kiosks/:kioskId/devices"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    if (!state.kiosks.has(params.kioskId)) return notFound(request, "Kiosk", params.kioskId);
    const status = new URL(request.url).searchParams.get("status");
    if (status !== null && !isOneOf(DEVICE_STATUSES, status)) {
      return invalid(request, [{ field: "status", issue: "unknown status" }]);
    }
    const items = state.kioskDevices.filter((d) => d.kioskId === params.kioskId && (!status || d.status === status));
    return json<{ items: Device[] }>(request, { items });
  }),

  http.post<KioskParams>(api("/kms/kiosks/:kioskId/devices"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    if (!state.kiosks.has(params.kioskId)) return notFound(request, "Kiosk", params.kioskId);

    const body = await readBody<Schemas["KioskDeviceCreate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["deviceTypeCode", "serialNumber", "manufacturer", "model", "firmwareVersion", "status"])
      .check(typeof body.deviceTypeCode === "string" && state.deviceTypes.has(body.deviceTypeCode), "deviceTypeCode", "unknown device type")
      .check(body.serialNumber !== undefined, "serialNumber", "is required")
      .optional(body.status, isOneOf(DEVICE_STATUSES, body.status), "status", "unknown status");
    if (!validateDeviceFields(v, body).valid) return invalid(request, v.details);

    const valid = body as Schemas["KioskDeviceCreate"];
    if (serialTaken(valid.deviceTypeCode, valid.serialNumber)) {
      return conflict(request, "DEVICE_SERIAL_EXISTS", `${valid.deviceTypeCode} ${valid.serialNumber} is already installed`);
    }

    const at = now();
    const device: Device = {
      ...valid,
      deviceId: nextId("DEV"),
      kioskId: params.kioskId,
      status: valid.status ?? "OPERATIONAL",
      statusChangedAt: at,
      installedAt: at,
      updatedAt: at,
    };
    state.kioskDevices.push(device);
    recordChange(request, device, {
      newStatus: device.status,
      reason: "Installation",
      source: "OPERATOR",
      changedBy: g.user.id,
      changedAt: at,
    });
    return json<Device>(request, device, 201);
  }),

  http.get<DeviceParams>(api("/kms/kiosks/:kioskId/devices/:deviceId"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    const device = findDevice(params.kioskId, params.deviceId);
    if (!device) return notFound(request, "Device", params.deviceId);
    return json<Device>(request, device);
  }),

  http.patch<DeviceParams>(api("/kms/kiosks/:kioskId/devices/:deviceId"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const device = findDevice(params.kioskId, params.deviceId);
    if (!device) return notFound(request, "Device", params.deviceId);

    const body = await readBody<Schemas["KioskDeviceUpdate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["serialNumber", "manufacturer", "model", "firmwareVersion"])
      .check(Object.keys(body).length > 0, "body", "at least one field is required");
    if (!validateDeviceFields(v, body).valid) return invalid(request, v.details);

    if (body.serialNumber && serialTaken(device.deviceTypeCode, body.serialNumber, device.deviceId)) {
      return conflict(request, "DEVICE_SERIAL_EXISTS", `${device.deviceTypeCode} ${body.serialNumber} is already installed`);
    }
    Object.assign(device, body, { updatedAt: now() });
    return json<Device>(request, device);
  }),

  http.delete<DeviceParams>(api("/kms/kiosks/:kioskId/devices/:deviceId"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const device = findDevice(params.kioskId, params.deviceId);
    if (!device) return notFound(request, "Device", params.deviceId);
    state.kioskDevices = state.kioskDevices.filter((d) => d !== device);
    return noContent(request);
  }),

  http.put<DeviceParams>(api("/kms/kiosks/:kioskId/devices/:deviceId/status"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_OPERATE);
    if (g.response) return g.response;

    const device = findDevice(params.kioskId, params.deviceId);
    if (!device) return notFound(request, "Device", params.deviceId);

    const body = await readBody<Schemas["DeviceStatusChangeRequest"]>(request);
    const v = new Validator()
      .unknownFields(body, ["status", "reasonCode", "reason", "source"])
      .check(isOneOf(DEVICE_STATUSES, body.status), "status", `must be one of ${DEVICE_STATUSES.join(", ")}`)
      .optional(body.reasonCode, typeof body.reasonCode === "string", "reasonCode", "must be a string")
      .optional(body.reason, typeof body.reason === "string", "reason", "must be a string")
      .optional(body.source, isOneOf(CHANGE_SOURCES, body.source), "source", `must be one of ${CHANGE_SOURCES.join(", ")}`);
    if (!v.valid) return invalid(request, v.details);
    const { status, reasonCode, reason, source = "OPERATOR" } = body as Schemas["DeviceStatusChangeRequest"];

    // Same status and reason: idempotent, no history entry.
    if (status === device.status && reasonCode === device.statusReasonCode) return json<Device>(request, device);

    const at = now();
    recordChange(request, device, {
      previousStatus: device.status,
      newStatus: status,
      ...(reasonCode !== undefined && { reasonCode }),
      ...(reason !== undefined && { reason }),
      source,
      ...(source === "OPERATOR" && { changedBy: g.user.id }),
      changedAt: at,
    });
    device.status = status;
    device.statusChangedAt = at;
    device.updatedAt = at;
    if (reasonCode !== undefined) device.statusReasonCode = reasonCode;
    else delete device.statusReasonCode;
    if (reason !== undefined) device.statusReason = reason;
    else delete device.statusReason;
    return json<Device>(request, device);
  }),

  http.get<DeviceParams>(api("/kms/kiosks/:kioskId/devices/:deviceId/status-history"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    // History outlives the device, so a removed device keeps its history.
    const entries = state.statusHistory.filter((c) => c.kioskId === params.kioskId && c.deviceId === params.deviceId);
    if (entries.length === 0 && !findDevice(params.kioskId, params.deviceId)) {
      return notFound(request, "Device", params.deviceId);
    }
    return historyPage(request, entries);
  }),

  http.get<KioskParams>(api("/kms/kiosks/:kioskId/status-history"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    const entries = state.statusHistory.filter((c) => c.kioskId === params.kioskId);
    if (entries.length === 0 && !state.kiosks.has(params.kioskId)) return notFound(request, "Kiosk", params.kioskId);

    const query = new URL(request.url).searchParams;
    const deviceTypeCode = query.get("deviceTypeCode");
    const status = query.get("status");
    if (status !== null && !isOneOf(DEVICE_STATUSES, status)) {
      return invalid(request, [{ field: "status", issue: "unknown status" }]);
    }
    return historyPage(
      request,
      entries.filter((c) => (!deviceTypeCode || c.deviceTypeCode === deviceTypeCode) && (!status || c.newStatus === status)),
    );
  }),
];
