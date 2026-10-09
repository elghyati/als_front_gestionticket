import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];

export const API_BASE_PATH = "/api/v1";

export interface ApiClientOptions {
  /** Defaults to the same-origin base path. Tests in Node need an absolute URL. */
  baseUrl?: string;
  /** Returns the current access token, if any. */
  getToken?: () => string | undefined;
}

/** One id per user action, sent as `X-Correlation-Id` (see the contract conventions). */
export const newCorrelationId = (): string => crypto.randomUUID();

export function createApiClient({ baseUrl = API_BASE_PATH, getToken }: ApiClientOptions = {}) {
  const client = createClient<paths>({ baseUrl });
  client.use({
    onRequest({ request }) {
      const token = getToken?.();
      if (token) request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  });
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
