import { createApiClient, newCorrelationId } from "../src/api/client";
import { tokenFor, users, type MockUser } from "../src/mocks/fixtures";

export const BASE_URL = "http://localhost/api/v1";

export function userWithRole(role: MockUser["roles"][number]): MockUser {
  const user = users.find((u) => u.roles.includes(role));
  if (!user) throw new Error(`No fixture user with role ${role}`);
  return user;
}

export const customer = userWithRole("CUSTOMER");
export const agent = userWithRole("AGENT");
export const supervisor = userWithRole("SUPERVISOR");
export const admin = userWithRole("ADMIN");

export const clientFor = (user?: MockUser) =>
  createApiClient({ baseUrl: BASE_URL, getToken: () => (user ? tokenFor(user) : undefined) });

export const headers = () => ({ "X-Correlation-Id": newCorrelationId() });

export const idempotentHeaders = () => ({ ...headers(), "Idempotency-Key": crypto.randomUUID() });
