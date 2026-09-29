-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "entityId" TEXT,
    "numericValue" REAL,
    "numericUnit" TEXT,
    "numericQualifier" TEXT,
    "extractionSource" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "claimExtractorVersion" TEXT NOT NULL,
    "reviewState" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Claim_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Claim_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ProvenanceEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Claim_dedupeKey_key" ON "Claim"("dedupeKey");

-- CreateIndex
CREATE INDEX "Claim_articleId_idx" ON "Claim"("articleId");

-- CreateIndex
CREATE INDEX "Claim_kind_idx" ON "Claim"("kind");

-- CreateIndex
CREATE INDEX "Claim_claimExtractorVersion_idx" ON "Claim"("claimExtractorVersion");

-- CreateIndex
CREATE INDEX "Claim_entityId_idx" ON "Claim"("entityId");
