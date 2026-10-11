/**
 * One representative, valid request per operation of the contract, keyed by
 * operationId. Used by the contract tests and to generate the Postman collection.
 *
 * Run in the contract's order from fresh demo data, every sample succeeds:
 * a sample may rely on an earlier one (deleteKiosk deletes the kiosk that
 * createKiosk created) but never on a later one.
 */
import type { Schemas } from "../api/client";
import { depositSettings, withdrawalSettings } from "./fixtures/kms";
import { users } from "./fixtures/users";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Sample {
  /** Path under the API base (`/api/v1`), with the query string. */
  path: string;
  method?: HttpMethod;
  /** Role whose demo token authenticates the call; none for login. */
  as?: Schemas["Role"];
  body?: unknown;
  /** Needs an `Idempotency-Key` header (deposit, withdrawal). */
  idempotent?: boolean;
}

const customer = users.find((u) => u.roles.includes("CUSTOMER"))!;

export const samples: Record<string, Sample> = {
  login: {
    path: "/auth/login",
    method: "POST",
    body: { channel: "KIOSK", cardNumber: customer.cardNumber, pin: customer.pin, kioskId: "KIOSK-01" },
  },
  getBalance: { path: "/accounts/ACC-001/balance", as: "CUSTOMER" },
  listTransactions: { path: "/accounts/ACC-001/transactions?limit=5", as: "CUSTOMER" },
  createDeposit: {
    path: "/deposits",
    method: "POST",
    as: "CUSTOMER",
    idempotent: true,
    body: {
      accountId: "ACC-001",
      kioskId: "KIOSK-01",
      amount: { amount: 200, currency: "MAD" },
      notes: [{ denomination: 100, count: 2 }],
    },
  },
  createWithdrawal: {
    path: "/withdrawals",
    method: "POST",
    as: "CUSTOMER",
    idempotent: true,
    body: { accountId: "ACC-001", kioskId: "KIOSK-01", amount: { amount: 500, currency: "MAD" } },
  },

  listAccountApplications: { path: "/account-applications?status=UNDER_REVIEW", as: "COMPLIANCE" },
  createAccountApplication: {
    path: "/account-applications",
    method: "POST",
    body: {
      channel: "KIOSK",
      kioskId: "KIOSK-01",
      productCode: "CURRENT_ACCOUNT",
      applicant: { firstName: "Nadia", lastName: "Idrissi", phone: "+212698765432" },
      consents: { dataProcessing: true, marketing: false },
    },
  },
  getAccountApplication: { path: "/account-applications/APP-1001", as: "AGENT" },
  updateAccountApplication: {
    path: "/account-applications/APP-1001",
    method: "PATCH",
    as: "AGENT",
    body: { applicant: { email: "salma.bennani@example.ma" } },
  },
  listApplicationDocuments: { path: "/account-applications/APP-1001/documents", as: "AGENT" },
  uploadApplicationDocument: {
    path: "/account-applications/APP-1001/documents",
    method: "POST",
    as: "AGENT",
    body: { type: "PROOF_OF_INCOME", fileName: "bulletin-de-paie.pdf", mimeType: "application/pdf", contentBase64: "JVBERi0xLjQK" },
  },
  deleteApplicationDocument: { path: "/account-applications/APP-1003/documents/DOC-1003-1", method: "DELETE", as: "AGENT" },
  startPhoneVerification: { path: "/account-applications/APP-1001/phone-verification", method: "POST", as: "AGENT" },
  confirmPhoneVerification: {
    path: "/account-applications/APP-1001/phone-verification/confirm",
    method: "POST",
    as: "AGENT",
    body: { code: "123456" },
  },
  submitAccountApplication: { path: "/account-applications/APP-1001/submit", method: "POST", as: "AGENT" },
  decideAccountApplication: {
    path: "/account-applications/APP-1002/decision",
    method: "POST",
    as: "COMPLIANCE",
    body: { decision: "APPROVE", comment: "PEP : origine des fonds justifiée, validation du responsable conformité" },
  },
  cancelAccountApplication: {
    path: "/account-applications/APP-1003/cancel",
    method: "POST",
    as: "AGENT",
    body: { reason: "Le client renonce" },
  },

  listKiosks: { path: "/kms/kiosks?health=DEGRADED", as: "AGENT" },
  createKiosk: {
    path: "/kms/kiosks",
    method: "POST",
    as: "ADMIN",
    body: { kioskId: "KIOSK-99", name: "Kiosque Test", location: { branchName: "Agence Test", city: "Fès" } },
  },
  getKiosk: { path: "/kms/kiosks/KIOSK-02", as: "AGENT" },
  updateKiosk: { path: "/kms/kiosks/KIOSK-03", method: "PATCH", as: "ADMIN", body: { status: "MAINTENANCE" } },
  deleteKiosk: { path: "/kms/kiosks/KIOSK-99", method: "DELETE", as: "ADMIN" },
  listKioskServices: { path: "/kms/kiosks/KIOSK-02/services", as: "CUSTOMER" },
  assignKioskService: {
    path: "/kms/kiosks/KIOSK-03/services/WITHDRAWAL",
    method: "PUT",
    as: "ADMIN",
    body: { enabled: true },
  },
  unassignKioskService: { path: "/kms/kiosks/KIOSK-01/services/HISTORY", method: "DELETE", as: "ADMIN" },

  listKioskDevices: { path: "/kms/kiosks/KIOSK-02/devices", as: "AGENT" },
  addKioskDevice: {
    path: "/kms/kiosks/KIOSK-03/devices",
    method: "POST",
    as: "ADMIN",
    body: { deviceTypeCode: "RECEIPT_PRINTER", serialNumber: "SN-NEW-1", model: "TP-80" },
  },
  getKioskDevice: { path: "/kms/kiosks/KIOSK-02/devices/DEV-0204", as: "AGENT" },
  updateKioskDevice: {
    path: "/kms/kiosks/KIOSK-02/devices/DEV-0204",
    method: "PATCH",
    as: "ADMIN",
    body: { firmwareVersion: "1.0.1" },
  },
  removeKioskDevice: { path: "/kms/kiosks/KIOSK-02/devices/DEV-0206", method: "DELETE", as: "ADMIN" },
  changeDeviceStatus: {
    path: "/kms/kiosks/KIOSK-02/devices/DEV-0204/status",
    method: "PUT",
    as: "SUPERVISOR",
    body: { status: "OPERATIONAL", reason: "Bourrage résolu" },
  },
  listDeviceStatusHistory: { path: "/kms/kiosks/KIOSK-02/devices/DEV-0204/status-history", as: "AGENT" },
  listKioskStatusHistory: { path: "/kms/kiosks/KIOSK-02/status-history?status=ERROR&limit=10", as: "AGENT" },

  listDeviceTypes: { path: "/kms/device-types?category=CASH", as: "AGENT" },
  createDeviceType: {
    path: "/kms/device-types",
    method: "POST",
    as: "ADMIN",
    body: { deviceTypeCode: "NFC_READER", name: "Lecteur NFC", category: "CARD" },
  },
  getDeviceType: { path: "/kms/device-types/CASH_ACCEPTOR", as: "AGENT" },
  updateDeviceType: {
    path: "/kms/device-types/CAMERA",
    method: "PATCH",
    as: "ADMIN",
    body: { description: "Caméra frontale" },
  },
  deleteDeviceType: { path: "/kms/device-types/BARCODE_SCANNER", method: "DELETE", as: "ADMIN" },

  listServices: { path: "/kms/services", as: "AGENT" },
  createService: {
    path: "/kms/services",
    method: "POST",
    as: "ADMIN",
    body: { serviceCode: "BILL_PAYMENT", name: "Paiement de factures" },
  },
  getService: { path: "/kms/services/WITHDRAWAL", as: "AGENT" },
  updateService: { path: "/kms/services/STATEMENT", method: "PATCH", as: "ADMIN", body: { enabled: false } },
  deleteService: { path: "/kms/services/STATEMENT", method: "DELETE", as: "ADMIN" },
  listServiceDeviceRequirements: { path: "/kms/services/DEPOSIT/device-requirements", as: "AGENT" },
  setServiceDeviceRequirement: {
    path: "/kms/services/DEPOSIT/device-requirements/CAMERA",
    method: "PUT",
    as: "ADMIN",
    body: { requirement: "OPTIONAL" },
  },
  removeServiceDeviceRequirement: {
    path: "/kms/services/DEPOSIT/device-requirements/RECEIPT_PRINTER",
    method: "DELETE",
    as: "ADMIN",
  },

  getDepositSettings: { path: "/kms/deposit-settings", as: "CUSTOMER" },
  updateDepositSettings: {
    path: "/kms/deposit-settings",
    method: "PUT",
    as: "ADMIN",
    body: { ...depositSettings, maxAmountPerTransaction: 15000 },
  },
  getWithdrawalSettings: { path: "/kms/withdrawal-settings", as: "CUSTOMER" },
  updateWithdrawalSettings: {
    path: "/kms/withdrawal-settings",
    method: "PUT",
    as: "ADMIN",
    body: { ...withdrawalSettings, presetAmounts: [200, 400, 1000] },
  },
};
