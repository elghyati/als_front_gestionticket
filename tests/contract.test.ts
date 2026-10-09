/**
 * Contract tests: every operation of openapi/openapi.yaml is mocked, and every
 * mock response, in every scenario, has a status documented for that operation
 * and a body that validates against the documented schema.
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { depositSettings, tokenFor, withdrawalSettings, type MockUser } from "../src/mocks/fixtures";
import { SCENARIO_HEADER, SCENARIOS } from "../src/mocks/scenarios";
import { resetMockState } from "../src/mocks/state";
import { admin, agent, BASE_URL, customer, supervisor } from "./helpers";

const SPEC_PATH = fileURLToPath(new URL("../openapi/openapi.yaml", import.meta.url));

type JsonContent = { "application/json"?: { schema: object } };
interface Operation {
  operationId: string;
  requestBody?: { content: JsonContent };
  responses: Record<string, { content?: JsonContent }>;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
}

interface Sample {
  path: string;
  method?: string;
  user?: MockUser;
  body?: unknown;
  headers?: Record<string, string>;
}

const idempotency = () => ({ "Idempotency-Key": crypto.randomUUID() });

/**
 * One representative valid request per operation, keyed by operationId. The
 * mock state is reset before each call, so destructive samples do not affect
 * the others.
 */
const samples: Record<string, () => Sample> = {
  login: () => ({
    path: "/auth/login",
    method: "POST",
    body: { channel: "KIOSK", cardNumber: customer.cardNumber, pin: customer.pin, kioskId: "KIOSK-01" },
  }),
  getBalance: () => ({ path: "/accounts/ACC-001/balance", user: customer }),
  listTransactions: () => ({ path: "/accounts/ACC-001/transactions?limit=5", user: customer }),
  createDeposit: () => ({
    path: "/deposits",
    method: "POST",
    user: customer,
    headers: idempotency(),
    body: { accountId: "ACC-001", kioskId: "KIOSK-01", amount: { amount: 200, currency: "MAD" }, notes: [{ denomination: 100, count: 2 }] },
  }),
  createWithdrawal: () => ({
    path: "/withdrawals",
    method: "POST",
    user: customer,
    headers: idempotency(),
    body: { accountId: "ACC-001", kioskId: "KIOSK-01", amount: { amount: 500, currency: "MAD" } },
  }),

  listKiosks: () => ({ path: "/kms/kiosks?health=DEGRADED", user: agent }),
  createKiosk: () => ({
    path: "/kms/kiosks",
    method: "POST",
    user: admin,
    body: { kioskId: "KIOSK-99", name: "Kiosque Test", location: { branchName: "Agence Test", city: "Fès" } },
  }),
  getKiosk: () => ({ path: "/kms/kiosks/KIOSK-02", user: agent }),
  updateKiosk: () => ({ path: "/kms/kiosks/KIOSK-03", method: "PATCH", user: admin, body: { status: "MAINTENANCE" } }),
  deleteKiosk: () => ({ path: "/kms/kiosks/KIOSK-03", method: "DELETE", user: admin }),
  listKioskServices: () => ({ path: "/kms/kiosks/KIOSK-02/services", user: customer }),
  assignKioskService: () => ({
    path: "/kms/kiosks/KIOSK-03/services/WITHDRAWAL",
    method: "PUT",
    user: admin,
    body: { enabled: true },
  }),
  unassignKioskService: () => ({ path: "/kms/kiosks/KIOSK-01/services/HISTORY", method: "DELETE", user: admin }),

  listKioskDevices: () => ({ path: "/kms/kiosks/KIOSK-02/devices", user: agent }),
  addKioskDevice: () => ({
    path: "/kms/kiosks/KIOSK-03/devices",
    method: "POST",
    user: admin,
    body: { deviceTypeCode: "RECEIPT_PRINTER", serialNumber: "SN-NEW-1", model: "TP-80" },
  }),
  getKioskDevice: () => ({ path: "/kms/kiosks/KIOSK-02/devices/DEV-0204", user: agent }),
  updateKioskDevice: () => ({
    path: "/kms/kiosks/KIOSK-02/devices/DEV-0204",
    method: "PATCH",
    user: admin,
    body: { firmwareVersion: "1.0.1" },
  }),
  removeKioskDevice: () => ({ path: "/kms/kiosks/KIOSK-02/devices/DEV-0206", method: "DELETE", user: admin }),
  changeDeviceStatus: () => ({
    path: "/kms/kiosks/KIOSK-02/devices/DEV-0204/status",
    method: "PUT",
    user: supervisor,
    body: { status: "OPERATIONAL", reason: "Bourrage résolu" },
  }),
  listDeviceStatusHistory: () => ({ path: "/kms/kiosks/KIOSK-02/devices/DEV-0204/status-history", user: agent }),
  listKioskStatusHistory: () => ({ path: "/kms/kiosks/KIOSK-02/status-history?status=ERROR&limit=10", user: agent }),

  listDeviceTypes: () => ({ path: "/kms/device-types?category=CASH", user: agent }),
  createDeviceType: () => ({
    path: "/kms/device-types",
    method: "POST",
    user: admin,
    body: { deviceTypeCode: "NFC_READER", name: "Lecteur NFC", category: "CARD" },
  }),
  getDeviceType: () => ({ path: "/kms/device-types/CASH_ACCEPTOR", user: agent }),
  updateDeviceType: () => ({
    path: "/kms/device-types/CAMERA",
    method: "PATCH",
    user: admin,
    body: { description: "Caméra frontale" },
  }),
  deleteDeviceType: () => ({ path: "/kms/device-types/BARCODE_SCANNER", method: "DELETE", user: admin }),

  listServices: () => ({ path: "/kms/services", user: agent }),
  createService: () => ({
    path: "/kms/services",
    method: "POST",
    user: admin,
    body: { serviceCode: "BILL_PAYMENT", name: "Paiement de factures" },
  }),
  getService: () => ({ path: "/kms/services/WITHDRAWAL", user: agent }),
  updateService: () => ({ path: "/kms/services/STATEMENT", method: "PATCH", user: admin, body: { enabled: false } }),
  deleteService: () => ({ path: "/kms/services/STATEMENT", method: "DELETE", user: admin }),
  listServiceDeviceRequirements: () => ({ path: "/kms/services/DEPOSIT/device-requirements", user: agent }),
  setServiceDeviceRequirement: () => ({
    path: "/kms/services/DEPOSIT/device-requirements/CAMERA",
    method: "PUT",
    user: admin,
    body: { requirement: "OPTIONAL" },
  }),
  removeServiceDeviceRequirement: () => ({
    path: "/kms/services/DEPOSIT/device-requirements/RECEIPT_PRINTER",
    method: "DELETE",
    user: admin,
  }),

  getDepositSettings: () => ({ path: "/kms/deposit-settings", user: customer }),
  updateDepositSettings: () => ({
    path: "/kms/deposit-settings",
    method: "PUT",
    user: admin,
    body: { ...depositSettings, maxAmountPerTransaction: 15000 },
  }),
  getWithdrawalSettings: () => ({ path: "/kms/withdrawal-settings", user: customer }),
  updateWithdrawalSettings: () => ({
    path: "/kms/withdrawal-settings",
    method: "PUT",
    user: admin,
    body: { ...withdrawalSettings, presetAmounts: [200, 400, 1000] },
  }),
};

let operations: Operation[] = [];
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("password", true);

beforeAll(async () => {
  const spec = (await SwaggerParser.dereference(SPEC_PATH)) as unknown as Spec;
  operations = Object.values(spec.paths).flatMap((pathItem) => Object.values(pathItem));
});

async function call(operationId: string, scenario: string, { withCorrelationId = true } = {}) {
  resetMockState();
  const sample = samples[operationId]!();
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${BASE_URL}${sample.path}`, {
    method: sample.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      [SCENARIO_HEADER]: scenario,
      ...(withCorrelationId && { "X-Correlation-Id": correlationId }),
      ...(sample.user && { Authorization: `Bearer ${tokenFor(sample.user)}` }),
      ...sample.headers,
    },
    ...(sample.body !== undefined && { body: JSON.stringify(sample.body) }),
  });
  const text = await response.text();
  return { response, correlationId, body: text ? JSON.parse(text) : undefined };
}

function expectValid(schema: object, value: unknown, label: string) {
  const validate = ajv.compile(schema);
  expect(validate(value), `${label}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

function expectConforms(operation: Operation, status: number, body: unknown) {
  const label = `${operation.operationId} ${status}`;
  const documented = operation.responses[String(status)];
  expect(documented, `${operation.operationId} returned undocumented status ${status}`).toBeDefined();
  const schema = documented!.content?.["application/json"]?.schema;
  if (!schema) {
    expect(body, `${label} documents no body`).toBeUndefined();
    return;
  }
  expectValid(schema, body, label);
}

describe("OpenAPI contract", () => {
  it("has a sample for every operation, and no sample for an unknown operation", () => {
    const ids = operations.map((o) => o.operationId).sort();
    expect(Object.keys(samples).sort()).toEqual(ids);
  });

  it("every sample request body conforms to the contract", () => {
    for (const operation of operations) {
      const schema = operation.requestBody?.content["application/json"]?.schema;
      if (schema) expectValid(schema, samples[operation.operationId]!().body, `${operation.operationId} request`);
    }
  });

  for (const scenario of SCENARIOS) {
    it(`every mock response conforms to the contract in scenario "${scenario}"`, async () => {
      for (const operation of operations) {
        const { response, correlationId, body } = await call(operation.operationId, scenario);
        expectConforms(operation, response.status, body);
        expect(response.headers.get("X-Correlation-Id"), operation.operationId).toBe(correlationId);
      }
    });
  }

  it("every operation succeeds in scenario ok and fails in at least one other scenario", async () => {
    for (const operation of operations) {
      const statuses = new Map<string, number>();
      for (const scenario of SCENARIOS) statuses.set(scenario, (await call(operation.operationId, scenario)).response.status);
      expect(statuses.get("ok"), `${operation.operationId} in scenario ok`).toBeLessThan(300);
      expect([...statuses.values()].some((s) => s >= 400), `${operation.operationId} never fails`).toBe(true);
    }
  });

  it("rejects a request without X-Correlation-Id with a documented 400", async () => {
    for (const operation of operations) {
      const { response, body } = await call(operation.operationId, "ok", { withCorrelationId: false });
      expect(response.status, operation.operationId).toBe(400);
      expectConforms(operation, 400, body);
    }
  });
});
