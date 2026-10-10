/**
 * Deposit and withdrawal. Both check, in order: request shape (400), the
 * `refused` scenario, the service availability on the kiosk, the service
 * settings and, for a withdrawal, the available balance (422).
 */
import { http } from "msw";
import type { Schemas } from "../../api/client";
import type { MockUser } from "../fixtures";
import { serviceAvailabilityOn } from "../kms/availability";
import { scenarioFor } from "../scenarios";
import { now, nextId, state } from "../state";
import { canAccessAccount } from "./accounts";
import { api, correlationIdOf, error, guard, invalid, json, readBody, Validator } from "./http";

type Transaction = Schemas["TransactionEnvelope"];
type CashNotes = Schemas["CashNotes"];
type Kind = "DEPOSIT" | "WITHDRAWAL";

const refuse = (request: Request, code: string, message: string) =>
  error(request, 422, code, message, { retryable: false });

const countNotes = (notes: CashNotes) => notes.reduce((n, note) => n + note.count, 0);

const isToday = (iso: string) => iso.slice(0, 10) === new Date().toISOString().slice(0, 10);

function totalToday(accountId: string, type: Kind): number {
  return state.transactions
    .filter((t) => t.accountId === accountId && t.type === type && t.status === "ACCEPTED" && isToday(t.createdAt))
    .reduce((sum, t) => sum + t.amount.amount, 0);
}

/** Fewest notes, largest first; undefined when the amount cannot be made exactly. */
export function breakdown(amount: number, denominations: number[]): CashNotes | undefined {
  let rest = amount;
  const notes: CashNotes = [];
  for (const denomination of [...denominations].sort((a, b) => b - a)) {
    const count = Math.floor(rest / denomination);
    if (count > 0) {
      notes.push({ denomination, count });
      rest -= count * denomination;
    }
  }
  return rest === 0 ? notes : undefined;
}

interface CashRequest {
  accountId: string;
  kioskId: string;
  amount: Schemas["Money"];
  notes?: CashNotes;
}

/** Common steps of a cash operation; `rules` returns a refusal, or the notes to record. */
async function cashOperation(
  request: Request,
  kind: Kind,
  rules: (body: CashRequest, user: MockUser) => Response | { notes?: CashNotes },
) {
  const g = await guard(request, "CBS");
  if (g.response) return g.response;

  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return error(request, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
  }
  // Keys are scoped per operation: a withdrawal never replays a deposit.
  const scopedKey = `${kind}:${idempotencyKey}`;
  const previous = state.idempotency.get(scopedKey);
  if (previous) return json<Transaction>(request, previous, 201);

  const body = await readBody<CashRequest>(request);
  const settings = kind === "DEPOSIT" ? state.depositSettings : state.withdrawalSettings;
  const v = new Validator()
    .check(typeof body.amount?.amount === "number" && body.amount.amount > 0, "amount.amount", "must be greater than 0")
    .check(body.amount?.currency === settings.currency, "amount.currency", `must be ${settings.currency}`)
    .check(typeof body.kioskId === "string" && state.kiosks.has(body.kioskId), "kioskId", "unknown kiosk")
    .check(
      typeof body.accountId === "string" && state.balances.has(body.accountId) && canAccessAccount(g.user, body.accountId),
      "accountId",
      "unknown account",
    );
  if (!v.valid) return invalid(request, v.details, `INVALID_${kind}`);
  const valid = body as CashRequest;

  if (scenarioFor(request) === "refused") {
    return kind === "DEPOSIT"
      ? refuse(request, "DAILY_LIMIT_EXCEEDED", "Daily deposit limit exceeded")
      : refuse(request, "INSUFFICIENT_FUNDS", "Available balance is insufficient");
  }

  const availability = serviceAvailabilityOn(state, valid.kioskId, kind);
  if (!availability || availability.availability === "UNAVAILABLE") {
    return refuse(request, "SERVICE_UNAVAILABLE_ON_KIOSK", `${kind} is not available on kiosk ${valid.kioskId}`);
  }

  const amount = valid.amount.amount;
  if (amount < settings.minAmount) return refuse(request, "AMOUNT_BELOW_MINIMUM", `Minimum is ${settings.minAmount}`);
  if (amount > settings.maxAmountPerTransaction) {
    return refuse(request, "AMOUNT_ABOVE_MAXIMUM", `Maximum per transaction is ${settings.maxAmountPerTransaction}`);
  }
  if (totalToday(valid.accountId, kind) + amount > settings.dailyLimitPerAccount) {
    return refuse(request, "DAILY_LIMIT_EXCEEDED", `Daily limit is ${settings.dailyLimitPerAccount}`);
  }

  const outcome = rules(valid, g.user);
  if (outcome instanceof Response) return outcome;

  const transaction: Transaction = {
    transactionId: nextId("TX"),
    correlationId: correlationIdOf(request),
    type: kind,
    status: "ACCEPTED",
    accountId: valid.accountId,
    kioskId: valid.kioskId,
    amount: valid.amount,
    ...(outcome.notes && { cashBreakdown: outcome.notes }),
    createdAt: now(),
  };
  const balance = state.balances.get(valid.accountId)!;
  const delta = kind === "DEPOSIT" ? amount : -amount;
  balance.available.amount += delta;
  balance.ledger.amount += delta;
  balance.asOf = transaction.createdAt;
  state.transactions.push(transaction);
  state.idempotency.set(scopedKey, transaction);
  return json<Transaction>(request, transaction, 201);
}

export const transactionHandlers = [
  http.post(api("/deposits"), ({ request }) =>
    cashOperation(request, "DEPOSIT", (body) => {
      const { acceptedDenominations, maxNotesPerTransaction } = state.depositSettings;
      if (!body.notes) return {};
      const v = new Validator().check(
        body.notes.reduce((sum, n) => sum + n.denomination * n.count, 0) === body.amount.amount,
        "notes",
        "must add up to amount",
      );
      if (!v.valid) return invalid(request, v.details, "INVALID_DEPOSIT");
      if (body.notes.some((n) => !acceptedDenominations.includes(n.denomination))) {
        return refuse(request, "DENOMINATION_NOT_ACCEPTED", `Accepted notes: ${acceptedDenominations.join(", ")}`);
      }
      if (countNotes(body.notes) > maxNotesPerTransaction) {
        return refuse(request, "TOO_MANY_NOTES", `At most ${maxNotesPerTransaction} notes`);
      }
      return { notes: body.notes };
    }),
  ),

  http.post(api("/withdrawals"), ({ request }) =>
    cashOperation(request, "WITHDRAWAL", (body) => {
      const { amountMultipleOf, dispensableDenominations, maxNotesPerTransaction } = state.withdrawalSettings;
      const amount = body.amount.amount;
      if (amount % amountMultipleOf !== 0) {
        return refuse(request, "AMOUNT_NOT_MULTIPLE", `Amount must be a multiple of ${amountMultipleOf}`);
      }
      const notes = breakdown(amount, dispensableDenominations);
      if (!notes) return refuse(request, "AMOUNT_NOT_DISPENSABLE", "Amount cannot be made with the loaded notes");
      if (countNotes(notes) > maxNotesPerTransaction) {
        return refuse(request, "TOO_MANY_NOTES", `At most ${maxNotesPerTransaction} notes`);
      }
      if (state.balances.get(body.accountId)!.available.amount < amount) {
        return refuse(request, "INSUFFICIENT_FUNDS", "Available balance is insufficient");
      }
      return { notes };
    }),
  ),
];
