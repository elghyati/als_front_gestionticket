import type { Schemas } from "../../api/client";

type User = Schemas["User"];

export interface MockUser extends User {
  /** Kiosk login */
  cardNumber?: string;
  pin?: string;
  /** Portal login */
  username?: string;
  password?: string;
}

export const users: MockUser[] = [
  {
    id: "U-CUST-1",
    displayName: "Client Démo",
    roles: ["CUSTOMER"],
    accountIds: ["ACC-001", "ACC-002"],
    cardNumber: "4000000000000001",
    pin: "1234",
  },
  { id: "U-AGENT-1", displayName: "Agent Démo", roles: ["AGENT"], username: "agent", password: "agent" },
  {
    id: "U-SUP-1",
    displayName: "Superviseur Démo",
    roles: ["SUPERVISOR"],
    username: "superviseur",
    password: "superviseur",
  },
  { id: "U-ADMIN-1", displayName: "Admin Démo", roles: ["ADMIN"], username: "admin", password: "admin" },
  {
    id: "U-COMP-1",
    displayName: "Conformité Démo",
    roles: ["COMPLIANCE"],
    username: "conformite",
    password: "conformite",
  },
];

export const tokenFor = (user: User): string => `mock-token-${user.id}`;
