-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true
);

-- CreateIndex
CREATE INDEX "AdminAuditLog_occurredAt_idx" ON "AdminAuditLog"("occurredAt");
