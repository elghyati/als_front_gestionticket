import { http } from "msw";
import type { Schemas } from "../../api/client";
import type { MockUser } from "../fixtures";
import { state } from "../state";
import { api, error, guard, json, newestFirst, paginate } from "./http";

export const canAccessAccount = (user: MockUser, accountId: string) =>
  !user.roles.includes("CUSTOMER") || (user.accountIds ?? []).includes(accountId);

const accountNotFound = (request: Request, accountId: string) =>
  error(request, 404, "ACCOUNT_NOT_FOUND", `Account ${accountId} not found`);

export const accountHandlers = [
  http.get<{ accountId: string }>(api("/accounts/:accountId/balance"), async ({ request, params }) => {
    const g = await guard(request, "CBS");
    if (g.response) return g.response;

    const balance = state.balances.get(params.accountId);
    if (!balance || !canAccessAccount(g.user, params.accountId)) return accountNotFound(request, params.accountId);
    return json<Schemas["Balance"]>(request, balance);
  }),

  http.get<{ accountId: string }>(api("/accounts/:accountId/transactions"), async ({ request, params }) => {
    const g = await guard(request, "CBS");
    if (g.response) return g.response;

    if (!state.balances.has(params.accountId) || !canAccessAccount(g.user, params.accountId)) {
      return accountNotFound(request, params.accountId);
    }
    const all = state.transactions.filter((t) => t.accountId === params.accountId).sort(newestFirst);
    const p = paginate(request, all);
    if (p.response) return p.response;
    return json<Schemas["TransactionPage"]>(request, p.page);
  }),
];
