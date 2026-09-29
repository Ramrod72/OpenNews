-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "currentPeriodStart" DATETIME;
ALTER TABLE "Subscription" ADD COLUMN "externalPriceId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "lastSyncedAt" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_externalSubscriptionId_key" ON "Subscription"("externalSubscriptionId");

-- CreateTable
CREATE TABLE "ProcessedWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
