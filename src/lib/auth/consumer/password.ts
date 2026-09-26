import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

// A valid bcrypt hash of an arbitrary, unused string. Used only to make
// login take roughly the same amount of time whether or not the email
// matches an account, so response timing doesn't reveal account existence.
const DUMMY_HASH = "$2b$12$48GNlsgp.1KEN3o4A/eTVeNTkUsfXQnGc4ljZ3BdH4gIHOqT3ndUS";

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Burns roughly the same time as a real password check, for the "no such account" path. */
export function verifyAgainstDummyHash(plain: string): Promise<boolean> {
  return bcrypt.compare(plain, DUMMY_HASH);
}
