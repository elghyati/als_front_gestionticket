/**
 * Service availability rules, as described in the contract:
 * a device is usable when OPERATIONAL or WARNING; for each device type a
 * service requires, a kiosk without a usable device of that type makes the
 * service UNAVAILABLE (MANDATORY), DEGRADED (RECOMMENDED) or leaves it
 * AVAILABLE with a reported issue (OPTIONAL).
 */
import type { Schemas } from "../../api/client";
import type { KioskRecord, KioskServiceRecord } from "../fixtures";
import type { MockState } from "../state";

type Issue = Schemas["AvailabilityIssue"];
type Availability = Schemas["ServiceAvailabilityStatus"];

const USABLE: Schemas["DeviceStatus"][] = ["OPERATIONAL", "WARNING"];

export const isUsable = (status: Schemas["DeviceStatus"]): boolean => USABLE.includes(status);

export function computeKioskService(state: MockState, assignment: KioskServiceRecord): Schemas["KioskService"] {
  const service = state.services.get(assignment.serviceCode);
  const kiosk = state.kiosks.get(assignment.kioskId);
  const blocking: Issue[] = [];
  const degrading: Issue[] = [];
  const informative: Issue[] = [];

  if (!service?.enabled) {
    blocking.push({ reasonCode: "SERVICE_DISABLED", message: "Service disabled globally" });
  }
  if (!assignment.enabled) {
    blocking.push({ reasonCode: "SERVICE_DISABLED_ON_KIOSK", message: "Service disabled on this kiosk" });
  }
  if (kiosk?.status !== "ONLINE") {
    blocking.push({ reasonCode: "KIOSK_NOT_ONLINE", message: `Kiosk is ${kiosk?.status ?? "unknown"}` });
  }

  for (const { deviceTypeCode, requirement } of service?.deviceRequirements ?? []) {
    const devices = state.kioskDevices.filter(
      (d) => d.kioskId === assignment.kioskId && d.deviceTypeCode === deviceTypeCode,
    );
    if (devices.some((d) => isUsable(d.status))) continue;

    const issue: Issue =
      devices.length === 0
        ? { reasonCode: "DEVICE_MISSING", message: `No ${deviceTypeCode} installed`, deviceTypeCode, requirement }
        : {
            reasonCode: "DEVICE_NOT_USABLE",
            message: `${deviceTypeCode} is ${devices.map((d) => d.status).join(", ")}`,
            deviceTypeCode,
            requirement,
          };
    ({ MANDATORY: blocking, RECOMMENDED: degrading, OPTIONAL: informative })[requirement].push(issue);
  }

  const availability: Availability =
    blocking.length > 0 ? "UNAVAILABLE" : degrading.length > 0 ? "DEGRADED" : "AVAILABLE";

  return {
    serviceCode: assignment.serviceCode,
    name: service?.name ?? assignment.serviceCode,
    enabled: assignment.enabled,
    availability,
    issues: [...blocking, ...degrading, ...informative],
    assignedAt: assignment.assignedAt,
  };
}

export function computeKioskServices(state: MockState, kioskId: string): Schemas["KioskService"][] {
  return state.kioskServices
    .filter((a) => a.kioskId === kioskId)
    .map((a) => computeKioskService(state, a));
}

/** Availability of one service on one kiosk; UNAVAILABLE when the service is not assigned. */
export function serviceAvailabilityOn(state: MockState, kioskId: string, serviceCode: string) {
  const assignment = state.kioskServices.find((a) => a.kioskId === kioskId && a.serviceCode === serviceCode);
  return assignment ? computeKioskService(state, assignment) : undefined;
}

export function computeKioskHealth(state: MockState, kiosk: KioskRecord): Schemas["KioskHealth"] {
  if (kiosk.status !== "ONLINE") return "OUT_OF_SERVICE";
  const services = computeKioskServices(state, kiosk.kioskId);
  if (services.length > 0 && services.every((s) => s.availability === "UNAVAILABLE")) return "OUT_OF_SERVICE";
  const devices = state.kioskDevices.filter((d) => d.kioskId === kiosk.kioskId);
  if (services.some((s) => s.availability !== "AVAILABLE") || devices.some((d) => !isUsable(d.status))) {
    return "DEGRADED";
  }
  return "HEALTHY";
}

export function toKiosk(state: MockState, kiosk: KioskRecord): Schemas["Kiosk"] {
  return {
    ...kiosk,
    health: computeKioskHealth(state, kiosk),
    deviceCount: state.kioskDevices.filter((d) => d.kioskId === kiosk.kioskId).length,
  };
}
