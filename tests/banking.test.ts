/** Banking side of the mock, exercised through the typed client the apps will use. */
import { describe, expect, it } from "vitest";
import { setScenario } from "../src/mocks/scenarios";
import { admin, clientFor, customer, headers, idempotentHeaders, supervisor } from "./helpers";

type CashBody = { accountId?: string; kioskId?: string; amount: number; notes?: { denomination: number; count: number }[] };

const deposit = ({ accountId = "ACC-001", kioskId = "KIOSK-01", amount, notes }: CashBody, header = idempotentHeaders()) =>
  clientFor(customer).POST("/deposits", {
    params: { header },
    body: { accountId, kioskId, amount: { amount, currency: "MAD" }, ...(notes && { notes }) },
  });

const withdraw = ({ accountId = "ACC-001", kioskId = "KIOSK-01", amount }: CashBody) =>
  clientFor(customer).POST("/withdrawals", {
    params: { header: idempotentHeaders() },
    body: { accountId, kioskId, amount: { amount, currency: "MAD" } },
  });

const balance = async (accountId = "ACC-001") =>
  (await clientFor(customer).GET("/accounts/{accountId}/balance", {
    params: { header: headers(), path: { accountId } },
  })).data!.available.amount;

describe("auth", () => {
  it("logs a kiosk customer in with card and PIN", async () => {
    const { data, response } = await clientFor().POST("/auth/login", {
      params: { header: headers() },
      body: { channel: "KIOSK", cardNumber: customer.cardNumber!, pin: customer.pin!, kioskId: "KIOSK-01" },
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
      body: { channel: "KIOSK", cardNumber: customer.cardNumber!, pin: "0000", kioskId: "KIOSK-01" },
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

describe("accounts", () => {
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

describe("deposit", () => {
  it("increases the balance and appears first in the history", async () => {
    const before = await balance();
    const { data, response } = await deposit({ amount: 200, notes: [{ denomination: 200, count: 1 }] });
    expect(response.status).toBe(201);
    expect(data).toMatchObject({ type: "DEPOSIT", status: "ACCEPTED", kioskId: "KIOSK-01" });
    expect(data?.cashBreakdown).toEqual([{ denomination: 200, count: 1 }]);
    expect(await balance()).toBe(before + 200);

    const history = await clientFor(customer).GET("/accounts/{accountId}/transactions", {
      params: { header: headers(), path: { accountId: "ACC-001" }, query: { limit: 1 } },
    });
    expect(history.data?.items[0]?.transactionId).toBe(data?.transactionId);
  });

  it("a retry with the same Idempotency-Key deposits once", async () => {
    const before = await balance();
    const header = idempotentHeaders();
    const first = await deposit({ amount: 100 }, header);
    const retry = await deposit({ amount: 100 }, header);
    expect(retry.data?.transactionId).toBe(first.data?.transactionId);
    expect(await balance()).toBe(before + 100);
  });

  it("rejects an invalid request with field details", async () => {
    const { error, response } = await deposit({ amount: -5, kioskId: "KIOSK-XX" });
    expect(response.status).toBe(400);
    expect(error?.details?.map((d) => d.field)).toEqual(["amount.amount", "kioskId"]);
  });

  it("rejects notes that do not add up to the amount", async () => {
    const { error, response } = await deposit({ amount: 300, notes: [{ denomination: 100, count: 2 }] });
    expect(response.status).toBe(400);
    expect(error?.details?.[0]?.field).toBe("notes");
  });

  it.each<[CashBody, string]>([
    [{ amount: 20 }, "AMOUNT_BELOW_MINIMUM"],
    [{ amount: 25000 }, "AMOUNT_ABOVE_MAXIMUM"],
    [{ amount: 150, notes: [{ denomination: 150, count: 1 }] }, "DENOMINATION_NOT_ACCEPTED"],
    [{ amount: 4200, notes: [{ denomination: 20, count: 210 }] }, "TOO_MANY_NOTES"],
    [{ amount: 200, kioskId: "KIOSK-02" }, "SERVICE_UNAVAILABLE_ON_KIOSK"],
  ])("refuses %j with %s", async (body, code) => {
    const { error, response } = await deposit(body);
    expect(response.status).toBe(422);
    expect(error?.code).toBe(code);
  });

  it("enforces the daily limit per account", async () => {
    await clientFor(admin).PUT("/kms/deposit-settings", {
      params: { header: headers() },
      body: {
        currency: "MAD",
        minAmount: 50,
        maxAmountPerTransaction: 1000,
        dailyLimitPerAccount: 1500,
        acceptedDenominations: [100, 200],
        maxNotesPerTransaction: 50,
        receiptMode: "NEVER",
      },
    });
    expect((await deposit({ amount: 1000 })).response.status).toBe(201);
    const { error } = await deposit({ amount: 600 });
    expect(error?.code).toBe("DAILY_LIMIT_EXCEEDED");
  });

  it("is refused once an administrator disables the service on the kiosk", async () => {
    await clientFor(admin).PUT("/kms/kiosks/{kioskId}/services/{serviceCode}", {
      params: { header: headers(), path: { kioskId: "KIOSK-01", serviceCode: "DEPOSIT" } },
      body: { enabled: false },
    });
    const { error } = await deposit({ amount: 200 });
    expect(error?.code).toBe("SERVICE_UNAVAILABLE_ON_KIOSK");
  });
});

describe("withdrawal", () => {
  it("decreases the balance and returns the notes to dispense", async () => {
    const before = await balance();
    const { data, response } = await withdraw({ amount: 700 });
    expect(response.status).toBe(201);
    expect(data?.type).toBe("WITHDRAWAL");
    expect(data?.cashBreakdown).toEqual([
      { denomination: 200, count: 3 },
      { denomination: 100, count: 1 },
    ]);
    expect(await balance()).toBe(before - 700);
  });

  it.each<[CashBody, string]>([
    [{ amount: 50 }, "AMOUNT_BELOW_MINIMUM"],
    [{ amount: 6000 }, "AMOUNT_ABOVE_MAXIMUM"],
    [{ amount: 250 }, "AMOUNT_NOT_MULTIPLE"],
    [{ amount: 200, accountId: "ACC-002" }, "INSUFFICIENT_FUNDS"],
    [{ amount: 200, kioskId: "KIOSK-03" }, "SERVICE_UNAVAILABLE_ON_KIOSK"],
  ])("refuses %j with %s", async (body, code) => {
    const { error, response } = await withdraw(body);
    expect(response.status).toBe(422);
    expect(error?.code).toBe(code);
  });

  it("is still possible on a kiosk where the WITHDRAWAL service is only DEGRADED", async () => {
    // KIOSK-02: receipt printer out of paper, RECOMMENDED for withdrawals.
    const { response } = await withdraw({ amount: 200, kioskId: "KIOSK-02" });
    expect(response.status).toBe(201);
  });

  it("becomes possible again on KIOSK-03 once its devices are back and the service is assigned", async () => {
    const sup = clientFor(supervisor);
    await clientFor(admin).PATCH("/kms/kiosks/{kioskId}", {
      params: { header: headers(), path: { kioskId: "KIOSK-03" } },
      body: { status: "ONLINE" },
    });
    await clientFor(admin).PUT("/kms/kiosks/{kioskId}/services/{serviceCode}", {
      params: { header: headers(), path: { kioskId: "KIOSK-03", serviceCode: "WITHDRAWAL" } },
      body: { enabled: true },
    });
    for (const deviceId of ["DEV-0301", "DEV-0302", "DEV-0303"]) {
      await sup.PUT("/kms/kiosks/{kioskId}/devices/{deviceId}/status", {
        params: { header: headers(), path: { kioskId: "KIOSK-03", deviceId } },
        body: { status: "OPERATIONAL" },
      });
    }
    // Still no cash dispenser installed on KIOSK-03.
    expect((await withdraw({ amount: 200, kioskId: "KIOSK-03" })).error?.code).toBe("SERVICE_UNAVAILABLE_ON_KIOSK");

    await clientFor(admin).POST("/kms/kiosks/{kioskId}/devices", {
      params: { header: headers(), path: { kioskId: "KIOSK-03" } },
      body: { deviceTypeCode: "CASH_DISPENSER", serialNumber: "SN-03-DISP" },
    });
    expect((await withdraw({ amount: 200, kioskId: "KIOSK-03" })).response.status).toBe(201);
  });
});

describe("scenario switches", () => {
  it("cbsDown → 503 CBS_UNAVAILABLE on banking calls, KMS still answers", async () => {
    setScenario("cbsDown");
    const { error, response } = await deposit({ amount: 100 });
    expect(response.status).toBe(503);
    expect(error).toMatchObject({ code: "CBS_UNAVAILABLE", retryable: true });

    const kms = await clientFor(customer).GET("/kms/kiosks/{kioskId}/services", {
      params: { header: headers(), path: { kioskId: "KIOSK-01" } },
    });
    expect(kms.response.status).toBe(200);
  });

  it("timeout → 504 UPSTREAM_TIMEOUT", async () => {
    setScenario("timeout");
    const { error, response } = await withdraw({ amount: 200 });
    expect(response.status).toBe(504);
    expect(error?.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("refused → 422 and the balance is unchanged", async () => {
    const before = await balance();
    setScenario("refused");
    expect((await deposit({ amount: 100 })).error?.code).toBe("DAILY_LIMIT_EXCEEDED");
    expect((await withdraw({ amount: 200 })).error?.code).toBe("INSUFFICIENT_FUNDS");
    setScenario("ok");
    expect(await balance()).toBe(before);
  });

  it("unauthorized → 401 even with a valid token", async () => {
    setScenario("unauthorized");
    expect((await deposit({ amount: 100 })).response.status).toBe(401);
  });

  it("the X-Mock-Scenario header overrides the global switch for one request", async () => {
    setScenario("cbsDown");
    const { response } = await clientFor(customer).GET("/accounts/{accountId}/balance", {
      params: { header: { ...headers(), "X-Mock-Scenario": "ok" } as ReturnType<typeof headers>, path: { accountId: "ACC-001" } },
    });
    expect(response.status).toBe(200);
  });
});
