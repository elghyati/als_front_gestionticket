import { setupServer } from "msw/node";
import { handlers } from "./handlers";

/** Mock server for Node (Vitest). Browser code uses `./browser` instead. */
export const server = setupServer(...handlers);
