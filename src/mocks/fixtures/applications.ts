/**
 * Demo account opening applications. KYC results of submitted ones are
 * computed at reset (see state.ts), so they always follow the rules.
 */
import type { Schemas } from "../../api/client";

type Application = Schemas["AccountApplication"];
type Document = Schemas["ApplicationDocument"];

/** ID document numbers of existing customers (DUPLICATE_CUSTOMER check). */
export const EXISTING_CUSTOMER_ID_NUMBERS = ["BK123456"];

/** The mock's SMS always carries this code. */
export const MOCK_OTP_CODE = "123456";

const T = "2026-10-01T09:00:00Z";
const EXPIRES = "2026-10-31T09:00:00Z";

const doc = (applicationId: string, n: number, type: Document["type"], fileName: string, mimeType: Document["mimeType"] = "image/jpeg"): Document => ({
  documentId: `DOC-${applicationId.slice(4)}-${n}`,
  type,
  fileName,
  mimeType,
  sizeBytes: 180_000 + n * 1_000,
  uploadedAt: T,
});

const kycDocuments = (id: string) => [
  doc(id, 1, "ID_FRONT", "cin-recto.jpg"),
  doc(id, 2, "ID_BACK", "cin-verso.jpg"),
  doc(id, 3, "SELFIE", "selfie.jpg"),
  doc(id, 4, "PROOF_OF_ADDRESS", "facture-electricite.pdf", "application/pdf"),
];

export interface ApplicationFixture {
  application: Application;
  /** Application token, for the KIOSK channel. */
  token?: string;
  /** A code was sent by SMS and is still pending. */
  otpPending?: boolean;
}

export const applications: ApplicationFixture[] = [
  {
    // Complete draft started on a kiosk; only the phone is left to verify.
    application: {
      applicationId: "APP-1001",
      status: "DRAFT",
      channel: "KIOSK",
      kioskId: "KIOSK-01",
      productCode: "CURRENT_ACCOUNT",
      applicant: {
        firstName: "Salma",
        lastName: "Bennani",
        dateOfBirth: "1992-04-15",
        placeOfBirth: "Casablanca",
        nationality: "MA",
        idDocument: { type: "CIN", number: "BE987654", issueDate: "2021-03-01", expiryDate: "2031-03-01" },
        phone: "+212612345678",
        address: { line1: "25 rue Ibn Sina", city: "Casablanca", postalCode: "20000", country: "MA" },
        occupation: "Ingénieure",
        employerName: "Société Démo",
        monthlyIncomeRange: "FROM_10000_TO_30000",
        sourceOfFunds: "SALARY",
        isPoliticallyExposed: false,
        usPerson: false,
      },
      consents: { dataProcessing: true, marketing: false },
      phoneVerified: false,
      documents: kycDocuments("APP-1001"),
      createdAt: T,
      updatedAt: T,
      expiresAt: EXPIRES,
    },
    token: "app-token-APP-1001",
    otpPending: true,
  },
  {
    // Declared PEP, opened at the branch: waiting for compliance.
    application: {
      applicationId: "APP-1002",
      status: "UNDER_REVIEW",
      channel: "BRANCH",
      productCode: "SAVINGS_ACCOUNT",
      applicant: {
        firstName: "Karim",
        lastName: "Alaoui",
        dateOfBirth: "1975-09-02",
        nationality: "MA",
        idDocument: { type: "CIN", number: "A123987", issueDate: "2019-06-10", expiryDate: "2029-06-10" },
        phone: "+212661112233",
        email: "k.alaoui@example.ma",
        address: { line1: "8 avenue Mohammed VI", city: "Rabat", postalCode: "10000", country: "MA" },
        occupation: "Haut fonctionnaire",
        monthlyIncomeRange: "OVER_30000",
        sourceOfFunds: "SALARY",
        isPoliticallyExposed: true,
        usPerson: false,
      },
      consents: { dataProcessing: true, marketing: true },
      phoneVerified: true,
      documents: kycDocuments("APP-1002"),
      createdBy: "U-AGENT-1",
      createdAt: T,
      updatedAt: "2026-10-01T09:30:00Z",
      submittedAt: "2026-10-01T09:30:00Z",
      expiresAt: EXPIRES,
    },
  },
  {
    // Barely started at the branch.
    application: {
      applicationId: "APP-1003",
      status: "DRAFT",
      channel: "BRANCH",
      productCode: "BASIC_ACCOUNT",
      applicant: { firstName: "Youssef", lastName: "Tahiri", phone: "+212677889900" },
      phoneVerified: false,
      documents: [doc("APP-1003", 1, "ID_FRONT", "cin-recto.jpg")],
      createdBy: "U-AGENT-1",
      createdAt: "2026-10-02T10:00:00Z",
      updatedAt: "2026-10-02T10:00:00Z",
      expiresAt: "2026-11-01T10:00:00Z",
    },
  },
  {
    // On a sanctions list: rejected automatically.
    application: {
      applicationId: "APP-1004",
      status: "REJECTED",
      channel: "KIOSK",
      kioskId: "KIOSK-01",
      productCode: "CURRENT_ACCOUNT",
      applicant: {
        firstName: "Test",
        lastName: "Sanction",
        dateOfBirth: "1980-01-01",
        nationality: "MA",
        idDocument: { type: "CIN", number: "ZZ000001", issueDate: "2020-01-01", expiryDate: "2030-01-01" },
        phone: "+212600000001",
        address: { line1: "1 rue Test", city: "Tanger", country: "MA" },
        occupation: "Commerçant",
        monthlyIncomeRange: "FROM_3000_TO_10000",
        sourceOfFunds: "BUSINESS",
        isPoliticallyExposed: false,
        usPerson: false,
      },
      consents: { dataProcessing: true, marketing: false },
      phoneVerified: true,
      documents: kycDocuments("APP-1004"),
      createdAt: "2026-09-28T15:00:00Z",
      updatedAt: "2026-09-28T15:20:00Z",
      submittedAt: "2026-09-28T15:20:00Z",
      expiresAt: "2026-10-28T15:00:00Z",
    },
    token: "app-token-APP-1004",
  },
];
