import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..");

const state = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const value = state.jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...state.jar.entries()].map(([name, value]) => ({ name, value }));
    },
    set(name: string, value: string) {
      state.jar.set(name, value);
    },
  }),
}));

import { prisma } from "@/lib/db";
import { getAdminSession } from "@/lib/auth/session";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import { GET as getSettings, PUT as putSettings } from "@/app/api/admin/settings/route";

async function signInAsAdmin() {
  const session = await getAdminSession();
  session.isAdmin = true;
  await session.save();
}
function authedReq(method: string, body?: unknown) {
  return new Request("http://localhost/api/admin/settings", {
    method,
    headers: { "content-type": "application/json", [CSRF_HEADER]: "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(async () => {
  state.jar.clear();
  await prisma.adminSetting.deleteMany({ where: { key: { in: ["ads", "ai"] } } });
});

describe("63-67: no secret can ever be written to or read from the admin settings API", () => {
  // Underscores deliberately break up base62 runs so these fixtures
  // never match a real secret-scanner's key-shaped pattern.
  const secretAttempts: Record<string, string> = {
    STRIPE_SECRET_KEY: "sk_live_INJECTED_TEST_FIXTURE_0000000000",
    STRIPE_WEBHOOK_SECRET: "whsec_INJECTED_TEST_FIXTURE_000000000",
    SESSION_SECRET: "injected-session-secret-value",
    ADMIN_PASSWORD_HASH: "$2a$12$injected_hash_value_0000000000000",
    futureProviderApiKey: "sk-future-provider-injected-secret",
  };

  for (const [key, value] of Object.entries(secretAttempts)) {
    it(`${key} smuggled into the "ai" object is silently stripped, never stored`, async () => {
      await signInAsAdmin();
      const res = await putSettings(
        authedReq("PUT", {
          ai: { provider: "ollama", baseUrl: "http://x", model: "y", [key]: value },
        }),
      );
      expect(res.status).toBe(200);
      const row = await prisma.adminSetting.findUnique({ where: { key: "ai" } });
      expect(row).not.toBeNull();
      expect(row!.value).not.toContain(value);
    });

    it(`${key} smuggled into the "ads" object is silently stripped, never stored`, async () => {
      await signInAsAdmin();
      const res = await putSettings(authedReq("PUT", { ads: { enabled: true, [key]: value } }));
      expect(res.status).toBe(200);
      const row = await prisma.adminSetting.findUnique({ where: { key: "ads" } });
      expect(row).not.toBeNull();
      expect(row!.value).not.toContain(value);
    });
  }

  it("the GET response never contains any real configured secret value", async () => {
    process.env.STRIPE_MODE = "test";
    process.env.STRIPE_SECRET_KEY = "sk_test_REAL_VALUE_TEST_FIXTURE_00000";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_REAL_VALUE_TEST_FIXTURE_0000";
    process.env.SESSION_SECRET = "real-session-secret-value";
    process.env.ADMIN_PASSWORD_HASH = "$2a$12$real_hash_value_00000000000000000";
    await signInAsAdmin();
    const res = await getSettings(new Request("http://localhost/api/admin/settings"));
    const body = await res.text();
    expect(body).not.toContain("sk_test_REAL_VALUE");
    expect(body).not.toContain("whsec_REAL_VALUE");
    expect(body).not.toContain("real-session-secret-value");
    expect(body).not.toContain("real_hash_value");
    delete process.env.STRIPE_MODE;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.SESSION_SECRET;
    delete process.env.ADMIN_PASSWORD_HASH;
  });

  it("the ai settings schema itself has no field for any of these secrets — structurally impossible, not just rejected", () => {
    const source = readFileSync(join(ROOT, "src/lib/validation/settings.ts"), "utf8");
    for (const key of Object.keys(secretAttempts)) {
      expect(source).not.toContain(key);
    }
  });
});

describe("68/69/70: adversarial content always renders as text, never markup", () => {
  it("68: SourcesManager renders the source name via JSX interpolation, never dangerouslySetInnerHTML", () => {
    const source = readFileSync(
      join(ROOT, "src/app/admin/(protected)/sources/SourcesManager.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).toMatch(/\{s\.name\}/);
  });

  it("69: SourceProfileManager renders assessment fields via JSX, never dangerouslySetInnerHTML", () => {
    const source = readFileSync(
      join(ROOT, "src/app/admin/(protected)/sources/[id]/SourceProfileManager.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("70: the operations page's audit log tail renders row.summary via JSX, never dangerouslySetInnerHTML", () => {
    const source = readFileSync(
      join(ROOT, "src/app/admin/(protected)/operations/page.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).toMatch(/\{row\.summary\}/);
  });
});

describe("71: no open redirect was introduced anywhere in this phase's new code", () => {
  it("none of the new admin modules ever call redirect() with a value derived from request input", () => {
    const files = [
      "src/lib/adminAudit.ts",
      "src/lib/billing/adminStatus.ts",
      "src/lib/ingest/adminLiveness.ts",
      "src/lib/adminLoginRateLimit.ts",
      "src/app/admin/(protected)/operations/page.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).not.toMatch(/\bredirect\(/);
    }
  });
});

describe("72: no new SSRF path was introduced anywhere in this phase's new code", () => {
  it("none of the new admin modules ever call fetch()", () => {
    const files = [
      "src/lib/adminAudit.ts",
      "src/lib/billing/adminStatus.ts",
      "src/lib/ingest/adminLiveness.ts",
      "src/lib/adminLoginRateLimit.ts",
      "src/app/admin/(protected)/operations/page.tsx",
      "src/app/admin/(protected)/page.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).not.toMatch(/\bfetch\(/);
    }
  });
});

describe("adversarial: concurrent settings mutations", () => {
  it("two concurrent PUT /api/admin/settings calls never crash or corrupt the stored value — last write wins, both logged", async () => {
    await signInAsAdmin();
    const [resA, resB] = await Promise.all([
      putSettings(
        authedReq("PUT", { ai: { provider: "ollama", baseUrl: "http://a", model: "model-a" } }),
      ),
      putSettings(
        authedReq("PUT", { ai: { provider: "ollama", baseUrl: "http://b", model: "model-b" } }),
      ),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const row = await prisma.adminSetting.findUniqueOrThrow({ where: { key: "ai" } });
    const stored = JSON.parse(row.value);
    expect(["model-a", "model-b"]).toContain(stored.model); // one of the two — never a corrupted/merged mixture
    const logCount = await prisma.adminAuditLog.count({ where: { action: "settings.update.ai" } });
    expect(logCount).toBeGreaterThanOrEqual(2); // both concurrent writes are individually logged
  });
});

describe("adversarial: audit-log flooding by an authenticated admin never breaks the read side", () => {
  it("getRecentAdminActions stays fast and correctly bounded regardless of how many rows exist", async () => {
    await signInAsAdmin();
    const { logAdminAction, getRecentAdminActions } = await import("@/lib/adminAudit");
    for (let i = 0; i < 120; i++) {
      await logAdminAction(prisma, { action: "source.create", summary: `flood-${i}` });
    }
    const rows = await getRecentAdminActions(prisma, 50);
    expect(rows).toHaveLength(50);
    expect(rows[0]!.summary).toBe("flood-119"); // newest first, unaffected by total row count
    await prisma.adminAuditLog.deleteMany({ where: { summary: { startsWith: "flood-" } } });
  });
});
