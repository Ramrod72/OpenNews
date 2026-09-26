import { prisma } from "@/lib/db";
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from "./password";
import { createSession, type NewSession } from "./session";

export const FREE_PLAN_SLUG = "free";

export interface AuthMeta {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface AuthSuccess extends NewSession {
  user: { id: string; email: string; displayName: string | null };
}

export type AuthResult = AuthSuccess | { error: string };

/** Generic, non-enumerating message for any login failure. */
const INVALID_CREDENTIALS = "Invalid email or password.";

/**
 * Registers a new account and immediately signs it in with a fresh
 * session. Every new user is enrolled in the Free plan atomically with
 * account creation (a Subscription row to "free", status "active") so
 * "what plan is this user on" never has a null/missing case to handle
 * elsewhere in the app.
 */
export async function registerUser(
  input: { email: string; password: string; displayName?: string },
  meta: AuthMeta = {},
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();

  const freePlan = await prisma.plan.findUnique({ where: { slug: FREE_PLAN_SLUG } });
  if (!freePlan) {
    // Should never happen in a correctly seeded deployment (see
    // prisma/seedPlans.ts); fail loudly rather than create a plan-less user.
    return { error: "Sign-up is temporarily unavailable. Please try again shortly." };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Deliberately NOT a generic response here: with no email-verification
    // flow in place yet (no outbound email sending exists in this project),
    // silently no-op-ing this request would either fabricate a fake
    // "check your email" step or silently do nothing while claiming
    // success — both worse than a direct, rate-limited error. See
    // SECURITY.md for this trade-off and the mitigation path once email
    // sending exists (User.emailVerifiedAt is already reserved for it).
    return { error: "An account with this email already exists." };
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        passwordHash,
        displayName: input.displayName?.trim() || null,
        lastLoginAt: new Date(),
      },
    });
    await tx.subscription.create({
      data: { userId: created.id, planId: freePlan.id, status: "active" },
    });
    return created;
  });

  const session = await createSession(user.id, meta);
  return {
    ...session,
    user: { id: user.id, email: user.email, displayName: user.displayName },
  };
}

/**
 * Verifies credentials and issues a session. Returns the same generic
 * error, in roughly the same amount of time, whether the email doesn't
 * exist or the password is wrong — this is the one place account
 * enumeration is worth fully closing, since (unlike registration) there's
 * no legitimate reason for the two cases to look different.
 */
export async function loginUser(
  input: { email: string; password: string },
  meta: AuthMeta = {},
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    await verifyAgainstDummyHash(input.password);
    return { error: INVALID_CREDENTIALS };
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    return { error: INVALID_CREDENTIALS };
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const session = await createSession(user.id, meta);
  return {
    ...session,
    user: { id: user.id, email: user.email, displayName: user.displayName },
  };
}
