import type { Schemas } from "../../api/client";

export const CURRENCY = "MAD";

export const balances: Schemas["Balance"][] = [
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

export const transactions: Schemas["TransactionEnvelope"][] = Array.from({ length: 25 }, (_, i) => ({
  transactionId: `TX-${String(1000 + i)}`,
  correlationId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  type: i % 5 === 0 ? "WITHDRAWAL" : "DEPOSIT",
  status: "ACCEPTED",
  accountId: "ACC-001",
  kioskId: "KIOSK-01",
  amount: { amount: 50 + i * 10, currency: CURRENCY },
  createdAt: new Date(Date.UTC(2026, 8, 1 + i, 10)).toISOString(),
}));
