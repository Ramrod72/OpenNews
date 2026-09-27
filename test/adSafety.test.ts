import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("Ad components are actually wired to viewer eligibility", () => {
  it("AdSlot gates on shouldRenderAds()/useAdConfig(), not just the admin config", () => {
    const source = read("src/components/ads/AdSlot.tsx");
    expect(source).toMatch(/useAdConfig\(\)/);
    expect(source).toMatch(/shouldRenderAds\(/);
  });

  it("AdHeadSnippet gates on shouldRenderAds()/useAdConfig() too — the network's loader script must not load for Basic/Pro", () => {
    const source = read("src/components/ads/AdHeadSnippet.tsx");
    expect(source).toMatch(/useAdConfig\(\)/);
    expect(source).toMatch(/shouldRenderAds\(/);
  });

  it("AdContainer (the server component embedded in ISR-cached pages) never reads cookies/session, and no longer looks up ad settings itself — both the admin config and the viewer decision must come from the client-side eligibility fetch, not a server-rendered prop", () => {
    const source = read("src/components/ads/AdContainer.tsx");
    expect(source).not.toMatch(/cookies\(|getCurrentUser|resolveSessionUser|getAdSettings/);
  });

  it("the root layout no longer fetches ad settings itself or passes them as props — AdHeadSnippet takes no props", () => {
    const source = read("src/app/layout.tsx");
    expect(source).toMatch(/AdEligibilityProvider/);
    expect(source).not.toMatch(/getAdSettings/);
    expect(source).toMatch(/<AdHeadSnippet\s*\/>/);
  });
});

describe("/api/ads/eligibility never leaks the ad snippet (or anything else) to an ineligible viewer", () => {
  const source = read("src/app/api/ads/eligibility/route.ts");
  const responseBodies = [...source.matchAll(/NextResponse\.json\(\s*(\{[^}]*\})/g)].map(
    (m) => m[1],
  );

  it("finds at least one response and every one starts with adsAllowed", () => {
    expect(responseBodies.length).toBeGreaterThan(0);
    for (const body of responseBodies) {
      expect(body).toMatch(/^\{\s*adsAllowed:/);
    }
  });

  it("no response body ever contains email, user id, plan name, or any other viewer PII", () => {
    for (const body of responseBodies) {
      expect(body).not.toMatch(/email|displayName|planId|plan\.name|user\.id/);
    }
  });

  it("`settings` (the actual ad code/snippet) never appears in the same response object as `adsAllowed: false` — an ineligible viewer's response can only ever be { adsAllowed: false }, nothing else", () => {
    for (const body of responseBodies) {
      if (/adsAllowed:\s*false/.test(body)) {
        expect(body).not.toMatch(/settings/);
      }
    }
    // ...and settings does appear somewhere, gated behind the true case — this isn't dead code.
    expect(responseBodies.some((b) => /adsAllowed:\s*true/.test(b) && /settings/.test(b))).toBe(
      true,
    );
  });
});

describe("No ad code/snippet is ever templated with viewer data before being injected", () => {
  it("AdSlot/AdHeadSnippet never reference user.email, user.id, displayName, or a subscription id", () => {
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
