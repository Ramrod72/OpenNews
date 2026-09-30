import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 14B — M6: docker-compose.yml must never publish the `web`
 * service's port to all host interfaces — this app has no TLS of its own,
 * so a plain "3000:3000" mapping would serve production traffic directly,
 * in plaintext, to the public Internet on a typical cloud VM. A static
 * check here catches a regression the same way test/adminSettingsSecurity
 * .test.ts statically checks other security-relevant source files.
 */
const COMPOSE_PATH = join(__dirname, "..", "docker-compose.yml");

describe("docker-compose.yml network exposure", () => {
  const source = readFileSync(COMPOSE_PATH, "utf8");

  it("the web service's published port is bound to loopback only, never to all interfaces", () => {
    expect(source).toMatch(/"127\.0\.0\.1:3000:3000"/);
    // Guard against the exact regression this test exists to catch: a
    // bare "3000:3000" (no host/interface prefix) publishes to 0.0.0.0.
    expect(source).not.toMatch(/^\s*-\s*"3000:3000"\s*$/m);
  });

  it("the worker service publishes no port at all (never reachable from the host network)", () => {
    const workerSection = source.slice(source.indexOf("\n  worker:"));
    expect(workerSection).not.toMatch(/ports:/);
  });

  it("no real secret value is hardcoded — every credential-shaped env var uses ${...} substitution", () => {
    for (const name of ["SESSION_SECRET", "ADMIN_PASSWORD_HASH", "ADMIN_PASSWORD"]) {
      const line = source.split("\n").find((l) => l.trim().startsWith(`${name}:`));
      expect(line).toBeDefined();
      expect(line).toMatch(/\$\{/);
    }
  });
});
