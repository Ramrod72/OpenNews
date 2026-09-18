import bcrypt from "bcryptjs";
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";

/**
 * Verifies the admin password against either ADMIN_PASSWORD_HASH (a bcrypt
 * hash — recommended, see README for how to generate one) or, for local
 * development convenience only, a plaintext ADMIN_PASSWORD. If neither is
 * configured, login always fails rather than falling back to any default
 * credential.
 */
export async function verifyAdminPassword(candidate: string): Promise<boolean> {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (hash) {
    return bcrypt.compare(candidate, hash);
  }

  const plain = process.env.ADMIN_PASSWORD;
  if (plain) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[auth] Using plaintext ADMIN_PASSWORD in production. Set ADMIN_PASSWORD_HASH instead " +
          "(see .env.example).",
      );
    }
    return timingSafeEqual(candidate, plain);
  }

  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a comparison of equal-length buffers to keep timing roughly
    // constant regardless of the length mismatch.
    bcrypt.compareSync(a, bcrypt.hashSync(b, 1));
    return false;
  }
  return cryptoTimingSafeEqual(bufA, bufB);
}
