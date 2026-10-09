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
import { tokenFor } from "../src/mocks/fixtures";
import { SCENARIO_HEADER, SCENARIOS } from "../src/mocks/scenarios";
import { agent, BASE_URL, customer } from "./helpers";

const SPEC_PATH = fileURLToPath(new URL("../openapi/openapi.yaml", import.meta.url));

interface Operation {
  operationId: string;
  responses: Record<string, { content?: { "application/json"?: { schema: object } } }>;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
}

/** One representative valid request per operation, keyed by operationId. */
const sampleRequests: Record<string, () => { path: string; init: RequestInit }> = {
  login: () => ({
    path: "/auth/login",
    init: {
      method: "POST",
      body: JSON.stringify({ channel: "KIOSK", cardNumber: customer.cardNumber, pin: customer.pin, terminalId: "KIOSK-01" }),
    },
  }),
  getBalance: () => ({ path: "/accounts/ACC-001/balance", init: { headers: auth(customer) } }),
  listTransactions: () => ({ path: "/accounts/ACC-001/transactions?limit=5", init: { headers: auth(customer) } }),
  createDeposit: () => ({
    path: "/deposits",
    init: {
      method: "POST",
      headers: { ...auth(customer), "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ accountId: "ACC-001", terminalId: "KIOSK-01", amount: { amount: 200, currency: "MAD" } }),
    },
  }),
  listTerminals: () => ({ path: "/terminals", init: { headers: auth(agent) } }),
  getTerminal: () => ({ path: "/terminals/KIOSK-02", init: { headers: auth(agent) } }),
};

function auth(user: typeof customer): Record<string, string> {
  return { Authorization: `Bearer ${tokenFor(user)}` };
}

let operations: Operation[] = [];
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("password", true);

beforeAll(async () => {
  const spec = (await SwaggerParser.dereference(SPEC_PATH)) as unknown as Spec;
  operations = Object.values(spec.paths).flatMap((pathItem) => Object.values(pathItem));
});

async function call(operationId: string, scenario: string) {
  const { path, init } = sampleRequests[operationId]!();
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-Id": correlationId,
      [SCENARIO_HEADER]: scenario,
      ...(init.headers as Record<string, string>),
    },
  });
  return { response, correlationId, body: await response.json() };
}

function expectConforms(operation: Operation, status: number, body: unknown) {
  const documented = operation.responses[String(status)];
  expect(documented, `${operation.operationId} returned undocumented status ${status}`).toBeDefined();
  const schema = documented!.content?.["application/json"]?.schema;
  expect(schema, `${operation.operationId} ${status} has no JSON schema`).toBeDefined();
  const validate = ajv.compile(schema!);
  const valid = validate(body);
  expect(valid, `${operation.operationId} ${status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe("OpenAPI contract", () => {
  it("has a mock sample for every operation, and no sample for an unknown operation", () => {
    const ids = operations.map((o) => o.operationId).sort();
    expect(Object.keys(sampleRequests).sort()).toEqual(ids);
  });

  for (const scenario of SCENARIOS) {
    it(`every mock response conforms to the contract in scenario "${scenario}"`, async () => {
      for (const operation of operations) {
        const { response, correlationId, body } = await call(operation.operationId, scenario);
        expectConforms(operation, response.status, body);
        expect(response.headers.get("X-Correlation-Id")).toBe(correlationId);
      }
    });
  }

  it("every operation has at least one success and one error scenario", async () => {
    for (const operation of operations) {
      const statuses = new Set<number>();
      for (const scenario of SCENARIOS) statuses.add((await call(operation.operationId, scenario)).response.status);
      expect([...statuses].some((s) => s < 300), `${operation.operationId} never succeeds`).toBe(true);
      expect([...statuses].some((s) => s >= 400), `${operation.operationId} never fails`).toBe(true);
    }
  });

  it("rejects a request without X-Correlation-Id with a documented 400", async () => {
    for (const operation of operations) {
      const { path, init } = sampleRequests[operation.operationId]!();
      const response = await fetch(`${BASE_URL}${path}`, init);
      const body = await response.json();
      expect(response.status).toBe(400);
      expectConforms(operation, 400, body);
    }
  });
});
