import { setupWorker } from "msw/browser";
import { resetMockState } from "./state";
import { handlers } from "./handlers";
import { getScenario, isScenario, SCENARIOS, setScenario, setTimeoutDelay, type Scenario } from "./scenarios";

const STORAGE_KEY = "mockScenario";

export const worker = setupWorker(...handlers);

/** Dev harness and Playwright entry point, available as `window.__mock`. */
export interface MockControls {
  scenarios: readonly Scenario[];
  getScenario: () => Scenario;
  /** Switches the scenario and remembers it across reloads. */
  setScenario: (scenario: Scenario) => void;
  setTimeoutDelay: (ms: number) => void;
  /** Restores the fixtures (balances, history, terminals). */
  reset: () => void;
}

declare global {
  interface Window {
    __mock?: MockControls;
  }
}

function readStoredScenario(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeScenario(scenario: Scenario): void {
  try {
    localStorage.setItem(STORAGE_KEY, scenario);
  } catch {
    // Storage blocked (private mode): the switch still works until reload.
  }
}

/**
 * Starts the mock in the browser. Call it before rendering the app, in dev only:
 *
 *   if (import.meta.env.DEV) await startMockWorker();
 *
 * Initial scenario: `?mockScenario=cbsDown` in the URL, else the last one used, else `ok`.
 */
export async function startMockWorker() {
  const fromUrl = new URLSearchParams(window.location.search).get(STORAGE_KEY);
  const initial = [fromUrl, readStoredScenario()].find(isScenario);
  if (initial) setScenario(initial);

  window.__mock = {
    scenarios: SCENARIOS,
    getScenario,
    setScenario: (scenario) => {
      setScenario(scenario);
      storeScenario(scenario);
    },
    setTimeoutDelay,
    reset: resetMockState,
  };

  return worker.start({ onUnhandledRequest: "bypass" });
}
