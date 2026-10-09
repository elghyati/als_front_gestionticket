/**
 * Scenario switches for the mock API.
 *
 * - `ok`           every call succeeds
 * - `cbsDown`      the core banking system is down → 503 CBS_UNAVAILABLE
 * - `timeout`      a downstream system does not answer → 504 after `timeoutDelayMs`
 * - `refused`      business refusal (deposit 422, wrong PIN 401, missing role 403)
 * - `unauthorized` the session is rejected → 401 on every authenticated call
 *
 * The active scenario is global; a single request can override it with the
 * `X-Mock-Scenario` header.
 */
export const SCENARIOS = ["ok", "cbsDown", "timeout", "refused", "unauthorized"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const SCENARIO_HEADER = "X-Mock-Scenario";

let current: Scenario = "ok";
let timeoutDelayMs = 3000;

export const isScenario = (value: unknown): value is Scenario =>
  typeof value === "string" && (SCENARIOS as readonly string[]).includes(value);

export function setScenario(scenario: Scenario): void {
  current = scenario;
}

export function getScenario(): Scenario {
  return current;
}

export function setTimeoutDelay(ms: number): void {
  timeoutDelayMs = ms;
}

export function getTimeoutDelay(): number {
  return timeoutDelayMs;
}

export function resetScenario(): void {
  current = "ok";
  timeoutDelayMs = 3000;
}

/** Scenario for one request: the header override wins over the global switch. */
export function scenarioFor(request: Request): Scenario {
  const override = request.headers.get(SCENARIO_HEADER);
  return isScenario(override) ? override : current;
}
