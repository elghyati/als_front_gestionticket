/** Account opening with KYC: kiosk and branch flows, KYC outcomes, compliance decision. */
import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client";
import { ageOn, isValidRib, maskPhone, rib } from "../src/mocks/kyc/rules";
import { admin, agent, BASE_URL, clientFor, customer, headers, userWithRole } from "./helpers";

const compliance = userWithRole("COMPLIANCE");
const asAgent = clientFor(agent);
const asCompliance = clientFor(compliance);
const withToken = (token: string) => createApiClient({ baseUrl: BASE_URL, getToken: () => token });
const app = (applicationId: string) => ({ header: headers(), path: { applicationId } });

const PNG = "iVBORw0KGgo=";
const upload = (client: ReturnType<typeof withToken>, applicationId: string, type: "ID_FRONT" | "ID_BACK" | "SELFIE" | "PROOF_OF_ADDRESS", fileName = `${type}.png`) =>
  client.POST("/account-applications/{applicationId}/documents", {
    params: app(applicationId),
    body: { type, fileName, mimeType: "image/png", contentBase64: PNG },
  });

/** Verifies the phone of APP-1001 (code 123456 pending in the demo data). */
const verifyPhone = (applicationId = "APP-1001", client = asAgent) =>
  client.POST("/account-applications/{applicationId}/phone-verification/confirm", {
    params: app(applicationId),
    body: { code: "123456" },
  });

const submit = (applicationId = "APP-1001", client = asAgent) =>
  client.POST("/account-applications/{applicationId}/submit", { params: app(applicationId) });

describe("kiosk self-service flow", () => {
  it("opens an account end to end with the application token only", async () => {
    const created = await createApiClient({ baseUrl: BASE_URL }).POST("/account-applications", {
      params: { header: headers() },
      body: { channel: "KIOSK", kioskId: "KIOSK-01", productCode: "CURRENT_ACCOUNT", consents: { dataProcessing: true } },
    });
    expect(created.response.status).toBe(201);
    const { applicationId, applicationToken, status } = created.data!;
    expect(status).toBe("DRAFT");
    const prospect = withToken(applicationToken);

    const patched = await prospect.PATCH("/account-applications/{applicationId}", {
      params: app(applicationId),
      body: {
        applicant: {
          firstName: "Nadia",
          lastName: "Idrissi",
          dateOfBirth: "1995-02-20",
          nationality: "MA",
          idDocument: { type: "CIN", number: "JK445566", expiryDate: "2032-05-01" },
          phone: "+212698765432",
          address: { line1: "3 rue Al Massira", city: "Agadir", country: "MA" },
          occupation: "Enseignante",
          monthlyIncomeRange: "FROM_3000_TO_10000",
          sourceOfFunds: "SALARY",
          isPoliticallyExposed: false,
          usPerson: false,
        },
      },
    });
    expect(patched.response.status).toBe(200);

    for (const type of ["ID_FRONT", "ID_BACK", "SELFIE", "PROOF_OF_ADDRESS"] as const) {
      expect((await upload(prospect, applicationId, type)).response.status).toBe(201);
    }

    const early = await submit(applicationId, prospect);
    expect(early.response.status).toBe(422);
    expect(early.error?.code).toBe("APPLICATION_INCOMPLETE");
    expect(early.error?.details).toEqual([{ field: "phoneVerified", issue: "phone must be verified" }]);

    const otp = await prospect.POST("/account-applications/{applicationId}/phone-verification", { params: app(applicationId) });
    expect(otp.response.status).toBe(202);
    expect(otp.data?.maskedPhone).toBe("+2126******32");
    expect((await verifyPhone(applicationId, prospect)).data?.phoneVerified).toBe(true);

    const { data } = await submit(applicationId, prospect);
    expect(data?.status).toBe("APPROVED");
    expect(data?.kyc).toMatchObject({ outcome: "AUTO_APPROVED", riskLevel: "LOW" });
    expect(data?.kyc?.checks.every((c) => c.result === "PASS")).toBe(true);
    expect(isValidRib(data!.account!.rib)).toBe(true);

    const balance = await asAgent.GET("/accounts/{accountId}/balance", {
      params: { header: headers(), path: { accountId: data!.account!.accountId } },
    });
    expect(balance.data?.available.amount).toBe(0);
  });

  it("is refused on a kiosk without camera nor ID scanner", async () => {
    const { error, response } = await createApiClient({ baseUrl: BASE_URL }).POST("/account-applications", {
      params: { header: headers() },
      body: { channel: "KIOSK", kioskId: "KIOSK-02", productCode: "BASIC_ACCOUNT" },
    });
    expect(response.status).toBe(422);
    expect(error?.code).toBe("SERVICE_UNAVAILABLE_ON_KIOSK");
  });

  it("an application token only opens its own application", async () => {
    const other = await withToken("app-token-APP-1004").GET("/account-applications/{applicationId}", { params: app("APP-1001") });
    expect(other.response.status).toBe(403);
    const own = await withToken("app-token-APP-1001").GET("/account-applications/{applicationId}", { params: app("APP-1001") });
    expect(own.response.status).toBe(200);
  });

  it("rejects a customer token and a missing token", async () => {
    expect((await clientFor(customer).GET("/account-applications/{applicationId}", { params: app("APP-1001") })).response.status).toBe(403);
    expect((await clientFor().GET("/account-applications/{applicationId}", { params: app("APP-1001") })).response.status).toBe(401);
  });
});

describe("branch flow", () => {
  it("requires an agent token, and records who created the application", async () => {
    const anonymous = await createApiClient({ baseUrl: BASE_URL }).POST("/account-applications", {
      params: { header: headers() },
      body: { channel: "BRANCH", productCode: "SAVINGS_ACCOUNT" },
    });
    expect(anonymous.response.status).toBe(401);

    const { data } = await asAgent.POST("/account-applications", {
      params: { header: headers() },
      body: { channel: "BRANCH", productCode: "SAVINGS_ACCOUNT" },
    });
    expect(data).toMatchObject({ channel: "BRANCH", createdBy: agent.id, status: "DRAFT" });
  });

  it("lists the compliance work queue", async () => {
    const { data } = await asCompliance.GET("/account-applications", { params: { header: headers(), query: { status: "UNDER_REVIEW" } } });
    expect(data?.items.map((a) => a.applicationId)).toEqual(["APP-1002"]);
    const high = await asCompliance.GET("/account-applications", { params: { header: headers(), query: { riskLevel: "HIGH" } } });
    expect(high.data?.items.map((a) => a.applicationId)).toEqual(["APP-1002"]);
  });
});

describe("KYC outcomes", () => {
  type Overrides = Record<string, unknown>;

  async function submitWith(applicant: Overrides, selfieName?: string) {
    await asAgent.PATCH("/account-applications/{applicationId}", { params: app("APP-1001"), body: { applicant } });
    if (selfieName) await upload(asAgent, "APP-1001", "SELFIE", selfieName);
    await verifyPhone();
    return (await submit()).data!;
  }

  const failed = (data: Awaited<ReturnType<typeof submitWith>>) =>
    data.kyc!.checks.filter((c) => c.result !== "PASS").map((c) => `${c.check}:${c.result}:${c.reasonCode}`);

  it.each<[string, Overrides, string | undefined, string, string, string[]]>([
    ["clean profile", {}, undefined, "APPROVED", "LOW", []],
    ["foreign national", { nationality: "FR" }, undefined, "APPROVED", "MEDIUM", []],
    ["sanctions hit", { lastName: "Sanction" }, undefined, "REJECTED", "LOW", ["SANCTIONS_SCREENING:FAIL:SANCTIONS_HIT"]],
    ["declared PEP", { isPoliticallyExposed: true }, undefined, "UNDER_REVIEW", "HIGH", ["PEP_SCREENING:REVIEW:PEP_DECLARED"]],
    ["PEP list hit", { lastName: "Pep" }, undefined, "UNDER_REVIEW", "HIGH", ["PEP_SCREENING:REVIEW:PEP_LIST_HIT"]],
    ["face mismatch", {}, "selfie-mismatch.png", "REJECTED", "LOW", ["FACE_MATCH:FAIL:FACE_MISMATCH"]],
    ["existing customer", { idDocument: { type: "PASSPORT", number: "BK123456", expiryDate: "2030-01-01" } }, undefined, "UNDER_REVIEW", "LOW", ["DUPLICATE_CUSTOMER:REVIEW:EXISTING_CUSTOMER"]],
    ["US person", { usPerson: true }, undefined, "UNDER_REVIEW", "MEDIUM", ["FATCA:REVIEW:US_PERSON"]],
    ["expired ID", { idDocument: { type: "CIN", number: "BE987654", expiryDate: "2020-01-01" } }, undefined, "REJECTED", "LOW", ["ID_DOCUMENT_VALIDITY:FAIL:ID_EXPIRED"]],
    ["minor", { dateOfBirth: "2015-06-01" }, undefined, "REJECTED", "LOW", ["AGE:FAIL:UNDERAGE"]],
  ])("%s → %s", async (_, applicant, selfie, status, riskLevel, issues) => {
    const data = await submitWith(applicant, selfie);
    expect(data.status).toBe(status);
    expect(data.kyc?.riskLevel).toBe(riskLevel);
    expect(failed(data)).toEqual(issues);
    expect(Boolean(data.account)).toBe(status === "APPROVED");
  });

  it("a submitted application can no longer be changed", async () => {
    await verifyPhone();
    await submit();
    const { error, response } = await asAgent.PATCH("/account-applications/{applicationId}", {
      params: app("APP-1001"),
      body: { productCode: "SAVINGS_ACCOUNT" },
    });
    expect(response.status).toBe(409);
    expect(error?.code).toBe("APPLICATION_NOT_EDITABLE");
  });

  it("lists every missing item before submit", async () => {
    const { error } = await submit("APP-1003");
    const fields = error!.details!.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["applicant.dateOfBirth", "documents.SELFIE", "phoneVerified", "consents.dataProcessing"]));
  });
});

describe("phone verification", () => {
  it("allows 3 attempts, then requires a new code", async () => {
    const wrong = () =>
      asAgent.POST("/account-applications/{applicationId}/phone-verification/confirm", { params: app("APP-1001"), body: { code: "000000" } });
    expect((await wrong()).error?.code).toBe("OTP_INVALID");
    expect((await wrong()).error?.code).toBe("OTP_INVALID");
    expect((await wrong()).error?.code).toBe("OTP_ATTEMPTS_EXCEEDED");
    expect((await verifyPhone()).error?.code).toBe("OTP_NOT_REQUESTED");
  });

  it("changing the phone number cancels the verification", async () => {
    await verifyPhone();
    const { data } = await asAgent.PATCH("/account-applications/{applicationId}", {
      params: app("APP-1001"),
      body: { applicant: { phone: "+212600112233" } },
    });
    expect(data?.phoneVerified).toBe(false);
  });
});

describe("documents", () => {
  it("replaces a document of the same type and rejects invalid content", async () => {
    const before = (await asAgent.GET("/account-applications/{applicationId}/documents", { params: app("APP-1001") })).data!.items;
    await upload(asAgent, "APP-1001", "SELFIE", "new-selfie.png");
    const after = (await asAgent.GET("/account-applications/{applicationId}/documents", { params: app("APP-1001") })).data!.items;
    expect(after).toHaveLength(before.length);
    expect(after.find((d) => d.type === "SELFIE")?.fileName).toBe("new-selfie.png");

    const bad = await asAgent.POST("/account-applications/{applicationId}/documents", {
      params: app("APP-1001"),
      body: { type: "SELFIE", fileName: "x.gif", mimeType: "image/gif" as never, contentBase64: "not base64!" },
    });
    expect(bad.error?.details?.map((d) => d.field)).toEqual(["mimeType", "contentBase64"]);
  });
});

describe("compliance decision", () => {
  it("only COMPLIANCE decides, a rejection needs a reason, and a decision is final", async () => {
    const decide = (client: typeof asAgent, body: { decision: "APPROVE" | "REJECT"; comment: string; reasonCode?: string }) =>
      client.POST("/account-applications/{applicationId}/decision", { params: app("APP-1002"), body });

    expect((await decide(asAgent, { decision: "APPROVE", comment: "ok" })).response.status).toBe(403);
    expect((await decide(clientFor(admin), { decision: "APPROVE", comment: "ok" })).response.status).toBe(403);
    expect((await decide(asCompliance, { decision: "REJECT", comment: "non" })).error?.details?.[0]?.field).toBe("reasonCode");

    const { data } = await decide(asCompliance, { decision: "APPROVE", comment: "Origine des fonds justifiée" });
    expect(data).toMatchObject({ status: "APPROVED", review: { decision: "APPROVE", decidedBy: compliance.id } });
    expect(isValidRib(data!.account!.rib)).toBe(true);

    expect((await decide(asCompliance, { decision: "REJECT", comment: "trop tard", reasonCode: "X" })).error?.code).toBe(
      "APPLICATION_NOT_UNDER_REVIEW",
    );
  });

  it("an application under review can be cancelled, a rejected one cannot", async () => {
    const cancel = (id: string) => asAgent.POST("/account-applications/{applicationId}/cancel", { params: app(id), body: {} });
    expect((await cancel("APP-1002")).data?.status).toBe("CANCELLED");
    expect((await cancel("APP-1004")).error?.code).toBe("APPLICATION_NOT_CANCELLABLE");
  });
});

describe("KYC helpers", () => {
  it("computes a valid Moroccan RIB key", () => {
    const value = rib("007", "780", "5001");
    expect(value).toMatch(/^\d{24}$/);
    expect(isValidRib(value)).toBe(true);
    expect(isValidRib(value.slice(0, 22) + "00")).toBe(false);
  });

  it("computes the age on a date and masks a phone number", () => {
    expect(ageOn("2008-10-12", new Date("2026-10-11T00:00:00Z"))).toBe(17);
    expect(ageOn("2008-10-11", new Date("2026-10-11T00:00:00Z"))).toBe(18);
    expect(maskPhone("+212612345678")).toBe("+2126******78");
  });
});
