-- CreateTable
CREATE TABLE "CheckoutIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "planSlug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "externalCheckoutSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "CheckoutIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutIntent_userId_key" ON "CheckoutIntent"("userId");
