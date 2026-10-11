/**
 * Account opening with KYC. An application is reached either with its own
 * application token (KIOSK channel, the prospect has no account yet) or by
 * staff with a role token.
 */
import { http } from "msw";
import type { Schemas } from "../../api/client";
import { MOCK_OTP_CODE, type MockUser } from "../fixtures";
import { serviceAvailabilityOn } from "../kms/availability";
import { evaluateKyc, maskPhone, missingForSubmit, rib } from "../kyc/rules";
import { scenarioFor } from "../scenarios";
import { now, nextId, OTP_ATTEMPTS, OTP_TTL_MS, state } from "../state";
import {
  api,
  conflict,
  error,
  invalid,
  isNonEmptyString,
  isOneOf,
  json,
  noContent,
  notFound,
  paginate,
  precheck,
  readBody,
  userFromToken,
  Validator,
  type CoversAll,
} from "./http";

type Application = Schemas["AccountApplication"];
type Applicant = Schemas["Applicant"];
type Role = Schemas["Role"];
type AppParams = { applicationId: string };

const STAFF_READ: Role[] = ["AGENT", "SUPERVISOR", "ADMIN", "COMPLIANCE"];
const STAFF_WRITE: Role[] = ["AGENT", "ADMIN"];
const COMPLIANCE: Role[] = ["COMPLIANCE"];

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const DRAFT_TTL_MS = 30 * 24 * 3600_000;

const STATUSES = ["DRAFT", "UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED"] as const satisfies readonly Schemas["ApplicationStatus"][];
const CHANNELS = ["KIOSK", "BRANCH"] as const satisfies readonly Schemas["ApplicationChannel"][];
const PRODUCTS = ["CURRENT_ACCOUNT", "SAVINGS_ACCOUNT", "BASIC_ACCOUNT"] as const satisfies readonly Schemas["AccountProduct"][];
const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const satisfies readonly Schemas["RiskLevel"][];
const ID_TYPES = ["CIN", "PASSPORT", "RESIDENCE_PERMIT"] as const satisfies readonly Schemas["IdDocumentType"][];
const INCOME_RANGES = ["UNDER_3000", "FROM_3000_TO_10000", "FROM_10000_TO_30000", "OVER_30000"] as const satisfies readonly Schemas["IncomeRange"][];
const SOURCES = ["SALARY", "BUSINESS", "PENSION", "SAVINGS", "FAMILY_SUPPORT", "OTHER"] as const satisfies readonly Schemas["SourceOfFunds"][];
const DOCUMENT_TYPES = ["ID_FRONT", "ID_BACK", "SELFIE", "PROOF_OF_ADDRESS", "PROOF_OF_INCOME"] as const satisfies readonly Schemas["ApplicationDocumentType"][];
const MIME_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const satisfies readonly Schemas["DocumentMimeType"][];

const covers: [
  CoversAll<Schemas["ApplicationStatus"], typeof STATUSES>,
  CoversAll<Schemas["ApplicationChannel"], typeof CHANNELS>,
  CoversAll<Schemas["AccountProduct"], typeof PRODUCTS>,
  CoversAll<Schemas["RiskLevel"], typeof RISK_LEVELS>,
  CoversAll<Schemas["IdDocumentType"], typeof ID_TYPES>,
  CoversAll<Schemas["IncomeRange"], typeof INCOME_RANGES>,
  CoversAll<Schemas["SourceOfFunds"], typeof SOURCES>,
  CoversAll<Schemas["ApplicationDocumentType"], typeof DOCUMENT_TYPES>,
  CoversAll<Schemas["DocumentMimeType"], typeof MIME_TYPES>,
] = [true, true, true, true, true, true, true, true, true];
void covers;

// ───────────────────────── access ─────────────────────────

type Principal = { kind: "applicant" } | { kind: "staff"; user: MockUser };
type Access =
  | { response: Response; principal?: never; application?: never }
  | { response?: never; principal: Principal; application: Application };

const bearer = (request: Request) => request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");

/** The application token of this application, or a staff token with one of `staffRoles`; then the application. */
async function access(request: Request, applicationId: string, staffRoles: Role[]): Promise<Access> {
  const rejected = await precheck(request, "CBS");
  if (rejected) return { response: rejected };

  const scenario = scenarioFor(request);
  const token = bearer(request);
  const tokenApplication = token ? state.applicationTokens.get(token) : undefined;
  if (scenario === "unauthorized" || (!tokenApplication && !userFromToken(request))) {
    return { response: error(request, 401, "UNAUTHORIZED", "Missing, invalid or expired token") };
  }

  let principal: Principal;
  if (tokenApplication) {
    if (tokenApplication !== applicationId) {
      return { response: error(request, 403, "FORBIDDEN", "This application token is for another application") };
    }
    principal = { kind: "applicant" };
  } else {
    const user = userFromToken(request)!;
    if (scenario === "refused" || !user.roles.some((r) => staffRoles.includes(r))) {
      return { response: error(request, 403, "FORBIDDEN", `Requires the application token or one of: ${staffRoles.join(", ")}`) };
    }
    principal = { kind: "staff", user };
  }

  const application = state.applications.get(applicationId);
  if (!application) return { response: notFound(request, "Application", applicationId) };
  return { principal, application };
}

const notEditable = (request: Request, application: Application) =>
  conflict(request, "APPLICATION_NOT_EDITABLE", `Application is ${application.status}; only a DRAFT can be changed`);

const touch = (application: Application) => {
  application.updatedAt = now();
};

// ───────────────────────── validation ─────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value: unknown) => typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value));
const isCountry = (value: unknown) => typeof value === "string" && /^[A-Z]{2}$/.test(value);
const isPhone = (value: unknown) => typeof value === "string" && /^\+[1-9][0-9]{7,14}$/.test(value);
const isEmail = (value: unknown) => typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
const isString = (value: unknown) => typeof value === "string";
const isBoolean = (value: unknown) => typeof value === "boolean";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateApplicant(v: Validator, applicant: unknown, prefix = "applicant") {
  if (applicant === undefined) return v;
  if (!isObject(applicant)) return v.check(false, prefix, "must be an object");
  const a = applicant as Partial<Applicant>;
  const f = (name: string) => `${prefix}.${name}`;
  v.unknownFields(applicant, [
    "firstName", "lastName", "dateOfBirth", "placeOfBirth", "nationality", "idDocument", "phone", "email",
    "address", "occupation", "employerName", "monthlyIncomeRange", "sourceOfFunds", "isPoliticallyExposed", "usPerson",
  ])
    .optional(a.firstName, isNonEmptyString(a.firstName), f("firstName"), "must be a non-empty string")
    .optional(a.lastName, isNonEmptyString(a.lastName), f("lastName"), "must be a non-empty string")
    .optional(a.dateOfBirth, isDate(a.dateOfBirth), f("dateOfBirth"), "must be a date YYYY-MM-DD")
    .optional(a.placeOfBirth, isString(a.placeOfBirth), f("placeOfBirth"), "must be a string")
    .optional(a.nationality, isCountry(a.nationality), f("nationality"), "must be an ISO 3166-1 alpha-2 code")
    .optional(a.phone, isPhone(a.phone), f("phone"), "must be in E.164 format, e.g. +212612345678")
    .optional(a.email, isEmail(a.email), f("email"), "must be an email address")
    .optional(a.occupation, isString(a.occupation), f("occupation"), "must be a string")
    .optional(a.employerName, isString(a.employerName), f("employerName"), "must be a string")
    .optional(a.monthlyIncomeRange, isOneOf(INCOME_RANGES, a.monthlyIncomeRange), f("monthlyIncomeRange"), `must be one of ${INCOME_RANGES.join(", ")}`)
    .optional(a.sourceOfFunds, isOneOf(SOURCES, a.sourceOfFunds), f("sourceOfFunds"), `must be one of ${SOURCES.join(", ")}`)
    .optional(a.isPoliticallyExposed, isBoolean(a.isPoliticallyExposed), f("isPoliticallyExposed"), "must be a boolean")
    .optional(a.usPerson, isBoolean(a.usPerson), f("usPerson"), "must be a boolean");

  if (a.idDocument !== undefined) {
    if (!isObject(a.idDocument)) v.check(false, f("idDocument"), "must be an object");
    else {
      const d = a.idDocument;
      v.unknownFields(d, ["type", "number", "issueDate", "expiryDate"])
        .optional(d.type, isOneOf(ID_TYPES, d.type), f("idDocument.type"), `must be one of ${ID_TYPES.join(", ")}`)
        .optional(d.number, typeof d.number === "string" && d.number.length >= 4, f("idDocument.number"), "must have at least 4 characters")
        .optional(d.issueDate, isDate(d.issueDate), f("idDocument.issueDate"), "must be a date YYYY-MM-DD")
        .optional(d.expiryDate, isDate(d.expiryDate), f("idDocument.expiryDate"), "must be a date YYYY-MM-DD");
    }
  }
  if (a.address !== undefined) {
    if (!isObject(a.address)) v.check(false, f("address"), "must be an object");
    else {
      const ad = a.address;
      v.unknownFields(ad, ["line1", "line2", "city", "postalCode", "country"])
        .optional(ad.line1, isString(ad.line1), f("address.line1"), "must be a string")
        .optional(ad.line2, isString(ad.line2), f("address.line2"), "must be a string")
        .optional(ad.city, isString(ad.city), f("address.city"), "must be a string")
        .optional(ad.postalCode, isString(ad.postalCode), f("address.postalCode"), "must be a string")
        .optional(ad.country, isCountry(ad.country), f("address.country"), "must be an ISO 3166-1 alpha-2 code");
    }
  }
  return v;
}

function validateConsents(v: Validator, consents: unknown) {
  if (consents === undefined) return v;
  if (!isObject(consents)) return v.check(false, "consents", "must be an object");
  return v
    .unknownFields(consents, ["dataProcessing", "marketing"])
    .optional(consents.dataProcessing, isBoolean(consents.dataProcessing), "consents.dataProcessing", "must be a boolean")
    .optional(consents.marketing, isBoolean(consents.marketing), "consents.marketing", "must be a boolean");
}

/** Decoded size of a base64 string, or undefined when it is not valid base64. */
function base64Size(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  return (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}

// ───────────────────────── account opening ─────────────────────────

function openAccount(application: Application) {
  const n = state.seq + 1;
  const accountId = nextId("ACC");
  const at = now();
  state.balances.set(accountId, {
    accountId,
    available: { amount: 0, currency: "MAD" },
    ledger: { amount: 0, currency: "MAD" },
    asOf: at,
  });
  if (application.applicant.idDocument?.number) state.customerIdNumbers.add(application.applicant.idDocument.number);
  application.account = {
    accountId,
    rib: rib("007", "780", String(n)),
    productCode: application.productCode,
    currency: "MAD",
    openedAt: at,
  };
}

// ───────────────────────── handlers ─────────────────────────

export const applicationHandlers = [
  http.get(api("/account-applications"), async ({ request }) => {
    const rejected = await precheck(request, "CBS");
    if (rejected) return rejected;
    const user = userFromToken(request);
    const scenario = scenarioFor(request);
    if (!user || scenario === "unauthorized") return error(request, 401, "UNAUTHORIZED", "Missing, invalid or expired token");
    if (scenario === "refused" || !user.roles.some((r) => STAFF_READ.includes(r))) {
      return error(request, 403, "FORBIDDEN", `Requires one of: ${STAFF_READ.join(", ")}`);
    }

    const query = new URL(request.url).searchParams;
    const status = query.get("status");
    const channel = query.get("channel");
    const riskLevel = query.get("riskLevel");
    const v = new Validator()
      .optional(status ?? undefined, isOneOf(STATUSES, status), "status", "unknown status")
      .optional(channel ?? undefined, isOneOf(CHANNELS, channel), "channel", "unknown channel")
      .optional(riskLevel ?? undefined, isOneOf(RISK_LEVELS, riskLevel), "riskLevel", "unknown risk level");
    if (!v.valid) return invalid(request, v.details);

    const items = [...state.applications.values()]
      .filter((a) => (!status || a.status === status) && (!channel || a.channel === channel))
      .filter((a) => !riskLevel || a.kyc?.riskLevel === riskLevel)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const p = paginate(request, items);
    if (p.response) return p.response;
    return json<Schemas["AccountApplicationPage"]>(request, p.page);
  }),

  http.post(api("/account-applications"), async ({ request }) => {
    const rejected = await precheck(request, "CBS");
    if (rejected) return rejected;

    // Optional authentication: none for a prospect on a kiosk, an agent token at the branch.
    let user: MockUser | undefined;
    if (request.headers.get("Authorization")) {
      user = userFromToken(request);
      if (!user || scenarioFor(request) === "unauthorized") {
        return error(request, 401, "UNAUTHORIZED", "Missing, invalid or expired token");
      }
      if (!user.roles.some((r) => STAFF_WRITE.includes(r))) {
        return error(request, 403, "FORBIDDEN", `Requires one of: ${STAFF_WRITE.join(", ")}`);
      }
    }

    const body = await readBody<Schemas["AccountApplicationCreate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["channel", "kioskId", "productCode", "applicant", "consents"])
      .check(isOneOf(CHANNELS, body.channel), "channel", `must be one of ${CHANNELS.join(", ")}`)
      .check(isOneOf(PRODUCTS, body.productCode), "productCode", `must be one of ${PRODUCTS.join(", ")}`);
    if (body.channel === "KIOSK") {
      v.check(typeof body.kioskId === "string" && state.kiosks.has(body.kioskId), "kioskId", "must be a known kiosk for the KIOSK channel");
    }
    validateConsents(validateApplicant(v, body.applicant), body.consents);
    if (!v.valid) return invalid(request, v.details);
    const valid = body as Schemas["AccountApplicationCreate"];

    if (valid.channel === "BRANCH" && !user) {
      return error(request, 401, "UNAUTHORIZED", "The BRANCH channel requires an AGENT or ADMIN token");
    }
    if (valid.channel === "KIOSK") {
      const service = serviceAvailabilityOn(state, valid.kioskId!, "ACCOUNT_OPENING");
      if (!service || service.availability === "UNAVAILABLE") {
        return error(request, 422, "SERVICE_UNAVAILABLE_ON_KIOSK", `ACCOUNT_OPENING is not available on kiosk ${valid.kioskId}`, {
          retryable: false,
        });
      }
    }

    const at = now();
    const application: Application = {
      applicationId: nextId("APP"),
      status: "DRAFT",
      channel: valid.channel,
      ...(valid.channel === "KIOSK" && { kioskId: valid.kioskId }),
      productCode: valid.productCode,
      applicant: valid.applicant ?? {},
      ...(valid.consents && { consents: valid.consents }),
      phoneVerified: false,
      documents: [],
      ...(user && { createdBy: user.id }),
      createdAt: at,
      updatedAt: at,
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
    };
    const applicationToken = `app-token-${application.applicationId}-${crypto.randomUUID().slice(0, 8)}`;
    state.applications.set(application.applicationId, application);
    state.applicationTokens.set(applicationToken, application.applicationId);
    return json<Schemas["AccountApplicationCreated"]>(request, { ...application, applicationToken }, 201);
  }),

  http.get<AppParams>(api("/account-applications/:applicationId"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, STAFF_READ);
    if (a.response) return a.response;
    return json<Application>(request, a.application);
  }),

  http.patch<AppParams>(api("/account-applications/:applicationId"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, STAFF_WRITE);
    if (a.response) return a.response;
    const application = a.application;

    const body = await readBody<Schemas["AccountApplicationUpdate"]>(request);
    const v = new Validator()
      .unknownFields(body, ["productCode", "applicant", "consents"])
      .check(Object.keys(body).length > 0, "body", "at least one field is required")
      .optional(body.productCode, isOneOf(PRODUCTS, body.productCode), "productCode", `must be one of ${PRODUCTS.join(", ")}`);
    validateConsents(validateApplicant(v, body.applicant), body.consents);
    if (!v.valid) return invalid(request, v.details);
    if (application.status !== "DRAFT") return notEditable(request, application);

    if (body.productCode) application.productCode = body.productCode;
    if (body.applicant) {
      const phoneChanged = body.applicant.phone !== undefined && body.applicant.phone !== application.applicant.phone;
      application.applicant = { ...application.applicant, ...body.applicant };
      if (phoneChanged) {
        application.phoneVerified = false;
        state.otps.delete(application.applicationId);
      }
    }
    if (body.consents) application.consents = { ...application.consents, ...body.consents };
    touch(application);
    return json<Application>(request, application);
  }),

  http.get<AppParams>(api("/account-applications/:applicationId/documents"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, STAFF_READ);
    if (a.response) return a.response;
    return json<{ items: Schemas["ApplicationDocument"][] }>(request, { items: a.application.documents });
  }),

  http.post<AppParams>(api("/account-applications/:applicationId/documents"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, STAFF_WRITE);
    if (a.response) return a.response;
    const application = a.application;

    const body = await readBody<Schemas["ApplicationDocumentUpload"]>(request);
    const size = base64Size(body.contentBase64);
    const v = new Validator()
      .unknownFields(body, ["type", "fileName", "mimeType", "contentBase64"])
      .check(isOneOf(DOCUMENT_TYPES, body.type), "type", `must be one of ${DOCUMENT_TYPES.join(", ")}`)
      .check(isNonEmptyString(body.fileName), "fileName", "must be a non-empty string")
      .check(isOneOf(MIME_TYPES, body.mimeType), "mimeType", `must be one of ${MIME_TYPES.join(", ")}`)
      .check(size !== undefined, "contentBase64", "must be valid base64");
    if (size !== undefined) v.check(size <= MAX_DOCUMENT_BYTES, "contentBase64", "file is larger than 5 MB");
    if (!v.valid) return invalid(request, v.details, "INVALID_DOCUMENT");
    if (application.status !== "DRAFT") return notEditable(request, application);

    const valid = body as Schemas["ApplicationDocumentUpload"];
    const document: Schemas["ApplicationDocument"] = {
      documentId: nextId("DOC"),
      type: valid.type,
      fileName: valid.fileName,
      mimeType: valid.mimeType,
      sizeBytes: size!,
      uploadedAt: now(),
    };
    // One document per type: a new upload replaces the previous one.
    application.documents = [...application.documents.filter((d) => d.type !== valid.type), document];
    touch(application);
    return json<Schemas["ApplicationDocument"]>(request, document, 201);
  }),

  http.delete<AppParams & { documentId: string }>(
    api("/account-applications/:applicationId/documents/:documentId"),
    async ({ request, params }) => {
      const a = await access(request, params.applicationId, STAFF_WRITE);
      if (a.response) return a.response;
      const application = a.application;

      if (!application.documents.some((d) => d.documentId === params.documentId)) {
        return notFound(request, "Document", params.documentId);
      }
      if (application.status !== "DRAFT") return notEditable(request, application);
      application.documents = application.documents.filter((d) => d.documentId !== params.documentId);
      touch(application);
      return noContent(request);
    },
  ),

  http.post<AppParams>(api("/account-applications/:applicationId/phone-verification"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, STAFF_WRITE);
    if (a.response) return a.response;
    const application = a.application;

    if (application.status !== "DRAFT") return notEditable(request, application);
    const phone = application.applicant.phone;
    if (!phone) return error(request, 422, "PHONE_MISSING", "Set applicant.phone before verifying it", { retryable: false });

    const expiresAt = Date.now() + OTP_TTL_MS;
    state.otps.set(application.applicationId, { code: MOCK_OTP_CODE, expiresAt, attemptsLeft: OTP_ATTEMPTS });
    return json<Schemas["PhoneVerificationStarted"]>(
      request,
      { maskedPhone: maskPhone(phone), expiresAt: new Date(expiresAt).toISOString(), attemptsAllowed: OTP_ATTEMPTS },
      202,
    );
  }),

  http.post<AppParams>(api("/account-applications/:applicationId/phone-verification/confirm"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, STAFF_WRITE);
    if (a.response) return a.response;
    const application = a.application;

    const body = await readBody<Schemas["PhoneVerificationConfirm"]>(request);
    const v = new Validator()
      .unknownFields(body, ["code"])
      .check(typeof body.code === "string" && /^[0-9]{6}$/.test(body.code), "code", "must be 6 digits");
    if (!v.valid) return invalid(request, v.details);
    if (application.status !== "DRAFT") return notEditable(request, application);

    const otp = state.otps.get(application.applicationId);
    const refuse = (code: string, message: string) => error(request, 422, code, message, { retryable: false });
    if (!otp) return refuse("OTP_NOT_REQUESTED", "Request a code first");
    if (Date.now() > otp.expiresAt) {
      state.otps.delete(application.applicationId);
      return refuse("OTP_EXPIRED", "The code has expired; request a new one");
    }
    if (body.code !== otp.code) {
      otp.attemptsLeft--;
      if (otp.attemptsLeft <= 0) {
        state.otps.delete(application.applicationId);
        return refuse("OTP_ATTEMPTS_EXCEEDED", "Too many wrong codes; request a new one");
      }
      return refuse("OTP_INVALID", `Wrong code, ${otp.attemptsLeft} attempt(s) left`);
    }

    state.otps.delete(application.applicationId);
    application.phoneVerified = true;
    touch(application);
    return json<Application>(request, application);
  }),

  http.post<AppParams>(api("/account-applications/:applicationId/submit"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, STAFF_WRITE);
    if (a.response) return a.response;
    const application = a.application;

    if (application.status !== "DRAFT") return notEditable(request, application);
    const missing = missingForSubmit(application);
    if (missing.length > 0) {
      return error(request, 422, "APPLICATION_INCOMPLETE", "The application is incomplete", { details: missing, retryable: false });
    }

    const kyc = evaluateKyc(application, { today: new Date(), existingCustomerIds: state.customerIdNumbers });
    application.kyc = kyc;
    application.submittedAt = kyc.evaluatedAt;
    application.status =
      kyc.outcome === "AUTO_REJECTED" ? "REJECTED" : kyc.outcome === "MANUAL_REVIEW" ? "UNDER_REVIEW" : "APPROVED";
    if (application.status === "APPROVED") openAccount(application);
    state.otps.delete(application.applicationId);
    touch(application);
    return json<Application>(request, application);
  }),

  http.post<AppParams>(api("/account-applications/:applicationId/decision"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, COMPLIANCE);
    if (a.response) return a.response;
    if (a.principal.kind !== "staff") {
      return error(request, 403, "FORBIDDEN", "Only a COMPLIANCE officer can decide");
    }
    const application = a.application;

    const body = await readBody<Schemas["ApplicationDecisionRequest"]>(request);
    const v = new Validator()
      .unknownFields(body, ["decision", "reasonCode", "comment"])
      .check(isOneOf(["APPROVE", "REJECT"] as const, body.decision), "decision", "must be APPROVE or REJECT")
      .check(isNonEmptyString(body.comment), "comment", "is required")
      .optional(body.reasonCode, isNonEmptyString(body.reasonCode), "reasonCode", "must be a non-empty string");
    if (body.decision === "REJECT") v.check(isNonEmptyString(body.reasonCode), "reasonCode", "is required to reject");
    if (!v.valid) return invalid(request, v.details);
    if (application.status !== "UNDER_REVIEW") {
      return conflict(request, "APPLICATION_NOT_UNDER_REVIEW", `Application is ${application.status}`);
    }

    const valid = body as Schemas["ApplicationDecisionRequest"];
    application.review = {
      decision: valid.decision,
      ...(valid.reasonCode && { reasonCode: valid.reasonCode }),
      comment: valid.comment,
      decidedBy: a.principal.user.id,
      decidedAt: now(),
    };
    application.status = valid.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (application.status === "APPROVED") openAccount(application);
    touch(application);
    return json<Application>(request, application);
  }),

  http.post<AppParams>(api("/account-applications/:applicationId/cancel"), async ({ request, params }) => {
    const a = await access(request, params.applicationId, STAFF_WRITE);
    if (a.response) return a.response;
    const application = a.application;

    const body = await readBody<{ reason?: string }>(request);
    const v = new Validator()
      .unknownFields(body, ["reason"])
      .optional(body.reason, isString(body.reason), "reason", "must be a string");
    if (!v.valid) return invalid(request, v.details);
    if (application.status !== "DRAFT" && application.status !== "UNDER_REVIEW") {
      return conflict(request, "APPLICATION_NOT_CANCELLABLE", `Application is ${application.status}`);
    }

    application.status = "CANCELLED";
    application.cancellation = { ...(body.reason && { reason: body.reason }), cancelledAt: now() };
    state.otps.delete(application.applicationId);
    touch(application);
    return json<Application>(request, application);
  }),
];
