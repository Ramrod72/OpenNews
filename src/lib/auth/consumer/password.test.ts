import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from "./password";

describe("consumer password hashing", () => {
  it("hashes never equal the plaintext and round-trip through verifyPassword", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toBe("correct horse battery staple");
    expect(hash.startsWith("$2")).toBe(true); // bcrypt hash marker
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same input");
    const b = await hashPassword("same input");
    expect(a).not.toBe(b);
  });

  it("the dummy-hash comparison always resolves false without throwing", async () => {
    await expect(verifyAgainstDummyHash("anything")).resolves.toBe(false);
  });
});
