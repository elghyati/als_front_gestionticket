/** The Postman collection is up to date with the contract, and every request in it works against the mock. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCollection, COLLECTION_FILE, environments } from "../scripts/postman";
import { resetMockState } from "../src/mocks/state";
import { BASE_URL } from "./helpers";

const root = new URL("../", import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`postman/${file}`, root)), "utf8"));
const specPath = fileURLToPath(new URL("openapi/openapi.yaml", root));

interface PostmanRequest {
  name: string;
  request: {
    method: string;
    url: { raw: string; host: string[] };
    header: { key: string; value: string; disabled?: boolean }[];
    auth: { type: string; bearer?: { value: string }[] };
    body?: { raw: string };
  };
  event?: { script: { exec: string[] } }[];
}
interface Folder {
  name: string;
  item: PostmanRequest[];
}

describe("Postman collection", () => {
  it("is up to date with the contract (run npm run postman:build)", async () => {
    expect(read(COLLECTION_FILE)).toEqual(JSON.parse(JSON.stringify(await buildCollection(specPath))));
    for (const [file, env] of Object.entries(environments)) expect(read(file)).toEqual(env);
  });

  it("every API request returns its expected status, run in order", async () => {
    const collection = read(COLLECTION_FILE) as { item: Folder[]; variable: { key: string; value: string }[] };
    const variables: Record<string, string> = {
      ...Object.fromEntries(collection.variable.map((v) => [v.key, v.value])),
      baseUrl: BASE_URL,
    };
    const resolve = (text: string) =>
      text.replace(/\{\{(\$?\w+)\}\}/g, (_, name: string) => (name === "$guid" ? crypto.randomUUID() : variables[name] ?? ""));

    resetMockState();
    const requests = collection.item.flatMap((folder) => folder.item).filter((r) => r.request.url.host[0] === "{{baseUrl}}");
    expect(requests).toHaveLength(38);

    for (const { name, request, event } of requests) {
      const expected = Number(event?.[0]?.script.exec.join("\n").match(/have\.status\((\d+)\)/)?.[1]);
      const headers = Object.fromEntries(
        request.header.filter((h) => !h.disabled).map((h) => [h.key, resolve(h.value)]),
      );
      if (request.auth.type === "bearer") headers.Authorization = `Bearer ${resolve(request.auth.bearer![0]!.value)}`;

      const response = await fetch(resolve(request.url.raw), {
        method: request.method,
        headers,
        ...(request.body && { body: resolve(request.body.raw) }),
      });
      expect(response.status, name).toBe(expected);
    }
  });
});
