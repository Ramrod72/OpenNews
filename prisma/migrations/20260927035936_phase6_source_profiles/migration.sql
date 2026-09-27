-- AlterTable
ALTER TABLE "Source" ADD COLUMN "country" TEXT;
ALTER TABLE "Source" ADD COLUMN "description" TEXT;
ALTER TABLE "Source" ADD COLUMN "foundedYear" INTEGER;
ALTER TABLE "Source" ADD COLUMN "ownership" TEXT;
ALTER TABLE "Source" ADD COLUMN "profileUpdatedAt" DATETIME;
ALTER TABLE "Source" ADD COLUMN "sourceType" TEXT;

-- CreateTable
CREATE TABLE "ExternalAssessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "assessmentType" TEXT NOT NULL,
    "ratingValue" TEXT NOT NULL,
    "ratingScale" TEXT,
    "referenceUrl" TEXT,
    "assessedAt" DATETIME,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExternalAssessment_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExternalAssessment_sourceId_idx" ON "ExternalAssessment"("sourceId");

-- CreateIndex
CREATE INDEX "ExternalAssessment_provider_idx" ON "ExternalAssessment"("provider");

-- CreateIndex
CREATE INDEX "ExternalAssessment_assessmentType_idx" ON "ExternalAssessment"("assessmentType");
