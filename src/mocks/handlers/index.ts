import { accountHandlers } from "./accounts";
import { applicationHandlers } from "./applications";
import { authHandlers } from "./auth";
import { deviceHandlers } from "./devices";
import { kioskHandlers } from "./kiosks";
import { settingsHandlers } from "./settings";
import { transactionHandlers } from "./transactions";

export const handlers = [
  ...authHandlers,
  ...accountHandlers,
  ...transactionHandlers,
  ...applicationHandlers,
  ...kioskHandlers,
  ...deviceHandlers,
  ...settingsHandlers,
];
