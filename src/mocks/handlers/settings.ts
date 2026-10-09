import { http } from "msw";
import type { Schemas } from "../../api/client";
import { now, state } from "../state";
import {
  api,
  CODE_PATTERN,
  conflict,
  DEVICE_CATEGORIES,
  guard,
  invalid,
  isNonEmptyString,
  isOneOf,
  json,
  KMS_ADMIN,
  KMS_READ,
  noContent,
  notFound,
  readBody,
  RECEIPT_MODES,
  REQUIREMENT_LEVELS,
  Validator,
} from "./http";

type DeviceType = Schemas["DeviceType"];
type Service = Schemas["Service"];
type DeviceTypeParams = { deviceTypeCode: string };
type ServiceParams = { serviceCode: string };
type RequirementParams = { serviceCode: string; deviceTypeCode: string };

const CODE_ISSUE = "must match ^[A-Z0-9][A-Z0-9_-]{1,31}$";

const isPositiveNumber = (value: unknown): value is number => typeof value === "number" && value > 0;
const isPositiveIntegerList = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((n) => Number.isInteger(n) && n > 0) &&
  new Set(value).size === value.length;

/** Rules shared by deposit and withdrawal settings. */
function validateAmounts(v: Validator, body: Partial<Schemas["DepositSettings"] & Schemas["WithdrawalSettings"]>) {
  v.check(typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency), "currency", "must be an ISO 4217 code")
    .check(isPositiveNumber(body.minAmount), "minAmount", "must be greater than 0")
    .check(isPositiveNumber(body.maxAmountPerTransaction), "maxAmountPerTransaction", "must be greater than 0")
    .check(isPositiveNumber(body.dailyLimitPerAccount), "dailyLimitPerAccount", "must be greater than 0")
    .check(Number.isInteger(body.maxNotesPerTransaction) && body.maxNotesPerTransaction! > 0, "maxNotesPerTransaction", "must be a positive integer")
    .check(isOneOf(RECEIPT_MODES, body.receiptMode), "receiptMode", `must be one of ${RECEIPT_MODES.join(", ")}`);
  if (v.valid) {
    v.check(body.minAmount! <= body.maxAmountPerTransaction!, "minAmount", "must be <= maxAmountPerTransaction")
      .check(body.maxAmountPerTransaction! <= body.dailyLimitPerAccount!, "maxAmountPerTransaction", "must be <= dailyLimitPerAccount");
  }
  return v;
}

export const settingsHandlers = [
  // ───────────── device catalogue ─────────────
  http.get(api("/kms/device-types"), async ({ request }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    const category = new URL(request.url).searchParams.get("category");
    if (category !== null && !isOneOf(DEVICE_CATEGORIES, category)) {
      return invalid(request, [{ field: "category", issue: "unknown category" }]);
    }
    const items = [...state.deviceTypes.values()].filter((t) => !category || t.category === category);
    return json<{ items: DeviceType[] }>(request, { items });
  }),

  http.post(api("/kms/device-types"), async ({ request }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const body = await readBody<Schemas["DeviceTypeCreate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["deviceTypeCode", "name", "category", "description"])
      .check(typeof body.deviceTypeCode === "string" && CODE_PATTERN.test(body.deviceTypeCode), "deviceTypeCode", CODE_ISSUE)
      .check(isNonEmptyString(body.name), "name", "must be a non-empty string")
      .check(isOneOf(DEVICE_CATEGORIES, body.category), "category", `must be one of ${DEVICE_CATEGORIES.join(", ")}`)
      .optional(body.description, typeof body.description === "string", "description", "must be a string");
    if (!v.valid) return invalid(request, v.details);

    const valid = body as Schemas["DeviceTypeCreate"];
    if (state.deviceTypes.has(valid.deviceTypeCode)) {
      return conflict(request, "DEVICE_TYPE_ALREADY_EXISTS", `Device type ${valid.deviceTypeCode} already exists`);
    }
    const at = now();
    const deviceType: DeviceType = { ...valid, createdAt: at, updatedAt: at };
    state.deviceTypes.set(deviceType.deviceTypeCode, deviceType);
    return json<DeviceType>(request, deviceType, 201);
  }),

  http.get<DeviceTypeParams>(api("/kms/device-types/:deviceTypeCode"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    const deviceType = state.deviceTypes.get(params.deviceTypeCode);
    if (!deviceType) return notFound(request, "Device type", params.deviceTypeCode);
    return json<DeviceType>(request, deviceType);
  }),

  http.patch<DeviceTypeParams>(api("/kms/device-types/:deviceTypeCode"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const deviceType = state.deviceTypes.get(params.deviceTypeCode);
    if (!deviceType) return notFound(request, "Device type", params.deviceTypeCode);

    const body = await readBody<Schemas["DeviceTypeUpdate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["name", "category", "description"])
      .check(Object.keys(body).length > 0, "body", "at least one field is required")
      .optional(body.name, isNonEmptyString(body.name), "name", "must be a non-empty string")
      .optional(body.category, isOneOf(DEVICE_CATEGORIES, body.category), "category", "unknown category")
      .optional(body.description, typeof body.description === "string", "description", "must be a string");
    if (!v.valid) return invalid(request, v.details);

    Object.assign(deviceType, body, { updatedAt: now() });
    return json<DeviceType>(request, deviceType);
  }),

  http.delete<DeviceTypeParams>(api("/kms/device-types/:deviceTypeCode"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const code = params.deviceTypeCode;
    if (!state.deviceTypes.has(code)) return notFound(request, "Device type", code);
    if (state.kioskDevices.some((d) => d.deviceTypeCode === code)) {
      return conflict(request, "DEVICE_TYPE_IN_USE", `${code} is installed on a kiosk`);
    }
    const usedBy = [...state.services.values()].filter((s) => s.deviceRequirements.some((r) => r.deviceTypeCode === code));
    if (usedBy.length > 0) {
      return conflict(request, "DEVICE_TYPE_IN_USE", `${code} is required by ${usedBy.map((s) => s.serviceCode).join(", ")}`);
    }
    state.deviceTypes.delete(code);
    return noContent(request);
  }),

  // ───────────── services ─────────────
  http.get(api("/kms/services"), async ({ request }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;
    return json<{ items: Service[] }>(request, { items: [...state.services.values()] });
  }),

  http.post(api("/kms/services"), async ({ request }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const body = await readBody<Schemas["ServiceCreate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["serviceCode", "name", "description", "enabled"])
      .check(typeof body.serviceCode === "string" && CODE_PATTERN.test(body.serviceCode), "serviceCode", CODE_ISSUE)
      .check(isNonEmptyString(body.name), "name", "must be a non-empty string")
      .optional(body.description, typeof body.description === "string", "description", "must be a string")
      .optional(body.enabled, typeof body.enabled === "boolean", "enabled", "must be a boolean");
    if (!v.valid) return invalid(request, v.details);

    const valid = body as Schemas["ServiceCreate"];
    if (state.services.has(valid.serviceCode)) {
      return conflict(request, "SERVICE_ALREADY_EXISTS", `Service ${valid.serviceCode} already exists`);
    }
    const at = now();
    const service: Service = {
      ...valid,
      enabled: valid.enabled ?? true,
      builtIn: false,
      deviceRequirements: [],
      createdAt: at,
      updatedAt: at,
    };
    state.services.set(service.serviceCode, service);
    return json<Service>(request, service, 201);
  }),

  http.get<ServiceParams>(api("/kms/services/:serviceCode"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    const service = state.services.get(params.serviceCode);
    if (!service) return notFound(request, "Service", params.serviceCode);
    return json<Service>(request, service);
  }),

  http.patch<ServiceParams>(api("/kms/services/:serviceCode"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const service = state.services.get(params.serviceCode);
    if (!service) return notFound(request, "Service", params.serviceCode);

    const body = await readBody<Schemas["ServiceUpdate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["name", "description", "enabled"])
      .check(Object.keys(body).length > 0, "body", "at least one field is required")
      .optional(body.name, isNonEmptyString(body.name), "name", "must be a non-empty string")
      .optional(body.description, typeof body.description === "string", "description", "must be a string")
      .optional(body.enabled, typeof body.enabled === "boolean", "enabled", "must be a boolean");
    if (!v.valid) return invalid(request, v.details);

    Object.assign(service, body, { updatedAt: now() });
    return json<Service>(request, service);
  }),

  http.delete<ServiceParams>(api("/kms/services/:serviceCode"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const service = state.services.get(params.serviceCode);
    if (!service) return notFound(request, "Service", params.serviceCode);
    if (service.builtIn) return conflict(request, "SERVICE_BUILT_IN", `${service.serviceCode} is built in`);
    const kiosks = state.kioskServices.filter((a) => a.serviceCode === service.serviceCode).map((a) => a.kioskId);
    if (kiosks.length > 0) {
      return conflict(request, "SERVICE_ASSIGNED", `${service.serviceCode} is assigned to ${kiosks.join(", ")}`);
    }
    state.services.delete(service.serviceCode);
    return noContent(request);
  }),

  // ───────────── service ↔ device type requirements ─────────────
  http.get<ServiceParams>(api("/kms/services/:serviceCode/device-requirements"), async ({ request, params }) => {
    const g = await guard(request, "KMS", KMS_READ);
    if (g.response) return g.response;

    const service = state.services.get(params.serviceCode);
    if (!service) return notFound(request, "Service", params.serviceCode);
    return json<{ items: Schemas["ServiceDeviceRequirement"][] }>(request, { items: service.deviceRequirements });
  }),

  http.put<RequirementParams>(
    api("/kms/services/:serviceCode/device-requirements/:deviceTypeCode"),
    async ({ request, params }) => {
      const g = await guard(request, "KMS", KMS_ADMIN);
      if (g.response) return g.response;

      const service = state.services.get(params.serviceCode);
      if (!service) return notFound(request, "Service", params.serviceCode);
      if (!state.deviceTypes.has(params.deviceTypeCode)) return notFound(request, "Device type", params.deviceTypeCode);

      const body = await readBody<{ requirement: Schemas["RequirementLevel"] }>(request);
      const v = new Validator()
        .unknownFields(body, ["requirement"])
        .check(isOneOf(REQUIREMENT_LEVELS, body.requirement), "requirement", `must be one of ${REQUIREMENT_LEVELS.join(", ")}`);
      if (!v.valid) return invalid(request, v.details);

      const requirement: Schemas["ServiceDeviceRequirement"] = {
        deviceTypeCode: params.deviceTypeCode,
        requirement: body.requirement!,
      };
      service.deviceRequirements = [
        ...service.deviceRequirements.filter((r) => r.deviceTypeCode !== params.deviceTypeCode),
        requirement,
      ];
      service.updatedAt = now();
      return json<Schemas["ServiceDeviceRequirement"]>(request, requirement);
    },
  ),

  http.delete<RequirementParams>(
    api("/kms/services/:serviceCode/device-requirements/:deviceTypeCode"),
    async ({ request, params }) => {
      const g = await guard(request, "KMS", KMS_ADMIN);
      if (g.response) return g.response;

      const service = state.services.get(params.serviceCode);
      if (!service) return notFound(request, "Service", params.serviceCode);
      if (!service.deviceRequirements.some((r) => r.deviceTypeCode === params.deviceTypeCode)) {
        return notFound(request, "Service device requirement", `${params.serviceCode}/${params.deviceTypeCode}`);
      }
      service.deviceRequirements = service.deviceRequirements.filter((r) => r.deviceTypeCode !== params.deviceTypeCode);
      service.updatedAt = now();
      return noContent(request);
    },
  ),

  // ───────────── deposit and withdrawal settings ─────────────
  // Read by any authenticated user: the kiosk app shows limits and preset amounts.
  http.get(api("/kms/deposit-settings"), async ({ request }) => {
    const g = await guard(request, "KMS");
    if (g.response) return g.response;
    return json<Schemas["DepositSettings"]>(request, state.depositSettings);
  }),

  http.put(api("/kms/deposit-settings"), async ({ request }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const body = await readBody<Schemas["DepositSettings"]>(request);
    const v = validateAmounts(
      new Validator().unknownFields(body, [
        "currency", "minAmount", "maxAmountPerTransaction", "dailyLimitPerAccount",
        "acceptedDenominations", "maxNotesPerTransaction", "receiptMode",
      ]),
      body,
    ).check(isPositiveIntegerList(body.acceptedDenominations), "acceptedDenominations", "must be distinct positive integers");
    if (!v.valid) return invalid(request, v.details);

    state.depositSettings = body as Schemas["DepositSettings"];
    return json<Schemas["DepositSettings"]>(request, state.depositSettings);
  }),

  http.get(api("/kms/withdrawal-settings"), async ({ request }) => {
    const g = await guard(request, "KMS");
    if (g.response) return g.response;
    return json<Schemas["WithdrawalSettings"]>(request, state.withdrawalSettings);
  }),

  http.put(api("/kms/withdrawal-settings"), async ({ request }) => {
    const g = await guard(request, "KMS", KMS_ADMIN);
    if (g.response) return g.response;

    const body = await readBody<Schemas["WithdrawalSettings"]>(request);
    const v = validateAmounts(
      new Validator().unknownFields(body, [
        "currency", "minAmount", "maxAmountPerTransaction", "dailyLimitPerAccount", "amountMultipleOf",
        "dispensableDenominations", "maxNotesPerTransaction", "presetAmounts", "receiptMode",
      ]),
      body,
    )
      .check(Number.isInteger(body.amountMultipleOf) && body.amountMultipleOf! > 0, "amountMultipleOf", "must be a positive integer")
      .check(isPositiveIntegerList(body.dispensableDenominations), "dispensableDenominations", "must be distinct positive integers")
      .check(
        Array.isArray(body.presetAmounts) && body.presetAmounts.every(isPositiveNumber) && new Set(body.presetAmounts).size === body.presetAmounts.length,
        "presetAmounts",
        "must be distinct amounts greater than 0",
      );
    if (v.valid) {
      const settings = body as Schemas["WithdrawalSettings"];
      v.check(
        settings.dispensableDenominations.every((d) => d % settings.amountMultipleOf === 0),
        "dispensableDenominations",
        "every note must be a multiple of amountMultipleOf",
      ).check(
        settings.presetAmounts.every(
          (a) => a >= settings.minAmount && a <= settings.maxAmountPerTransaction && a % settings.amountMultipleOf === 0,
        ),
        "presetAmounts",
        "must be within [minAmount, maxAmountPerTransaction] and multiples of amountMultipleOf",
      );
    }
    if (!v.valid) return invalid(request, v.details);

    state.withdrawalSettings = body as Schemas["WithdrawalSettings"];
    return json<Schemas["WithdrawalSettings"]>(request, state.withdrawalSettings);
  }),
];
