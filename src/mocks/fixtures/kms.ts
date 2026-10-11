import type { Schemas } from "../../api/client";
import { CURRENCY } from "./banking";

type DeviceStatus = Schemas["DeviceStatus"];

/** Stored kiosk; `health` and `deviceCount` are computed on read. */
export type KioskRecord = Omit<Schemas["Kiosk"], "health" | "deviceCount">;

/** Assignment of a service to a kiosk; availability is computed on read. */
export interface KioskServiceRecord {
  kioskId: string;
  serviceCode: string;
  enabled: boolean;
  assignedAt: string;
}

const T0 = "2026-09-01T08:00:00Z";

export const deviceTypes: Schemas["DeviceType"][] = (
  [
    ["CARD_READER", "Lecteur de carte", "CARD"],
    ["PIN_PAD", "Clavier PIN", "INPUT"],
    ["TOUCH_SCREEN", "Écran tactile", "DISPLAY"],
    ["CASH_ACCEPTOR", "Accepteur de billets", "CASH"],
    ["CASH_DISPENSER", "Distributeur de billets", "CASH"],
    ["RECEIPT_PRINTER", "Imprimante de tickets", "PRINTER"],
    ["BARCODE_SCANNER", "Lecteur de code-barres", "INPUT"],
    ["CAMERA", "Caméra (selfie, surveillance)", "SENSOR"],
    ["ID_SCANNER", "Scanner de pièce d'identité", "INPUT"],
  ] as const
).map(([deviceTypeCode, name, category]) => ({ deviceTypeCode, name, category, createdAt: T0, updatedAt: T0 }));

const core = [
  { deviceTypeCode: "CARD_READER", requirement: "MANDATORY" },
  { deviceTypeCode: "PIN_PAD", requirement: "MANDATORY" },
  { deviceTypeCode: "TOUCH_SCREEN", requirement: "MANDATORY" },
] as const satisfies Schemas["ServiceDeviceRequirement"][];

const service = (
  serviceCode: string,
  name: string,
  deviceRequirements: Schemas["ServiceDeviceRequirement"][],
  builtIn = true,
): Schemas["Service"] => ({ serviceCode, name, enabled: true, builtIn, deviceRequirements, createdAt: T0, updatedAt: T0 });

export const services: Schemas["Service"][] = [
  service("DEPOSIT", "Dépôt", [
    ...core,
    { deviceTypeCode: "CASH_ACCEPTOR", requirement: "MANDATORY" },
    { deviceTypeCode: "RECEIPT_PRINTER", requirement: "OPTIONAL" },
  ]),
  service("WITHDRAWAL", "Retrait", [
    ...core,
    { deviceTypeCode: "CASH_DISPENSER", requirement: "MANDATORY" },
    { deviceTypeCode: "RECEIPT_PRINTER", requirement: "RECOMMENDED" },
  ]),
  service("BALANCE", "Consultation du solde", [...core, { deviceTypeCode: "RECEIPT_PRINTER", requirement: "OPTIONAL" }]),
  service("HISTORY", "Historique des opérations", [
    ...core,
    { deviceTypeCode: "RECEIPT_PRINTER", requirement: "OPTIONAL" },
  ]),
  service("ACCOUNT_OPENING", "Ouverture de compte", [
    { deviceTypeCode: "TOUCH_SCREEN", requirement: "MANDATORY" },
    { deviceTypeCode: "ID_SCANNER", requirement: "MANDATORY" },
    { deviceTypeCode: "CAMERA", requirement: "MANDATORY" },
    { deviceTypeCode: "RECEIPT_PRINTER", requirement: "RECOMMENDED" },
  ]),
  service("STATEMENT", "Relevé de compte imprimé", [
    ...core,
    { deviceTypeCode: "RECEIPT_PRINTER", requirement: "MANDATORY" },
  ], false),
];

export const kiosks: KioskRecord[] = [
  {
    kioskId: "KIOSK-01",
    name: "Kiosque Agence Centre",
    location: { branchCode: "AG-001", branchName: "Agence Centre", address: "12 bd Mohammed V", city: "Casablanca" },
    ipAddress: "10.10.1.21",
    softwareVersion: "0.1.0",
    status: "ONLINE",
    lastSeenAt: "2026-10-05T07:59:00Z",
    createdAt: T0,
    updatedAt: T0,
  },
  {
    kioskId: "KIOSK-02",
    name: "Kiosque Agence Agdal",
    location: { branchCode: "AG-002", branchName: "Agence Agdal", city: "Rabat" },
    ipAddress: "10.10.2.21",
    softwareVersion: "0.1.0",
    status: "ONLINE",
    lastSeenAt: "2026-10-05T07:55:00Z",
    createdAt: T0,
    updatedAt: T0,
  },
  {
    kioskId: "KIOSK-03",
    name: "Kiosque Agence Guéliz",
    location: { branchCode: "AG-003", branchName: "Agence Guéliz", city: "Marrakech" },
    ipAddress: "10.10.3.21",
    softwareVersion: "0.0.9",
    status: "OFFLINE",
    lastSeenAt: "2026-10-04T18:12:00Z",
    createdAt: T0,
    updatedAt: T0,
  },
];

const FULL_SET = ["CARD_READER", "PIN_PAD", "TOUCH_SCREEN", "CASH_ACCEPTOR", "CASH_DISPENSER", "RECEIPT_PRINTER"];

/** Status changes after installation, per kiosk and device type (oldest first). */
const incidents: Record<string, Record<string, [DeviceStatus, string, string, string][]>> = {
  "KIOSK-02": {
    CASH_ACCEPTOR: [
      ["WARNING", "NEAR_FULL", "Cassette à 90 %", "2026-10-04T15:10:00Z"],
      ["ERROR", "JAM", "Billet coincé", "2026-10-05T07:40:00Z"],
    ],
    RECEIPT_PRINTER: [
      ["WARNING", "PAPER_LOW", "Papier bientôt épuisé", "2026-10-04T16:00:00Z"],
      ["ERROR", "OUT_OF_PAPER", "Papier épuisé", "2026-10-05T07:50:00Z"],
    ],
  },
  "KIOSK-03": Object.fromEntries(
    ["CARD_READER", "PIN_PAD", "TOUCH_SCREEN", "CASH_ACCEPTOR"].map((type) => [
      type,
      [["OFFLINE", "NOT_RESPONDING", "Kiosque injoignable", "2026-10-04T18:15:00Z"]],
    ]),
  ),
};

const devicesByKiosk: Record<string, string[]> = {
  "KIOSK-01": [...FULL_SET, "CAMERA", "ID_SCANNER"],
  "KIOSK-02": FULL_SET,
  "KIOSK-03": ["CARD_READER", "PIN_PAD", "TOUCH_SCREEN", "CASH_ACCEPTOR"],
};

export const kioskDevices: Schemas["KioskDevice"][] = [];
export const statusHistory: Schemas["DeviceStatusChange"][] = [];

let changeSeq = 0;
for (const [kioskId, types] of Object.entries(devicesByKiosk)) {
  types.forEach((deviceTypeCode, i) => {
    const deviceId = `DEV-${kioskId.slice(-2)}${String(i + 1).padStart(2, "0")}`;
    const device: Schemas["KioskDevice"] = {
      deviceId,
      kioskId,
      deviceTypeCode,
      serialNumber: `SN-${kioskId.slice(-2)}-${deviceTypeCode}`,
      manufacturer: "Demo Devices",
      model: `${deviceTypeCode}-X1`,
      firmwareVersion: "1.0.0",
      status: "OPERATIONAL",
      statusChangedAt: T0,
      installedAt: T0,
      updatedAt: T0,
    };
    const change = (fields: Partial<Schemas["DeviceStatusChange"]> & Pick<Schemas["DeviceStatusChange"], "newStatus" | "changedAt">) =>
      statusHistory.push({
        changeId: `CHG-${String(++changeSeq).padStart(4, "0")}`,
        kioskId,
        deviceId,
        deviceTypeCode,
        source: "SYSTEM",
        correlationId: `00000000-0000-4000-9000-${String(changeSeq).padStart(12, "0")}`,
        ...fields,
      });
    change({ newStatus: "OPERATIONAL", reason: "Installation", changedAt: T0 });
    for (const [status, reasonCode, reason, at] of incidents[kioskId]?.[deviceTypeCode] ?? []) {
      change({ previousStatus: device.status, newStatus: status, reasonCode, reason, source: "DEVICE", changedAt: at });
      Object.assign(device, { status, statusReasonCode: reasonCode, statusReason: reason, statusChangedAt: at, updatedAt: at });
    }
    kioskDevices.push(device);
  });
}

export const kioskServices: KioskServiceRecord[] = [
  ...["KIOSK-01", "KIOSK-02"].flatMap((kioskId) =>
    ["DEPOSIT", "WITHDRAWAL", "BALANCE", "HISTORY"].map((serviceCode) => ({ kioskId, serviceCode, enabled: true, assignedAt: T0 })),
  ),
  ...["DEPOSIT", "BALANCE"].map((serviceCode) => ({ kioskId: "KIOSK-03", serviceCode, enabled: true, assignedAt: T0 })),
  // KIOSK-02 has no camera nor ID scanner: account opening is UNAVAILABLE there.
  ...["KIOSK-01", "KIOSK-02"].map((kioskId) => ({ kioskId, serviceCode: "ACCOUNT_OPENING", enabled: true, assignedAt: T0 })),
];

export const depositSettings: Schemas["DepositSettings"] = {
  currency: CURRENCY,
  minAmount: 50,
  maxAmountPerTransaction: 20000,
  dailyLimitPerAccount: 50000,
  acceptedDenominations: [20, 50, 100, 200],
  maxNotesPerTransaction: 200,
  receiptMode: "ON_REQUEST",
};

export const withdrawalSettings: Schemas["WithdrawalSettings"] = {
  currency: CURRENCY,
  minAmount: 100,
  maxAmountPerTransaction: 5000,
  dailyLimitPerAccount: 10000,
  amountMultipleOf: 100,
  dispensableDenominations: [100, 200],
  maxNotesPerTransaction: 40,
  presetAmounts: [200, 500, 1000, 2000],
  receiptMode: "ON_REQUEST",
};
