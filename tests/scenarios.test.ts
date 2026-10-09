/** Behaviour of the mock, exercised through the typed client the apps will use. */
import { describe, expect, it } from "vitest";
import { newCorrelationId } from "../src/api/client";
import { setScenario } from "../src/mocks/scenarios";
import { agent, clientFor, customer, headers } from "./helpers";

const deposit = (amount: number, idempotencyKey = crypto.randomUUID()) =>
  clientFor(customer).POST("/deposits", {
    params: { header: { "X-Correlation-Id": newCorrelationId(), "Idempotency-Key": idempotencyKey } },
    body: { accountId: "ACC-001", terminalId: "KIOSK-01", amount: { amount, currency: "MAD" } },
  });

const balance = async () =>
  (await clientFor(customer).GET("/accounts/{accountId}/balance", {
    params: { header: headers(), path: { accountId: "ACC-001" } },
  })).data!.available.amount;

describe("auth", () => {
  it("logs a kiosk customer in with card and PIN", async () => {
    const { data, response } = await clientFor().POST("/auth/login", {
      params: { header: headers() },
      body: { channel: "KIOSK", cardNumber: customer.cardNumber!, pin: customer.pin!, terminalId: "KIOSK-01" },
    });
    expect(response.status).toBe(200);
    expect(data?.user.roles).toEqual(["CUSTOMER"]);
  });

  it("logs a portal user in and returns their roles", async () => {
    const { data } = await clientFor().POST("/auth/login", {
      params: { header: headers() },
      body: { channel: "PORTAL", username: "superviseur", password: "superviseur" },
    });
    expect(data?.user.roles).toEqual(["SUPERVISOR"]);
  });

  it("rejects a wrong PIN", async () => {
    const { error, response } = await clientFor().POST("/auth/login", {
      params: { header: headers() },
      body: { channel: "KIOSK", cardNumber: customer.cardNumber!, pin: "0000", terminalId: "KIOSK-01" },
    });
    expect(response.status).toBe(401);
    expect(error?.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects calls without a token", async () => {
    const { response } = await clientFor().GET("/accounts/{accountId}/balance", {
      params: { header: headers(), path: { accountId: "ACC-001" } },
    });
    expect(response.status).toBe(401);
  });
});

describe("accounts and deposits", () => {
  it("a deposit increases the balance and appears first in the history", async () => {
    const before = await balance();
    const { data, response } = await deposit(200);
    expect(response.status).toBe(201);
    expect(data?.status).toBe("ACCEPTED");
    expect(await balance()).toBe(before + 200);

    const history = await clientFor(customer).GET("/accounts/{accountId}/transactions", {
      params: { header: headers(), path: { accountId: "ACC-001" }, query: { limit: 1 } },
    });
    expect(history.data?.items[0]?.transactionId).toBe(data?.transactionId);
  });

  it("a retried deposit with the same Idempotency-Key deposits once", async () => {
    const before = await balance();
    const key = crypto.randomUUID();
    const first = await deposit(100, key);
    const retry = await deposit(100, key);
    expect(retry.data?.transactionId).toBe(first.data?.transactionId);
    expect(await balance()).toBe(before + 100);
  });

  it("rejects an invalid deposit with field details", async () => {
    const { error, response } = await deposit(-5);
    expect(response.status).toBe(400);
    expect(error?.details?.map((d) => d.field)).toContain("amount.amount");
  });

  it("paginates the history with nextCursor", async () => {
    const page = (cursor?: string) =>
      clientFor(customer).GET("/accounts/{accountId}/transactions", {
        params: { header: headers(), path: { accountId: "ACC-001" }, query: { limit: 10, cursor } },
      });
    const first = (await page()).data!;
    const second = (await page(first.nextCursor)).data!;
    const third = (await page(second.nextCursor)).data!;
    expect(first.items).toHaveLength(10);
    expect(third.items).toHaveLength(5);
    expect(third.nextCursor).toBeUndefined();
  });

  it("does not show another customer's account", async () => {
    const { response } = await clientFor(customer).GET("/accounts/{accountId}/balance", {
      params: { header: headers(), path: { accountId: "ACC-999" } },
    });
    expect(response.status).toBe(404);
  });
});

describe("terminals and roles", () => {
  it("lists terminals for an agent and filters by status", async () => {
    const { data } = await clientFor(agent).GET("/terminals", {
      params: { header: headers(), query: { status: "DEGRADED" } },
    });
    expect(data?.items.map((t) => t.terminalId)).toEqual(["KIOSK-02"]);
  });

  it("returns per-service availability in the terminal detail", async () => {
    const { data } = await clientFor(agent).GET("/terminals/{terminalId}", {
      params: { header: headers(), path: { terminalId: "KIOSK-02" } },
    });
    expect(data?.services.find((s) => s.service === "DEPOSIT")?.available).toBe(false);
  });

  it("forbids terminals to a customer", async () => {
    const { response } = await clientFor(customer).GET("/terminals", { params: { header: headers() } });
    expect(response.status).toBe(403);
  });
});

describe("scenario switches", () => {
  it("cbsDown → 503 CBS_UNAVAILABLE, retryable", async () => {
    setScenario("cbsDown");
    const { error, response } = await deposit(10);
    expect(response.status).toBe(503);
    expect(error).toMatchObject({ code: "CBS_UNAVAILABLE", retryable: true });
  });

  it("timeout → 504 UPSTREAM_TIMEOUT", async () => {
    setScenario("timeout");
    const { error, response } = await deposit(10);
    expect(response.status).toBe(504);
    expect(error?.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("refused → 422 on deposit and the balance is unchanged", async () => {
    const before = await balance();
    setScenario("refused");
    const { error, response } = await deposit(10);
    expect(response.status).toBe(422);
    expect(error?.code).toBe("DEPOSIT_LIMIT_EXCEEDED");
    setScenario("ok");
    expect(await balance()).toBe(before);
  });

  it("unauthorized → 401 even with a valid token", async () => {
    setScenario("unauthorized");
    const { response } = await deposit(10);
    expect(response.status).toBe(401);
  });

  it("the X-Mock-Scenario header overrides the global switch for one request", async () => {
    setScenario("cbsDown");
    const { response } = await clientFor(customer).GET("/accounts/{accountId}/balance", {
      params: { header: { ...headers(), "X-Mock-Scenario": "ok" } as ReturnType<typeof headers>, path: { accountId: "ACC-001" } },
    });
    expect(response.status).toBe(200);
  });
});
