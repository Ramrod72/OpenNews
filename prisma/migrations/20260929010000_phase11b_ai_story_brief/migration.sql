-- CreateTable
CREATE TABLE "AiStoryBrief" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storyClusterId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "reviewState" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiStoryBrief_storyClusterId_fkey" FOREIGN KEY ("storyClusterId") REFERENCES "StoryCluster" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AiStoryBrief_storyClusterId_idx" ON "AiStoryBrief"("storyClusterId");

-- CreateIndex
CREATE UNIQUE INDEX "AiStoryBrief_storyClusterId_feature_inputFingerprint_promp_key" ON "AiStoryBrief"("storyClusterId", "feature", "inputFingerprint", "promptVersion", "provider", "model");
