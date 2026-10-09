import { http } from "msw";
import type { Schemas } from "../../api/client";
import { tokenFor, users } from "../fixtures";
import { scenarioFor } from "../scenarios";
import { api, error, json, precheck, readBody } from "./http";

export const authHandlers = [
  http.post(api("/auth/login"), async ({ request }) => {
    const rejected = await precheck(request, "CBS");
    if (rejected) return rejected;

    type AnyLogin = Partial<Omit<Schemas["KioskLogin"], "channel"> & Omit<Schemas["PortalLogin"], "channel">> & {
      channel?: string;
    };
    const body = await readBody<AnyLogin>(request);
    const user =
      body.channel === "KIOSK"
        ? users.find((u) => u.cardNumber === body.cardNumber && u.pin === body.pin)
        : body.channel === "PORTAL"
          ? users.find((u) => u.username === body.username && u.password === body.password)
          : undefined;

    if (!user || scenarioFor(request) === "refused") {
      return error(request, 401, "INVALID_CREDENTIALS", "Invalid credentials");
    }

    const { id, displayName, roles, accountIds } = user;
    return json<Schemas["Session"]>(request, {
      accessToken: tokenFor(user),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      user: { id, displayName, roles, ...(accountIds && { accountIds }) },
    });
  }),
];
