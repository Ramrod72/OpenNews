import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { seedPlans } from "../prisma/seedPlans";
import { loginUser, registerUser } from "@/lib/auth/consumer/service";
import { hashToken } from "@/lib/auth/consumer/tokens";
import { resolveSessionUser, revokeSession } from "@/lib/auth/consumer/session";

beforeAll(async () => {
  await seedPlans(prisma);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: "@consumerauth.test" } } });
  await prisma.$disconnect();
});

describe("registerUser", () => {
  it("creates a User and enrolls them in the Free plan automatically", async () => {
    const result = await registerUser({
      email: "alice@consumerauth.test",
      password: "correct-horse-1",
    });
    if ("error" in result) throw new Error(`expected success, got: ${result.error}`);

    const user = await prisma.user.findUnique({ where: { email: "alice@consumerauth.test" } });
    expect(user).not.toBeNull();
    expect(user!.passwordHash).not.toBe("correct-horse-1"); // never stored in plaintext

    const subscription = await prisma.subscription.findFirst({
      where: { userId: user!.id },
      include: { plan: true },
    });
    expect(subscription?.plan.slug).toBe("free");
    expect(subscription?.status).toBe("active");
  });

  it("normalizes email to lowercase", async () => {
    await registerUser({ email: "Case-Test@ConsumerAuth.test", password: "correct-horse-1" });
    const user = await prisma.user.findUnique({ where: { email: "case-test@consumerauth.test" } });
    expect(user).not.toBeNull();
  });

  it("rejects a duplicate email without creating a second row", async () => {
    const before = await prisma.user.count({ where: { email: "alice@consumerauth.test" } });
    const result = await registerUser({
      email: "alice@consumerauth.test",
      password: "another-password",
    });
    expect("error" in result).toBe(true);
    const after = await prisma.user.count({ where: { email: "alice@consumerauth.test" } });
    expect(after).toBe(before);
  });
});

describe("loginUser", () => {
  it("succeeds with correct credentials and issues a session", async () => {
    const result = await loginUser({
      email: "alice@consumerauth.test",
      password: "correct-horse-1",
    });
    if ("error" in result) throw new Error(`expected success, got: ${result.error}`);
    expect(result.token).toBeTruthy();

    const stored = await prisma.authSession.findUnique({
      where: { tokenHash: hashToken(result.token) },
    });
    expect(stored).not.toBeNull();
    expect(stored!.tokenHash).not.toBe(result.token); // only the hash is stored
  });

  it("fails with the wrong password", async () => {
    const result = await loginUser({ email: "alice@consumerauth.test", password: "totally-wrong" });
    expect("error" in result).toBe(true);
  });

  it("fails for a nonexistent email with the SAME generic error as a wrong password", async () => {
    const wrongPassword = await loginUser({
      email: "alice@consumerauth.test",
      password: "totally-wrong",
    });
    const noSuchUser = await loginUser({
      email: "nobody@consumerauth.test",
      password: "totally-wrong",
    });
    expect("error" in wrongPassword && "error" in noSuchUser).toBe(true);
    if ("error" in wrongPassword && "error" in noSuchUser) {
      expect(noSuchUser.error).toBe(wrongPassword.error);
    }
  });
});

describe("session persistence + logout", () => {
  it("resolves a valid session token to its user, and rejects logout/garbage tokens", async () => {
    const login = await loginUser({
      email: "alice@consumerauth.test",
      password: "correct-horse-1",
    });
    if ("error" in login) throw new Error("login failed");

    const hash = hashToken(login.token);
    const resolved = await resolveSessionUser(hash);
    expect(resolved?.email).toBe("alice@consumerauth.test");

    // Logout revokes it — the same token must never work again.
    await revokeSession(hash);
    expect(await resolveSessionUser(hash)).toBeNull();

    // No token, and an unknown token, both resolve to "not signed in".
    expect(await resolveSessionUser(undefined)).toBeNull();
    expect(await resolveSessionUser(hashToken("not-a-real-token"))).toBeNull();
  });

  it("does not resolve an expired session", async () => {
    const login = await loginUser({
      email: "alice@consumerauth.test",
      password: "correct-horse-1",
    });
    if ("error" in login) throw new Error("login failed");
    const hash = hashToken(login.token);

    await prisma.authSession.update({
      where: { tokenHash: hash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await resolveSessionUser(hash)).toBeNull();
  });
});
