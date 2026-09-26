import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { verifyAdminPassword } from "./password";

/**
 * Regression coverage for the existing (untouched) admin credential check,
 * added as part of the Phase 3 consumer-accounts work so the admin auth
 * system — which had no automated tests before this — has a safety net
 * against future regressions, without modifying it.
 */
describe("verifyAdminPassword (admin auth regression)", () => {
  const originalHash = process.env.ADMIN_PASSWORD_HASH;
  const originalPlain = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    delete process.env.ADMIN_PASSWORD_HASH;
    delete process.env.ADMIN_PASSWORD;
  });

  afterEach(() => {
    if (originalHash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
    else process.env.ADMIN_PASSWORD_HASH = originalHash;
    if (originalPlain === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = originalPlain;
  });

  it("fails when neither ADMIN_PASSWORD_HASH nor ADMIN_PASSWORD is set (no default credential)", async () => {
    await expect(verifyAdminPassword("anything")).resolves.toBe(false);
  });

  it("accepts the correct password against a bcrypt ADMIN_PASSWORD_HASH", async () => {
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("s3cret-admin-pw", 12);
    await expect(verifyAdminPassword("s3cret-admin-pw")).resolves.toBe(true);
  });

  it("rejects an incorrect password against ADMIN_PASSWORD_HASH", async () => {
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("s3cret-admin-pw", 12);
    await expect(verifyAdminPassword("wrong")).resolves.toBe(false);
  });

  it("falls back to plaintext ADMIN_PASSWORD when no hash is configured", async () => {
    process.env.ADMIN_PASSWORD = "dev-only-password";
    await expect(verifyAdminPassword("dev-only-password")).resolves.toBe(true);
    await expect(verifyAdminPassword("wrong")).resolves.toBe(false);
  });

  it("prefers ADMIN_PASSWORD_HASH over ADMIN_PASSWORD when both are set", async () => {
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("hash-password", 12);
    process.env.ADMIN_PASSWORD = "plain-password";
    await expect(verifyAdminPassword("hash-password")).resolves.toBe(true);
    await expect(verifyAdminPassword("plain-password")).resolves.toBe(false);
  });
});
