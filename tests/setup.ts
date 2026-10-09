import { afterAll, afterEach, beforeAll } from "vitest";
import { resetMockState } from "../src/mocks/fixtures";
import { server } from "../src/mocks/node";
import { resetScenario, setTimeoutDelay } from "../src/mocks/scenarios";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetScenario();
  setTimeoutDelay(0);
  resetMockState();
});
afterAll(() => server.close());

setTimeoutDelay(0);
