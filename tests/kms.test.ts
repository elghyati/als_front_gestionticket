/** KMS side of the mock: kiosks, devices, status history, configuration. */
import { describe, expect, it } from "vitest";
import { setScenario } from "../src/mocks/scenarios";
import { admin, agent, clientFor, customer, headers, supervisor } from "./helpers";

const asAdmin = clientFor(admin);
const asAgent = clientFor(agent);
const asSupervisor = clientFor(supervisor);

const kioskServices = async (kioskId: string) =>
  (await clientFor(customer).GET("/kms/kiosks/{kioskId}/services", {
    params: { header: headers(), path: { kioskId } },
  })).data!.items;

const serviceOn = async (kioskId: string, serviceCode: string) =>
  (await kioskServices(kioskId)).find((s) => s.serviceCode === serviceCode);

const getKiosk = async (kioskId: string) =>
  (await asAgent.GET("/kms/kiosks/{kioskId}", { params: { header: headers(), path: { kioskId } } })).data;

const changeStatus = (deviceId: string, body: { status: "OPERATIONAL" | "WARNING" | "ERROR" | "OFFLINE"; reasonCode?: string; reason?: string }, kioskId = "KIOSK-02") =>
  asSupervisor.PUT("/kms/kiosks/{kioskId}/devices/{deviceId}/status", {
    params: { header: headers(), path: { kioskId, deviceId } },
    body,
  });

const deviceHistory = async (deviceId: string, kioskId = "KIOSK-02") =>
  (await asAgent.GET("/kms/kiosks/{kioskId}/devices/{deviceId}/status-history", {
    params: { header: headers(), path: { kioskId, deviceId } },
  })).data!.items;

describe("kiosks", () => {
  it("computes the health of each kiosk from its status, services and devices", async () => {
    const { data } = await asAgent.GET("/kms/kiosks", { params: { header: headers() } });
    expect(Object.fromEntries(data!.items.map((k) => [k.kioskId, k.health]))).toEqual({
      "KIOSK-01": "HEALTHY",
      "KIOSK-02": "DEGRADED",
      "KIOSK-03": "OUT_OF_SERVICE",
    });
    expect(data!.items.find((k) => k.kioskId === "KIOSK-01")?.deviceCount).toBe(8);
  });

  it("filters by status, health, city and free text", async () => {
    const list = async (query: Record<string, string>) =>
      (await asAgent.GET("/kms/kiosks", { params: { header: headers(), query } })).data!.items.map((k) => k.kioskId);
    expect(await list({ status: "ONLINE" })).toEqual(["KIOSK-01", "KIOSK-02"]);
    expect(await list({ health: "OUT_OF_SERVICE" })).toEqual(["KIOSK-03"]);
    expect(await list({ city: "rabat" })).toEqual(["KIOSK-02"]);
    expect(await list({ q: "guéliz" })).toEqual(["KIOSK-03"]);
  });

  it("creates a kiosk in MAINTENANCE by default, then updates it", async () => {
    const created = await asAdmin.POST("/kms/kiosks", {
      params: { header: headers() },
      body: { kioskId: "KIOSK-10", name: "Kiosque Fès", location: { branchName: "Agence Fès", city: "Fès" } },
    });
    expect(created.response.status).toBe(201);
    expect(created.data).toMatchObject({ status: "MAINTENANCE", health: "OUT_OF_SERVICE", deviceCount: 0 });

    const updated = await asAdmin.PATCH("/kms/kiosks/{kioskId}", {
      params: { header: headers(), path: { kioskId: "KIOSK-10" } },
      body: { status: "ONLINE", softwareVersion: "0.2.0" },
    });
    expect(updated.data).toMatchObject({ status: "ONLINE", softwareVersion: "0.2.0", health: "HEALTHY" });
  });

  it("rejects a duplicate id with 409 and invalid fields with 400", async () => {
    const duplicate = await asAdmin.POST("/kms/kiosks", {
      params: { header: headers() },
      body: { kioskId: "KIOSK-01", name: "Doublon", location: { branchName: "X", city: "Y" } },
    });
    expect(duplicate.response.status).toBe(409);

    const invalid = await asAdmin.POST("/kms/kiosks", {
      params: { header: headers() },
      body: { kioskId: "kiosk 1", name: "", location: { branchName: "X", city: "Y" }, ipAddress: "999.1.1.1" },
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.error?.details?.map((d) => d.field)).toEqual(["kioskId", "name", "ipAddress"]);
  });

  it("refuses to delete an ONLINE kiosk", async () => {
    const { error, response } = await asAdmin.DELETE("/kms/kiosks/{kioskId}", {
      params: { header: headers(), path: { kioskId: "KIOSK-01" } },
    });
    expect(response.status).toBe(409);
    expect(error?.code).toBe("KIOSK_ONLINE");
  });

  it("deleting a kiosk removes its devices and services but keeps the status history", async () => {
    const { response } = await asAdmin.DELETE("/kms/kiosks/{kioskId}", {
      params: { header: headers(), path: { kioskId: "KIOSK-03" } },
    });
    expect(response.status).toBe(204);
    expect((await asAgent.GET("/kms/kiosks/{kioskId}", { params: { header: headers(), path: { kioskId: "KIOSK-03" } } })).response.status).toBe(404);

    const history = await asAgent.GET("/kms/kiosks/{kioskId}/status-history", {
      params: { header: headers(), path: { kioskId: "KIOSK-03" } },
    });
    expect(history.data?.items.length).toBeGreaterThan(0);
  });

  it("reserves writes to ADMIN and reads to KMS roles", async () => {
    const write = await asSupervisor.PATCH("/kms/kiosks/{kioskId}", {
      params: { header: headers(), path: { kioskId: "KIOSK-01" } },
      body: { name: "Renommé" },
    });
    expect(write.response.status).toBe(403);
    const read = await clientFor(customer).GET("/kms/kiosks", { params: { header: headers() } });
    expect(read.response.status).toBe(403);
  });
});

describe("service availability on a kiosk", () => {
  it("applies MANDATORY / RECOMMENDED / OPTIONAL to the devices of KIOSK-02", async () => {
    const services = await kioskServices("KIOSK-02");
    const byCode = Object.fromEntries(services.map((s) => [s.serviceCode, s]));

    // Cash acceptor in ERROR, MANDATORY for deposits.
    expect(byCode.DEPOSIT?.availability).toBe("UNAVAILABLE");
    expect(byCode.DEPOSIT?.issues[0]).toMatchObject({
      reasonCode: "DEVICE_NOT_USABLE",
      deviceTypeCode: "CASH_ACCEPTOR",
      requirement: "MANDATORY",
    });
    // Receipt printer out of paper: RECOMMENDED for withdrawals, OPTIONAL for the balance.
    expect(byCode.WITHDRAWAL?.availability).toBe("DEGRADED");
    expect(byCode.BALANCE?.availability).toBe("AVAILABLE");
    expect(byCode.BALANCE?.issues).toEqual([expect.objectContaining({ deviceTypeCode: "RECEIPT_PRINTER", requirement: "OPTIONAL" })]);
  });

  it("an offline kiosk has every service UNAVAILABLE", async () => {
    for (const service of await kioskServices("KIOSK-03")) {
      expect(service.availability).toBe("UNAVAILABLE");
      expect(service.issues.map((i) => i.reasonCode)).toContain("KIOSK_NOT_ONLINE");
    }
  });

  it("follows the requirement level set by an administrator", async () => {
    await asAdmin.PUT("/kms/services/{serviceCode}/device-requirements/{deviceTypeCode}", {
      params: { header: headers(), path: { serviceCode: "DEPOSIT", deviceTypeCode: "CASH_ACCEPTOR" } },
      body: { requirement: "RECOMMENDED" },
    });
    expect((await serviceOn("KIOSK-02", "DEPOSIT"))?.availability).toBe("DEGRADED");

    await asAdmin.DELETE("/kms/services/{serviceCode}/device-requirements/{deviceTypeCode}", {
      params: { header: headers(), path: { serviceCode: "DEPOSIT", deviceTypeCode: "CASH_ACCEPTOR" } },
    });
    expect((await serviceOn("KIOSK-02", "DEPOSIT"))?.availability).toBe("AVAILABLE");
  });

  it("is UNAVAILABLE when disabled globally or on the kiosk", async () => {
    await asAdmin.PATCH("/kms/services/{serviceCode}", {
      params: { header: headers(), path: { serviceCode: "BALANCE" } },
      body: { enabled: false },
    });
    expect((await serviceOn("KIOSK-01", "BALANCE"))?.issues[0]?.reasonCode).toBe("SERVICE_DISABLED");

    const assigned = await asAdmin.PUT("/kms/kiosks/{kioskId}/services/{serviceCode}", {
      params: { header: headers(), path: { kioskId: "KIOSK-01", serviceCode: "HISTORY" } },
      body: { enabled: false },
    });
    expect(assigned.data).toMatchObject({ availability: "UNAVAILABLE", enabled: false });
    expect(assigned.data?.issues[0]?.reasonCode).toBe("SERVICE_DISABLED_ON_KIOSK");
  });

  it("assigns and unassigns a service", async () => {
    const assign = await asAdmin.PUT("/kms/kiosks/{kioskId}/services/{serviceCode}", {
      params: { header: headers(), path: { kioskId: "KIOSK-01", serviceCode: "STATEMENT" } },
      body: { enabled: true },
    });
    expect(assign.data?.availability).toBe("AVAILABLE");
    expect((await kioskServices("KIOSK-01")).map((s) => s.serviceCode)).toContain("STATEMENT");

    await asAdmin.DELETE("/kms/kiosks/{kioskId}/services/{serviceCode}", {
      params: { header: headers(), path: { kioskId: "KIOSK-01", serviceCode: "STATEMENT" } },
    });
    expect((await kioskServices("KIOSK-01")).map((s) => s.serviceCode)).not.toContain("STATEMENT");
  });
});

describe("devices and status history", () => {
  it("a status change is recorded in the history and updates service availability", async () => {
    const { data } = await changeStatus("DEV-0204", { status: "OPERATIONAL", reason: "Bourrage résolu" });
    expect(data).toMatchObject({ status: "OPERATIONAL", statusReason: "Bourrage résolu" });
    expect(data?.statusReasonCode).toBeUndefined();

    const [latest] = await deviceHistory("DEV-0204");
    expect(latest).toMatchObject({
      previousStatus: "ERROR",
      newStatus: "OPERATIONAL",
      source: "OPERATOR",
      changedBy: supervisor.id,
      deviceTypeCode: "CASH_ACCEPTOR",
    });
    expect((await serviceOn("KIOSK-02", "DEPOSIT"))?.availability).toBe("AVAILABLE");
  });

  it("sending the same status and reason again records nothing", async () => {
    const before = (await deviceHistory("DEV-0204")).length;
    await changeStatus("DEV-0204", { status: "ERROR", reasonCode: "JAM" });
    expect(await deviceHistory("DEV-0204")).toHaveLength(before);
  });

  it("only SUPERVISOR and ADMIN can change a status", async () => {
    const { response } = await asAgent.PUT("/kms/kiosks/{kioskId}/devices/{deviceId}/status", {
      params: { header: headers(), path: { kioskId: "KIOSK-02", deviceId: "DEV-0204" } },
      body: { status: "OPERATIONAL" },
    });
    expect(response.status).toBe(403);
  });

  it("the kiosk history filters by status, device type and dates, newest first", async () => {
    const history = (query: Record<string, string | number>) =>
      asAgent.GET("/kms/kiosks/{kioskId}/status-history", {
        params: { header: headers(), path: { kioskId: "KIOSK-02" }, query },
      });
    const errors = (await history({ status: "ERROR" })).data!.items;
    expect(errors.map((c) => c.deviceTypeCode)).toEqual(["RECEIPT_PRINTER", "CASH_ACCEPTOR"]);

    const printer = (await history({ deviceTypeCode: "RECEIPT_PRINTER" })).data!.items;
    expect(printer.map((c) => c.newStatus)).toEqual(["ERROR", "WARNING", "OPERATIONAL"]);

    const window = (await history({ from: "2026-10-05T00:00:00Z", to: "2026-10-06T00:00:00Z" })).data!.items;
    expect(window.map((c) => c.reasonCode)).toEqual(["OUT_OF_PAPER", "JAM"]);

    const page = (await history({ limit: 2 })).data!;
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe("2");

    expect((await history({ from: "pas une date" })).response.status).toBe(400);
  });

  it("installs a device with its initial status in the history", async () => {
    const { data, response } = await asAdmin.POST("/kms/kiosks/{kioskId}/devices", {
      params: { header: headers(), path: { kioskId: "KIOSK-01" } },
      body: { deviceTypeCode: "CAMERA", serialNumber: "SN-CAM-1", status: "WARNING" },
    });
    expect(response.status).toBe(201);
    expect(await deviceHistory(data!.deviceId, "KIOSK-01")).toEqual([
      expect.objectContaining({ newStatus: "WARNING", changedBy: admin.id }),
    ]);
    expect((await getKiosk("KIOSK-01"))?.health).toBe("HEALTHY");
  });

  it("rejects an unknown device type, a duplicate serial number and a status in PATCH", async () => {
    const unknownType = await asAdmin.POST("/kms/kiosks/{kioskId}/devices", {
      params: { header: headers(), path: { kioskId: "KIOSK-01" } },
      body: { deviceTypeCode: "TELEPORTER", serialNumber: "SN-1" },
    });
    expect(unknownType.response.status).toBe(400);

    const duplicate = await asAdmin.POST("/kms/kiosks/{kioskId}/devices", {
      params: { header: headers(), path: { kioskId: "KIOSK-03" } },
      body: { deviceTypeCode: "CARD_READER", serialNumber: "SN-01-CARD_READER" },
    });
    expect(duplicate.error?.code).toBe("DEVICE_SERIAL_EXISTS");

    const patchStatus = await asAdmin.PATCH("/kms/kiosks/{kioskId}/devices/{deviceId}", {
      params: { header: headers(), path: { kioskId: "KIOSK-02", deviceId: "DEV-0204" } },
      body: { status: "OPERATIONAL" } as never,
    });
    expect(patchStatus.error?.details).toEqual([{ field: "status", issue: "unknown field" }]);
  });

  it("a removed device keeps its history and degrades the kiosk", async () => {
    await asAdmin.DELETE("/kms/kiosks/{kioskId}/devices/{deviceId}", {
      params: { header: headers(), path: { kioskId: "KIOSK-01", deviceId: "DEV-0105" } },
    });
    expect((await deviceHistory("DEV-0105", "KIOSK-01")).length).toBeGreaterThan(0);

    const withdrawal = await serviceOn("KIOSK-01", "WITHDRAWAL");
    expect(withdrawal?.issues[0]).toMatchObject({ reasonCode: "DEVICE_MISSING", deviceTypeCode: "CASH_DISPENSER" });
    expect((await getKiosk("KIOSK-01"))?.health).toBe("DEGRADED");
  });
});

describe("configuration", () => {
  it("manages the device catalogue and protects types in use", async () => {
    const created = await asAdmin.POST("/kms/device-types", {
      params: { header: headers() },
      body: { deviceTypeCode: "NFC_READER", name: "Lecteur NFC", category: "CARD" },
    });
    expect(created.response.status).toBe(201);

    const cards = await asAgent.GET("/kms/device-types", { params: { header: headers(), query: { category: "CARD" } } });
    expect(cards.data?.items.map((t) => t.deviceTypeCode)).toEqual(["CARD_READER", "NFC_READER"]);

    const installed = await asAdmin.DELETE("/kms/device-types/{deviceTypeCode}", {
      params: { header: headers(), path: { deviceTypeCode: "CARD_READER" } },
    });
    expect(installed.error?.code).toBe("DEVICE_TYPE_IN_USE");

    const unused = await asAdmin.DELETE("/kms/device-types/{deviceTypeCode}", {
      params: { header: headers(), path: { deviceTypeCode: "NFC_READER" } },
    });
    expect(unused.response.status).toBe(204);
  });

  it("creates a service, links device types and protects built-in or assigned services", async () => {
    await asAdmin.POST("/kms/services", {
      params: { header: headers() },
      body: { serviceCode: "BILL_PAYMENT", name: "Paiement de factures" },
    });
    await asAdmin.PUT("/kms/services/{serviceCode}/device-requirements/{deviceTypeCode}", {
      params: { header: headers(), path: { serviceCode: "BILL_PAYMENT", deviceTypeCode: "BARCODE_SCANNER" } },
      body: { requirement: "MANDATORY" },
    });
    const service = await asAgent.GET("/kms/services/{serviceCode}", {
      params: { header: headers(), path: { serviceCode: "BILL_PAYMENT" } },
    });
    expect(service.data).toMatchObject({
      builtIn: false,
      enabled: true,
      deviceRequirements: [{ deviceTypeCode: "BARCODE_SCANNER", requirement: "MANDATORY" }],
    });

    const assigned = await asAdmin.PUT("/kms/kiosks/{kioskId}/services/{serviceCode}", {
      params: { header: headers(), path: { kioskId: "KIOSK-01", serviceCode: "BILL_PAYMENT" } },
      body: { enabled: true },
    });
    expect(assigned.data?.issues[0]).toMatchObject({ reasonCode: "DEVICE_MISSING", deviceTypeCode: "BARCODE_SCANNER" });

    const deleteAssigned = await asAdmin.DELETE("/kms/services/{serviceCode}", {
      params: { header: headers(), path: { serviceCode: "BILL_PAYMENT" } },
    });
    expect(deleteAssigned.error?.code).toBe("SERVICE_ASSIGNED");

    const deleteBuiltIn = await asAdmin.DELETE("/kms/services/{serviceCode}", {
      params: { header: headers(), path: { serviceCode: "DEPOSIT" } },
    });
    expect(deleteBuiltIn.error?.code).toBe("SERVICE_BUILT_IN");
  });

  it("rejects a requirement on an unknown device type, or with an unknown level", async () => {
    const unknownType = await asAdmin.PUT("/kms/services/{serviceCode}/device-requirements/{deviceTypeCode}", {
      params: { header: headers(), path: { serviceCode: "DEPOSIT", deviceTypeCode: "TELEPORTER" } },
      body: { requirement: "OPTIONAL" },
    });
    expect(unknownType.response.status).toBe(404);

    const unknownLevel = await asAdmin.PUT("/kms/services/{serviceCode}/device-requirements/{deviceTypeCode}", {
      params: { header: headers(), path: { serviceCode: "DEPOSIT", deviceTypeCode: "CAMERA" } },
      body: { requirement: "NICE_TO_HAVE" } as never,
    });
    expect(unknownLevel.response.status).toBe(400);
  });

  it("lets every user read the deposit and withdrawal settings, only ADMIN change them", async () => {
    const read = await clientFor(customer).GET("/kms/withdrawal-settings", { params: { header: headers() } });
    expect(read.data?.presetAmounts).toEqual([200, 500, 1000, 2000]);

    const write = await asSupervisor.PUT("/kms/withdrawal-settings", { params: { header: headers() }, body: read.data! });
    expect(write.response.status).toBe(403);
  });

  it("validates the consistency of the settings", async () => {
    const deposit = await asAdmin.PUT("/kms/deposit-settings", {
      params: { header: headers() },
      body: {
        currency: "MAD",
        minAmount: 500,
        maxAmountPerTransaction: 100,
        dailyLimitPerAccount: 1000,
        acceptedDenominations: [100],
        maxNotesPerTransaction: 10,
        receiptMode: "ALWAYS",
      },
    });
    expect(deposit.error?.details).toEqual([{ field: "minAmount", issue: "must be <= maxAmountPerTransaction" }]);

    const withdrawal = await asAdmin.PUT("/kms/withdrawal-settings", {
      params: { header: headers() },
      body: {
        currency: "MAD",
        minAmount: 100,
        maxAmountPerTransaction: 2000,
        dailyLimitPerAccount: 5000,
        amountMultipleOf: 100,
        dispensableDenominations: [50, 100, 200],
        maxNotesPerTransaction: 40,
        presetAmounts: [150, 3000],
        receiptMode: "ON_REQUEST",
      },
    });
    expect(withdrawal.error?.details?.map((d) => d.field)).toEqual(["dispensableDenominations", "presetAmounts"]);
  });
});

describe("kmsDown scenario", () => {
  it("returns 503 KMS_UNAVAILABLE on /kms calls while banking calls still answer", async () => {
    setScenario("kmsDown");
    const kms = await asAgent.GET("/kms/kiosks", { params: { header: headers() } });
    expect(kms.response.status).toBe(503);
    expect(kms.error).toMatchObject({ code: "KMS_UNAVAILABLE", retryable: true });

    const balance = await clientFor(customer).GET("/accounts/{accountId}/balance", {
      params: { header: headers(), path: { accountId: "ACC-001" } },
    });
    expect(balance.response.status).toBe(200);
  });
});
