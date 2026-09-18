-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "homepageUrl" TEXT,
    "categorySlug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "fetchIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
    "lastFetchedAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleNormalized" TEXT NOT NULL,
    "excerpt" TEXT,
    "imageUrl" TEXT,
    "author" TEXT,
    "categoryId" TEXT,
    "publishedAt" DATETIME NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "guid" TEXT,
    "clusterId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Article_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Article_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Article_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "StoryCluster" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StoryCluster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "headline" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "summary" TEXT,
    "categoryId" TEXT,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "articleCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" DATETIME NOT NULL,
    "lastUpdatedAt" DATETIME NOT NULL,
    "breaking" BOOLEAN NOT NULL DEFAULT false,
    "breakingScore" REAL NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoryCluster_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "term" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ArticleKeyword" (
    "articleId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1,

    PRIMARY KEY ("articleId", "keywordId"),
    CONSTRAINT "ArticleKeyword_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArticleKeyword_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClusterKeyword" (
    "clusterId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1,

    PRIMARY KEY ("clusterId", "keywordId"),
    CONSTRAINT "ClusterKeyword_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "StoryCluster" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClusterKeyword_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FeedFetchLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "success" BOOLEAN NOT NULL,
    "itemsFound" INTEGER NOT NULL DEFAULT 0,
    "itemsNew" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    CONSTRAINT "FeedFetchLog_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Source_url_key" ON "Source"("url");

-- CreateIndex
CREATE INDEX "Source_active_idx" ON "Source"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Article_url_key" ON "Article"("url");

-- CreateIndex
CREATE UNIQUE INDEX "Article_urlHash_key" ON "Article"("urlHash");

-- CreateIndex
CREATE INDEX "Article_publishedAt_idx" ON "Article"("publishedAt");

-- CreateIndex
CREATE INDEX "Article_clusterId_idx" ON "Article"("clusterId");

-- CreateIndex
CREATE INDEX "Article_categoryId_idx" ON "Article"("categoryId");

-- CreateIndex
CREATE INDEX "Article_titleNormalized_idx" ON "Article"("titleNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "StoryCluster_slug_key" ON "StoryCluster"("slug");

-- CreateIndex
CREATE INDEX "StoryCluster_lastUpdatedAt_idx" ON "StoryCluster"("lastUpdatedAt");

-- CreateIndex
CREATE INDEX "StoryCluster_breaking_idx" ON "StoryCluster"("breaking");

-- CreateIndex
CREATE INDEX "StoryCluster_categoryId_idx" ON "StoryCluster"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_term_key" ON "Keyword"("term");

-- CreateIndex
CREATE INDEX "FeedFetchLog_sourceId_startedAt_idx" ON "FeedFetchLog"("sourceId", "startedAt");
