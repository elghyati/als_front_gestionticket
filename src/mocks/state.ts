import type { Schemas } from "../api/client";
import * as fx from "./fixtures";
import { evaluateKyc } from "./kyc/rules";

/** Mutable mock state. Handlers change it; `resetMockState()` restores the fixtures. */
export interface MockState {
  balances: Map<string, Schemas["Balance"]>;
  transactions: Schemas["TransactionEnvelope"][];
  /** Accepted operations by `<DEPOSIT|WITHDRAWAL>:<Idempotency-Key>`. */
  idempotency: Map<string, Schemas["TransactionEnvelope"]>;
  kiosks: Map<string, fx.KioskRecord>;
  kioskDevices: Schemas["KioskDevice"][];
  kioskServices: fx.KioskServiceRecord[];
  statusHistory: Schemas["DeviceStatusChange"][];
  deviceTypes: Map<string, Schemas["DeviceType"]>;
  services: Map<string, Schemas["Service"]>;
  depositSettings: Schemas["DepositSettings"];
  /** Account opening applications by id. */
  applications: Map<string, Schemas["AccountApplication"]>;
  /** Application token → applicationId (KIOSK channel). */
  applicationTokens: Map<string, string>;
  /** Pending SMS codes by applicationId. */
  otps: Map<string, PendingOtp>;
  /** ID document numbers of customers (existing ones and accounts opened since). */
  customerIdNumbers: Set<string>;
  withdrawalSettings: Schemas["WithdrawalSettings"];
  /** Sequence for generated ids. Starts above every demo id (TX-1024, APP-1004…) so they never collide. */
  seq: number;
}

export interface PendingOtp {
  code: string;
  expiresAt: number;
  attemptsLeft: number;
}

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_ATTEMPTS = 3;

const clone = <T>(value: T): T => structuredClone(value);

function seedApplications(): Map<string, Schemas["AccountApplication"]> {
  const existingCustomerIds = new Set(fx.EXISTING_CUSTOMER_ID_NUMBERS);
  return new Map(
    fx.applications.map(({ application }) => {
      const app = clone(application);
      if (app.submittedAt) app.kyc = evaluateKyc(app, { today: new Date(app.submittedAt), existingCustomerIds });
      return [app.applicationId, app];
    }),
  );
}

export const state = {} as MockState;

export function resetMockState(): void {
  Object.assign(state, {
    balances: new Map(fx.balances.map((b) => [b.accountId, clone(b)])),
    transactions: clone(fx.transactions),
    idempotency: new Map(),
    kiosks: new Map(fx.kiosks.map((k) => [k.kioskId, clone(k)])),
    kioskDevices: clone(fx.kioskDevices),
    kioskServices: clone(fx.kioskServices),
    statusHistory: clone(fx.statusHistory),
    deviceTypes: new Map(fx.deviceTypes.map((t) => [t.deviceTypeCode, clone(t)])),
    services: new Map(fx.services.map((s) => [s.serviceCode, clone(s)])),
    depositSettings: clone(fx.depositSettings),
    withdrawalSettings: clone(fx.withdrawalSettings),
    applications: seedApplications(),
    applicationTokens: new Map(
      fx.applications.flatMap(({ application, token }) => (token ? [[token, application.applicationId] as const] : [])),
    ),
    otps: new Map(
      fx.applications
        .filter((f) => f.otpPending)
        .map((f) => [
          f.application.applicationId,
          { code: fx.MOCK_OTP_CODE, expiresAt: Date.now() + OTP_TTL_MS, attemptsLeft: OTP_ATTEMPTS },
        ]),
    ),
    customerIdNumbers: new Set(fx.EXISTING_CUSTOMER_ID_NUMBERS),
    seq: 5000,
  } satisfies MockState);
}

export const nextId = (prefix: string): string => `${prefix}-${++state.seq}`;

export const now = (): string => new Date().toISOString();

resetMockState();
