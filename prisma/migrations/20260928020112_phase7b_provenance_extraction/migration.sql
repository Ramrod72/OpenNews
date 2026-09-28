-- CreateTable
CREATE TABLE "ProvenanceEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalName" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "primaryDomain" TEXT,
    "relatedSourceId" TEXT,
    "mergedIntoId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProvenanceEntity_relatedSourceId_fkey" FOREIGN KEY ("relatedSourceId") REFERENCES "Source" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ProvenanceEntity_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "ProvenanceEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProvenanceAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "aliasText" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProvenanceAlias_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ProvenanceEntity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProvenanceObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "entityId" TEXT,
    "rawEntityText" TEXT NOT NULL,
    "relationshipType" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "evidenceText" TEXT NOT NULL,
    "extractionSource" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "reviewState" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProvenanceObservation_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProvenanceObservation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ProvenanceEntity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProvenanceEntity_canonicalName_key" ON "ProvenanceEntity"("canonicalName");

-- CreateIndex
CREATE INDEX "ProvenanceEntity_relatedSourceId_idx" ON "ProvenanceEntity"("relatedSourceId");

-- CreateIndex
CREATE INDEX "ProvenanceEntity_mergedIntoId_idx" ON "ProvenanceEntity"("mergedIntoId");

-- CreateIndex
CREATE INDEX "ProvenanceEntity_entityType_idx" ON "ProvenanceEntity"("entityType");

-- CreateIndex
CREATE INDEX "ProvenanceAlias_entityId_idx" ON "ProvenanceAlias"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ProvenanceAlias_normalizedAlias_key" ON "ProvenanceAlias"("normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "ProvenanceObservation_dedupeKey_key" ON "ProvenanceObservation"("dedupeKey");

-- CreateIndex
CREATE INDEX "ProvenanceObservation_articleId_idx" ON "ProvenanceObservation"("articleId");

-- CreateIndex
CREATE INDEX "ProvenanceObservation_entityId_idx" ON "ProvenanceObservation"("entityId");

-- CreateIndex
CREATE INDEX "ProvenanceObservation_extractorVersion_idx" ON "ProvenanceObservation"("extractorVersion");

-- CreateIndex
CREATE INDEX "ProvenanceObservation_reviewState_idx" ON "ProvenanceObservation"("reviewState");
