import type { Schemas } from "../api/client";
import * as fx from "./fixtures";

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
  withdrawalSettings: Schemas["WithdrawalSettings"];
  /** Sequence for generated ids (devices, status changes). */
  seq: number;
}

const clone = <T>(value: T): T => structuredClone(value);

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
    seq: 1000,
  } satisfies MockState);
}

export const nextId = (prefix: string): string => `${prefix}-${++state.seq}`;

export const now = (): string => new Date().toISOString();

resetMockState();
