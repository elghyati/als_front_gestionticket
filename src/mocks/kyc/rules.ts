/**
 * Account opening rules: what a complete application needs, the automatic
 * KYC checks and the resulting decision. Pure functions, used by the mock
 * handlers and unit-tested.
 *
 * Test data that triggers each outcome (documented in docs/api/ENDPOINTS.md):
 * - last name SANCTION              → sanctions hit, FAIL → REJECTED
 * - last name PEP, or isPoliticallyExposed → PEP, REVIEW + risk HIGH → UNDER_REVIEW
 * - selfie file name containing "mismatch" → face mismatch, FAIL → REJECTED
 * - ID number of an existing customer (BK123456) → REVIEW → UNDER_REVIEW
 * - usPerson                         → FATCA REVIEW → UNDER_REVIEW
 * - expired ID, or under 18          → FAIL → REJECTED
 */
import type { Schemas } from "../../api/client";

type Application = Schemas["AccountApplication"];
type Applicant = Schemas["Applicant"];
type Check = Schemas["KycCheck"];
type Detail = { field: string; issue: string };

export const SANCTIONS_LIST = ["SANCTION"];
export const PEP_LIST = ["PEP"];
export const HOME_COUNTRY = "MA";
export const MIN_AGE = 18;

const normalize = (name?: string) => (name ?? "").trim().toUpperCase();

/** Documents required on submit; ID_BACK only for a national ID card (CIN). */
export function requiredDocuments(applicant: Applicant): Schemas["ApplicationDocumentType"][] {
  return [
    "ID_FRONT",
    ...(applicant.idDocument?.type === "CIN" ? (["ID_BACK"] as const) : []),
    "SELFIE",
    "PROOF_OF_ADDRESS",
  ];
}

/** What is missing before the application can be submitted; empty when complete. */
export function missingForSubmit(application: Application): Detail[] {
  const a = application.applicant;
  const missing: Detail[] = [];
  const need = (value: unknown, field: string) => {
    if (value === undefined || value === null || value === "") missing.push({ field, issue: "is required" });
  };
  need(a.firstName, "applicant.firstName");
  need(a.lastName, "applicant.lastName");
  need(a.dateOfBirth, "applicant.dateOfBirth");
  need(a.nationality, "applicant.nationality");
  need(a.idDocument?.type, "applicant.idDocument.type");
  need(a.idDocument?.number, "applicant.idDocument.number");
  need(a.idDocument?.expiryDate, "applicant.idDocument.expiryDate");
  need(a.phone, "applicant.phone");
  need(a.address?.line1, "applicant.address.line1");
  need(a.address?.city, "applicant.address.city");
  need(a.address?.country, "applicant.address.country");
  need(a.occupation, "applicant.occupation");
  need(a.monthlyIncomeRange, "applicant.monthlyIncomeRange");
  need(a.sourceOfFunds, "applicant.sourceOfFunds");
  need(a.isPoliticallyExposed, "applicant.isPoliticallyExposed");
  need(a.usPerson, "applicant.usPerson");

  const present = new Set(application.documents.map((d) => d.type));
  for (const type of requiredDocuments(a)) {
    if (!present.has(type)) missing.push({ field: `documents.${type}`, issue: "is required" });
  }
  if (a.phone && !application.phoneVerified) missing.push({ field: "phoneVerified", issue: "phone must be verified" });
  if (application.consents?.dataProcessing !== true) {
    missing.push({ field: "consents.dataProcessing", issue: "consent is required" });
  }
  return missing;
}

/** Age in whole years at `today` (dates as YYYY-MM-DD). */
export function ageOn(dateOfBirth: string, today: Date): number {
  const [y, m, d] = dateOfBirth.split("-").map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age--;
  return age;
}

export interface KycContext {
  today: Date;
  /** ID document numbers of existing customers. */
  existingCustomerIds: Set<string>;
}

/** Runs the automatic KYC checks on a complete application. */
export function evaluateKyc(application: Application, ctx: KycContext): Schemas["KycResult"] {
  const a = application.applicant;
  const checks: Check[] = [];
  const add = (check: Check["check"], result: Check["result"], message: string, reasonCode?: string) =>
    checks.push({ check, result, message, ...(reasonCode && { reasonCode }) });

  const todayIso = ctx.today.toISOString().slice(0, 10);
  if ((a.idDocument?.expiryDate ?? "") < todayIso) {
    add("ID_DOCUMENT_VALIDITY", "FAIL", `ID document expired on ${a.idDocument?.expiryDate}`, "ID_EXPIRED");
  } else {
    add("ID_DOCUMENT_VALIDITY", "PASS", "ID document is valid");
  }

  const age = ageOn(a.dateOfBirth!, ctx.today);
  if (age < MIN_AGE) add("AGE", "FAIL", `Applicant is ${age}, minimum is ${MIN_AGE}`, "UNDERAGE");
  else add("AGE", "PASS", `Applicant is ${age}`);

  const selfie = application.documents.find((d) => d.type === "SELFIE");
  if (selfie?.fileName.toLowerCase().includes("mismatch")) {
    add("FACE_MATCH", "FAIL", "Selfie does not match the ID photo", "FACE_MISMATCH");
  } else {
    add("FACE_MATCH", "PASS", "Selfie matches the ID photo");
  }

  const lastName = normalize(a.lastName);
  if (SANCTIONS_LIST.includes(lastName)) {
    add("SANCTIONS_SCREENING", "FAIL", "Name found on a sanctions list", "SANCTIONS_HIT");
  } else {
    add("SANCTIONS_SCREENING", "PASS", "No sanctions match");
  }

  const pep = a.isPoliticallyExposed === true || PEP_LIST.includes(lastName);
  if (a.isPoliticallyExposed) add("PEP_SCREENING", "REVIEW", "Declared politically exposed person", "PEP_DECLARED");
  else if (pep) add("PEP_SCREENING", "REVIEW", "Name found on the PEP list", "PEP_LIST_HIT");
  else add("PEP_SCREENING", "PASS", "Not a politically exposed person");

  if (a.idDocument?.number && ctx.existingCustomerIds.has(a.idDocument.number)) {
    add("DUPLICATE_CUSTOMER", "REVIEW", "This ID document belongs to an existing customer", "EXISTING_CUSTOMER");
  } else {
    add("DUPLICATE_CUSTOMER", "PASS", "New customer");
  }

  if (a.usPerson) add("FATCA", "REVIEW", "US person: FATCA form W-9 required", "US_PERSON");
  else add("FATCA", "PASS", "Not a US person");

  const riskLevel: Schemas["RiskLevel"] = pep
    ? "HIGH"
    : a.nationality !== HOME_COUNTRY || a.usPerson || a.sourceOfFunds === "OTHER"
      ? "MEDIUM"
      : "LOW";

  const outcome = checks.some((c) => c.result === "FAIL")
    ? "AUTO_REJECTED"
    : checks.some((c) => c.result === "REVIEW") || riskLevel === "HIGH"
      ? "MANUAL_REVIEW"
      : "AUTO_APPROVED";

  return { checks, riskLevel, outcome, evaluatedAt: ctx.today.toISOString() };
}

/** Moroccan RIB: bank (3) + city (3) + account number (16) + key (2), key = 97 − (number × 100 mod 97). */
export function rib(bankCode: string, cityCode: string, accountNumber: string): string {
  const base = `${bankCode}${cityCode}${accountNumber.padStart(16, "0")}`;
  const key = 97n - ((BigInt(base) * 100n) % 97n);
  return `${base}${String(key).padStart(2, "0")}`;
}

export const isValidRib = (value: string) => /^\d{24}$/.test(value) && BigInt(value) % 97n === 0n;

/** "+212612345678" → "+2126******78" */
export const maskPhone = (phone: string) =>
  phone.length <= 7 ? phone : `${phone.slice(0, 5)}${"*".repeat(phone.length - 7)}${phone.slice(-2)}`;
