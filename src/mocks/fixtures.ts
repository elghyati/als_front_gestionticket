import type { Schemas } from "../api/client";

type User = Schemas["User"];
type Balance = Schemas["Balance"];
type Transaction = Schemas["TransactionEnvelope"];
type TerminalDetail = Schemas["TerminalDetail"];

export const CURRENCY = "MAD";

export interface MockUser extends User {
  /** Kiosk login */
  cardNumber?: string;
  pin?: string;
  /** Portal login */
  username?: string;
  password?: string;
}

export const users: MockUser[] = [
  {
    id: "U-CUST-1",
    displayName: "Client Démo",
    roles: ["CUSTOMER"],
    accountIds: ["ACC-001", "ACC-002"],
    cardNumber: "4000000000000001",
    pin: "1234",
  },
  { id: "U-AGENT-1", displayName: "Agent Démo", roles: ["AGENT"], username: "agent", password: "agent" },
  {
    id: "U-SUP-1",
    displayName: "Superviseur Démo",
    roles: ["SUPERVISOR"],
    username: "superviseur",
    password: "superviseur",
  },
  { id: "U-ADMIN-1", displayName: "Admin Démo", roles: ["ADMIN"], username: "admin", password: "admin" },
];

export const tokenFor = (user: User): string => `mock-token-${user.id}`;

const balances: Balance[] = [
  {
    accountId: "ACC-001",
    available: { amount: 1520.5, currency: CURRENCY },
    ledger: { amount: 1520.5, currency: CURRENCY },
    asOf: "2026-10-05T08:00:00Z",
  },
  {
    accountId: "ACC-002",
    available: { amount: 80, currency: CURRENCY },
    ledger: { amount: 100, currency: CURRENCY },
    asOf: "2026-10-05T08:00:00Z",
  },
];

const transactions: Transaction[] = Array.from({ length: 25 }, (_, i) => ({
  transactionId: `TX-${String(1000 + i)}`,
  correlationId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  type: i % 5 === 0 ? "WITHDRAWAL" : "DEPOSIT",
  status: "ACCEPTED",
  accountId: "ACC-001",
  terminalId: "KIOSK-01",
  amount: { amount: 50 + i * 10, currency: CURRENCY },
  createdAt: new Date(Date.UTC(2026, 8, 1 + i, 10)).toISOString(),
}));

const terminals: TerminalDetail[] = [
  {
    terminalId: "KIOSK-01",
    name: "Kiosque Agence Centre",
    location: "Casablanca – Centre",
    status: "ONLINE",
    lastSeenAt: "2026-10-05T07:59:00Z",
    softwareVersion: "0.1.0",
    services: [
      { service: "DEPOSIT", available: true },
      { service: "BALANCE", available: true },
      { service: "HISTORY", available: true },
      { service: "PRINTER", available: true },
      { service: "CASH_ACCEPTOR", available: true },
    ],
  },
  {
    terminalId: "KIOSK-02",
    name: "Kiosque Agence Nord",
    location: "Rabat – Agdal",
    status: "DEGRADED",
    lastSeenAt: "2026-10-05T07:55:00Z",
    softwareVersion: "0.1.0",
    services: [
      { service: "DEPOSIT", available: false, reason: "Cash acceptor jammed" },
      { service: "BALANCE", available: true },
      { service: "HISTORY", available: true },
      { service: "PRINTER", available: false, reason: "Out of paper" },
      { service: "CASH_ACCEPTOR", available: false, reason: "Jammed" },
    ],
  },
  {
    terminalId: "KIOSK-03",
    name: "Kiosque Agence Sud",
    location: "Marrakech – Guéliz",
    status: "OFFLINE",
    lastSeenAt: "2026-10-04T18:12:00Z",
    softwareVersion: "0.0.9",
    services: [],
  },
];

/** Mutable mock state. Deposits update it; `resetMockState()` restores the fixtures. */
export interface MockState {
  balances: Map<string, Balance>;
  transactions: Transaction[];
  terminals: TerminalDetail[];
  depositsByIdempotencyKey: Map<string, Transaction>;
}

const clone = <T>(value: T): T => structuredClone(value);

export const state: MockState = {
  balances: new Map(),
  transactions: [],
  terminals: [],
  depositsByIdempotencyKey: new Map(),
};

export function resetMockState(): void {
  state.balances = new Map(balances.map((b) => [b.accountId, clone(b)]));
  state.transactions = clone(transactions);
  state.terminals = clone(terminals);
  state.depositsByIdempotencyKey = new Map();
}

resetMockState();
