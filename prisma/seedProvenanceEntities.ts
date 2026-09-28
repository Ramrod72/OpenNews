import type { PrismaClient } from "@prisma/client";
import provenanceEntities from "../config/provenanceAliases.json";

interface AliasConfig {
  text: string;
  matchType: "EXACT" | "CASE_INSENSITIVE";
}

interface EntityConfig {
  canonicalName: string;
  entityType: string;
  primaryDomain?: string;
  aliases: AliasConfig[];
}

/**
 * Seeds the small, conservative provenance-entity/alias set from
 * config/provenanceAliases.json — the same "config as data" convention as
 * seedPlans.ts. Deliberately minimal (Reuters, AP, DOJ, FBI only, per
 * Phase 7B's scope): not a general media database, and never mixed with
 * Phase 6's ExternalAssessment data (a third party's political-lean/
 * factuality rating is a completely different concept from "this article's
 * text cites this entity").
 *
 * Idempotent: safe to run repeatedly (upsert by ProvenanceEntity's unique
 * canonicalName, and by ProvenanceAlias's unique normalizedAlias) —
 * running it again with the same config file is always a no-op.
 */
export async function seedProvenanceEntities(prisma: PrismaClient): Promise<void> {
  let aliasCount = 0;

  for (const entity of provenanceEntities as EntityConfig[]) {
    const entityRow = await prisma.provenanceEntity.upsert({
      where: { canonicalName: entity.canonicalName },
      create: {
        canonicalName: entity.canonicalName,
        entityType: entity.entityType,
        primaryDomain: entity.primaryDomain,
      },
      update: {
        entityType: entity.entityType,
        primaryDomain: entity.primaryDomain,
      },
    });

    for (const alias of entity.aliases) {
      const normalizedAlias = alias.text.trim().toLowerCase();

      // Never touch a row a human has since corrected — re-seeding must
      // not be able to silently clobber a manual fix (same principle as
      // reprocessing preserving ADMIN_OVERRIDE observations, see
      // src/lib/provenance/persistObservations.ts).
      const existing = await prisma.provenanceAlias.findUnique({ where: { normalizedAlias } });
      if (existing && existing.source === "ADMIN_OVERRIDE") continue;

      await prisma.provenanceAlias.upsert({
        where: { normalizedAlias },
        create: {
          entityId: entityRow.id,
          aliasText: alias.text,
          normalizedAlias,
          matchType: alias.matchType,
          source: "SEED",
        },
        update: {
          entityId: entityRow.id,
          aliasText: alias.text,
          matchType: alias.matchType,
        },
      });
      aliasCount += 1;
    }
  }

  console.log(`Synced ${provenanceEntities.length} provenance entities and ${aliasCount} aliases.`);
}
