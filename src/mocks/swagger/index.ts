/**
 * Swagger UI for the mock server: `/docs` shows the contract, and "Try it out"
 * calls the mock. The page adds a role picker (demo tokens), a scenario picker
 * and generates `X-Correlation-Id` / `Idempotency-Key` when left empty.
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenFor, users } from "../fixtures/users";
import { samples } from "../samples";

const SPEC_PATH = fileURLToPath(new URL("../../../openapi/openapi.yaml", import.meta.url));
const PAGE_PATH = fileURLToPath(new URL("./index.html", import.meta.url));
const SWAGGER_DIR = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));

/** Only these files of swagger-ui-dist are served. */
const ASSETS: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "text/javascript; charset=utf-8",
  "favicon-32x32.png": "image/png",
  "favicon-16x16.png": "image/png",
};

const TOKENS = Object.fromEntries(
  (["CUSTOMER", "AGENT", "SUPERVISOR", "ADMIN"] as const).map((role) => [
    role,
    tokenFor(users.find((u) => u.roles.includes(role))!),
  ]),
);

type Parameter = { name?: string; in?: string; required?: boolean; description?: string; example?: unknown; $ref?: string };
type Operation = {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { example?: unknown }> };
};
type Spec = {
  servers?: unknown;
  paths: Record<string, Record<string, Operation>>;
  components: { parameters: Record<string, Parameter> };
};

/**
 * Pre-fills "Try it out" with the request samples (the ones the tests and the
 * Postman collection use): path parameters and JSON bodies.
 */
function addSampleExamples(spec: Spec) {
  for (const [template, pathItem] of Object.entries(spec.paths)) {
    const pattern = new RegExp(`^${template.replace(/\{\w+\}/g, "([^/]+)")}$`);
    const names = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    for (const operation of Object.values(pathItem)) {
      const sample = samples[operation.operationId];
      if (!sample) continue;
      const values = sample.path.split("?")[0]!.match(pattern)?.slice(1) ?? [];
      const pathValues = Object.fromEntries(names.map((name, i) => [name, values[i]]));

      operation.parameters = operation.parameters?.map((parameter) => {
        const resolved = parameter.$ref ? spec.components.parameters[parameter.$ref.split("/").pop()!]! : parameter;
        const example = resolved.in === "path" ? pathValues[resolved.name ?? ""] : undefined;
        return example === undefined ? parameter : { ...resolved, example };
      });
      const json = operation.requestBody?.content?.["application/json"];
      if (json && sample.body !== undefined) json.example = sample.body;
    }
  }
}

/**
 * The contract as Swagger shows it: served by this mock, generated headers
 * optional so "Execute" works when they are left empty, and pre-filled with
 * the request samples.
 * Read on every request, so edits to openapi.yaml show up on reload.
 */
async function docsSpec() {
  const spec = (await SwaggerParser.parse(SPEC_PATH)) as unknown as Spec;
  spec.servers = [{ url: "/api/v1", description: "Mock MSW (ce serveur)" }];
  for (const name of ["CorrelationId", "IdempotencyKey"]) {
    const parameter = spec.components.parameters[name];
    if (parameter) {
      parameter.required = false;
      parameter.description = `${parameter.description ?? ""} — Laisser vide : la page en génère un.`;
    }
  }
  addSampleExamples(spec);
  return spec;
}

/** Serves `/`, `/docs`, the Swagger assets and `/openapi.json` / `/openapi.yaml`. Returns false for other paths. */
export async function handleDocs(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (req.method !== "GET") return false;

  if (path === "/" || path === "/docs") {
    res.writeHead(302, { Location: "/docs/" });
    res.end();
    return true;
  }
  if (path === "/docs/") {
    const page = readFileSync(PAGE_PATH, "utf8").replace("__TOKENS__", JSON.stringify(TOKENS));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
    return true;
  }
  const asset = path.startsWith("/docs/") ? path.slice("/docs/".length) : "";
  const contentType = ASSETS[asset];
  if (contentType) {
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "max-age=3600" });
    res.end(readFileSync(join(SWAGGER_DIR, asset)));
    return true;
  }
  if (path === "/openapi.json") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(await docsSpec(), null, 2));
    return true;
  }
  if (path === "/openapi.yaml") {
    res.writeHead(200, { "Content-Type": "application/yaml; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(readFileSync(SPEC_PATH));
    return true;
  }
  return false;
}
