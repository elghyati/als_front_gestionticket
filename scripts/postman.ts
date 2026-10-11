/**
 * Builds the Postman collection (v2.1) and environments from the OpenAPI
 * contract and the request samples of `src/mocks/samples.ts`.
 * Regenerate with `npm run postman:build`; a test checks they are up to date.
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import { samples, type Sample } from "../src/mocks/samples";
import { SCENARIOS } from "../src/mocks/scenarios";
import { tokenFor, users } from "../src/mocks/fixtures/users";

const SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
const COLLECTION_ID = "5f0c2a6e-8a43-4c1e-9a55-3b7f8e0d4a11";
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface Operation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  responses: Record<string, unknown>;
}
interface Spec {
  info: { title: string; version: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>;
}

type Header = { key: string; value: string; description?: string; disabled?: boolean };
type Item = Record<string, unknown>;

export const ROLE_VARIABLES = ["CUSTOMER", "AGENT", "SUPERVISOR", "ADMIN", "COMPLIANCE"].map((role) => ({
  role,
  key: `token_${role.toLowerCase()}`,
  value: tokenFor(users.find((u) => u.roles.includes(role as never))!),
}));

const tokenVariable = (role: string) => `token_${role.toLowerCase()}`;

/** Expected success status of an operation: its first documented 2xx. */
export const successStatus = (operation: Operation) =>
  Number(Object.keys(operation.responses).find((status) => status.startsWith("2")));

function url(base: string, pathAndQuery: string) {
  const [path = "", query] = pathAndQuery.split("?");
  return {
    raw: `{{${base}}}${pathAndQuery}`,
    host: [`{{${base}}}`],
    path: path.split("/").filter(Boolean),
    ...(query && {
      query: [...new URLSearchParams(query)].map(([key, value]) => ({ key, value })),
    }),
  };
}

const jsonBody = (body: unknown) => ({
  mode: "raw",
  raw: JSON.stringify(body, null, 2),
  options: { raw: { language: "json" } },
});

const testScript = (lines: string[]) => [{ listen: "test", script: { type: "text/javascript", exec: lines } }];

function requestItem(operation: Operation, sample: Sample): Item {
  const method = sample.method ?? "GET";
  const expected = successStatus(operation);
  const headers: Header[] = [
    { key: "X-Correlation-Id", value: "{{$guid}}", description: "Obligatoire : un UUID par action" },
    ...(sample.idempotent
      ? [{ key: "Idempotency-Key", value: "{{$guid}}", description: "Obligatoire : un UUID par opération" }]
      : []),
    ...(sample.body !== undefined ? [{ key: "Content-Type", value: "application/json" }] : []),
    {
      key: "X-Mock-Scenario",
      value: "cbsDown",
      disabled: true,
      description: `Mock uniquement : force un scénario pour cette requête (${SCENARIOS.join(", ")})`,
    },
  ];
  const description = [
    operation.description?.trim(),
    sample.as ? `**Rôle utilisé :** ${sample.as} (variable \`{{${tokenVariable(sample.as)}}}\`).` : "**Sans authentification.**",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    name: operation.summary ?? operation.operationId,
    request: {
      method,
      auth: sample.as
        ? { type: "bearer", bearer: [{ key: "token", value: `{{${tokenVariable(sample.as)}}}`, type: "string" }] }
        : { type: "noauth" },
      header: headers,
      url: url("baseUrl", sample.path),
      ...(sample.body !== undefined && { body: jsonBody(sample.body) }),
      description,
    },
    event: testScript([
      `pm.test("HTTP ${expected}", function () {`,
      `    pm.response.to.have.status(${expected});`,
      "});",
      ...(operation.operationId === "login"
        ? [
            "if (pm.response.code === 200) {",
            "    const session = pm.response.json();",
            '    if (session.user.roles.includes("CUSTOMER")) pm.collectionVariables.set("token_customer", session.accessToken);',
            "}",
          ]
        : []),
    ]),
    response: [],
  };
}

function mockControlFolder(): Item {
  const control = (name: string, method: string, path: string, description: string, body?: unknown): Item => ({
    name,
    request: {
      method,
      auth: { type: "noauth" },
      header: body ? [{ key: "Content-Type", value: "application/json" }] : [],
      url: url("mockUrl", path),
      ...(body !== undefined && { body: jsonBody(body) }),
      description,
    },
    response: [],
  });
  return {
    name: "0 · Pilotage du mock (npm run mock:server)",
    description:
      "Uniquement avec `npm run mock:server`. **Réinitialiser** restaure les données : certaines requêtes de la collection en suppriment ou en créent.",
    // Reset last: a full "Run collection" then always starts from the demo data and scenario ok.
    item: [
      control("Lire le scénario courant", "GET", "/__mock", "Scénario courant et liste des scénarios."),
      control(
        "Changer de scénario",
        "POST",
        "/__mock/scenario",
        `Scénarios : ${SCENARIOS.map((s) => `\`${s}\``).join(", ")}. \`timeoutDelayMs\` est optionnel.`,
        { scenario: "cbsDown", timeoutDelayMs: 3000 },
      ),
      control(
        "Réinitialiser les données et le scénario",
        "POST",
        "/__mock/reset",
        "Restaure les données de démonstration et le scénario `ok`. À lancer avant de rejouer la collection.",
      ),
    ],
  };
}

export async function buildCollection(specPath: string) {
  const spec = (await SwaggerParser.parse(specPath)) as unknown as Spec;
  const operations = Object.values(spec.paths).flatMap((pathItem) =>
    METHODS.flatMap((m) => (pathItem[m] ? [pathItem[m]!] : [])),
  );

  const folders = (spec.tags ?? []).map((tag, i) => ({
    name: `${i + 1} · ${tag.name}`,
    description: tag.description,
    item: operations
      .filter((op) => op.tags?.[0] === tag.name)
      .map((op) => {
        const sample = samples[op.operationId];
        if (!sample) throw new Error(`No sample for ${op.operationId} in src/mocks/samples.ts`);
        return requestItem(op, sample);
      }),
  }));

  return {
    info: {
      _postman_id: COLLECTION_ID,
      name: `ALS – ${spec.info.title.replace(/^ALS Front – /, "")} (${spec.info.version})`,
      description: [
        "Collection générée depuis `openapi/openapi.yaml` (`npm run postman:build`). Ne pas modifier à la main.",
        "",
        "1. Lancez `npm run mock:server` (ou `npm run mock:prism`) et choisissez l'environnement correspondant.",
        "2. Chaque requête porte déjà son token (variables `token_*`), un `X-Correlation-Id` et, pour les opérations d'argent, un `Idempotency-Key` générés.",
        "3. Pour rejouer toute la collection (Run collection), lancez d'abord **Réinitialiser** dans le dossier 0.",
      ].join("\n"),
      schema: SCHEMA,
    },
    item: [mockControlFolder(), ...folders],
    variable: [
      { key: "baseUrl", value: "http://localhost:4000/api/v1" },
      { key: "mockUrl", value: "http://localhost:4000" },
      ...ROLE_VARIABLES.map(({ key, value }) => ({ key, value })),
    ],
  };
}

const environment = (name: string, values: Record<string, string>) => ({
  name,
  values: Object.entries(values).map(([key, value]) => ({ key, value, type: "default", enabled: true })),
  _postman_variable_scope: "environment",
});

export const environments = {
  "als-mock-server.postman_environment.json": environment("ALS – Mock MSW (localhost:4000)", {
    baseUrl: "http://localhost:4000/api/v1",
    mockUrl: "http://localhost:4000",
  }),
  "als-prism.postman_environment.json": environment("ALS – Prism (localhost:4010)", {
    baseUrl: "http://localhost:4010",
    mockUrl: "http://localhost:4010",
  }),
};

export const COLLECTION_FILE = "als-api.postman_collection.json";
