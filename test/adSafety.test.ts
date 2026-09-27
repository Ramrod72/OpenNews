import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("Ad components are actually wired to viewer eligibility", () => {
  it("AdSlot gates on shouldRenderAds()/useAdEligibility(), not just the admin `enabled` flag", () => {
    const source = read("src/components/ads/AdSlot.tsx");
    expect(source).toMatch(/useAdEligibility\(\)/);
    expect(source).toMatch(/shouldRenderAds\(/);
  });

  it("AdHeadSnippet gates on shouldRenderAds()/useAdEligibility() too — the network's loader script must not load for Basic/Pro", () => {
    const source = read("src/components/ads/AdHeadSnippet.tsx");
    expect(source).toMatch(/useAdEligibility\(\)/);
    expect(source).toMatch(/shouldRenderAds\(/);
  });

  it("AdContainer (the server component embedded in ISR-cached pages) never reads cookies/session — the per-viewer decision must stay entirely client-side so a page cached for one viewer can't leak into another's render", () => {
    const source = read("src/components/ads/AdContainer.tsx");
    expect(source).not.toMatch(/cookies\(|getCurrentUser|resolveSessionUser/);
  });

  it("the root layout wires AdEligibilityProvider around both the page content and AdHeadSnippet", () => {
    const source = read("src/app/layout.tsx");
    expect(source).toMatch(/AdEligibilityProvider/);
  });

  it("/api/ads/eligibility never returns anything beyond the boolean decision (no email, user id, or plan name)", () => {
    const source = read("src/app/api/ads/eligibility/route.ts");
    const responseBodies = [...source.matchAll(/NextResponse\.json\(\s*(\{[^}]*\})/g)].map(
      (m) => m[1],
    );
    expect(responseBodies.length).toBeGreaterThan(0);
    for (const body of responseBodies) {
      expect(body).toMatch(/^\{\s*adsAllowed:/);
      expect(body).not.toMatch(/email|displayName|planId|plan\.name|user\.id/);
    }
  });

  it("no ad code/snippet is ever templated with viewer data before being injected", () => {
    const adSlot = read("src/components/ads/AdSlot.tsx");
    const adHead = read("src/components/ads/AdHeadSnippet.tsx");
    for (const source of [adSlot, adHead]) {
      expect(source).not.toMatch(/user\.email|user\.id|displayName|subscriptionId/);
    }
  });
});

describe("No hardcoded plan-slug checks were introduced for ad gating", () => {
  it('ad-related files never compare a plan slug directly (e.g. === "pro") — everything goes through can()/entitlements', () => {
    const files = [
      "src/lib/ads.ts",
      "src/app/api/ads/eligibility/route.ts",
      "src/components/ads/AdSlot.tsx",
      "src/components/ads/AdHeadSnippet.tsx",
      "src/components/ads/AdContainer.tsx",
      "src/components/ads/AdEligibilityProvider.tsx",
    ];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toMatch(/===\s*["'](free|basic|pro)["']/);
    }
  });
});
