/**
 * Contract tests: every operation of openapi/openapi.yaml is mocked, and every
 * mock response, in every scenario, has a status documented for that operation
 * and a body that validates against the documented schema.
 *
 * The samples run in the contract's order from fresh demo data, as a Postman
 * collection run would.
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { tokenFor } from "../src/mocks/fixtures";
import { samples } from "../src/mocks/samples";
import { SCENARIO_HEADER, SCENARIOS, type Scenario } from "../src/mocks/scenarios";
import { resetMockState } from "../src/mocks/state";
import { BASE_URL, userWithRole } from "./helpers";

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

let operations: Operation[] = [];
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("password", true);

beforeAll(async () => {
  const spec = (await SwaggerParser.dereference(SPEC_PATH)) as unknown as Spec;
  operations = Object.values(spec.paths).flatMap((pathItem) => Object.values(pathItem));
});

async function call(operationId: string, scenario: Scenario, { withCorrelationId = true } = {}) {
  const sample = samples[operationId]!;
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${BASE_URL}${sample.path}`, {
    method: sample.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      [SCENARIO_HEADER]: scenario,
      ...(withCorrelationId && { "X-Correlation-Id": correlationId }),
      ...(sample.as && { Authorization: `Bearer ${tokenFor(userWithRole(sample.as))}` }),
      ...(sample.idempotent && { "Idempotency-Key": crypto.randomUUID() }),
    },
    ...(sample.body !== undefined && { body: JSON.stringify(sample.body) }),
  });
  const text = await response.text();
  return { response, correlationId, body: text ? JSON.parse(text) : undefined };
}

/** Runs every sample in order from fresh data; returns the status of each operation. */
async function runAll(scenario: Scenario, check: (op: Operation, result: Awaited<ReturnType<typeof call>>) => void) {
  resetMockState();
  const statuses = new Map<string, number>();
  for (const operation of operations) {
    const result = await call(operation.operationId, scenario);
    check(operation, result);
    statuses.set(operation.operationId, result.response.status);
  }
  return statuses;
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
      if (schema) expectValid(schema, samples[operation.operationId]!.body, `${operation.operationId} request`);
    }
  });

  const statusesByScenario = new Map<Scenario, Map<string, number>>();

  for (const scenario of SCENARIOS) {
    it(`every mock response conforms to the contract in scenario "${scenario}"`, async () => {
      const statuses = await runAll(scenario, (operation, { response, correlationId, body }) => {
        expectConforms(operation, response.status, body);
        expect(response.headers.get("X-Correlation-Id"), operation.operationId).toBe(correlationId);
      });
      statusesByScenario.set(scenario, statuses);
    });
  }

  it("every sample succeeds in scenario ok, run in order", () => {
    for (const [operationId, status] of statusesByScenario.get("ok")!) {
      expect(status, operationId).toBeLessThan(300);
    }
  });

  it("every operation fails in at least one other scenario", () => {
    for (const operation of operations) {
      const failures = SCENARIOS.filter((s) => s !== "ok").filter(
        (s) => statusesByScenario.get(s)!.get(operation.operationId)! >= 400,
      );
      expect(failures, `${operation.operationId} never fails`).not.toHaveLength(0);
    }
  });

  it("rejects a request without X-Correlation-Id with a documented 400", async () => {
    resetMockState();
    for (const operation of operations) {
      const { response, body } = await call(operation.operationId, "ok", { withCorrelationId: false });
      expect(response.status, operation.operationId).toBe(400);
      expectConforms(operation, 400, body);
    }
  });
});
