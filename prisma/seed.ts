import { PrismaClient } from "@prisma/client";
import categories from "../config/categories.json";
import sources from "../config/sources.json";
import { seedPlans } from "./seedPlans";

const prisma = new PrismaClient();

async function main() {
  for (const category of categories) {
    await prisma.category.upsert({
      where: { slug: category.slug },
      create: category,
      update: { name: category.name, order: category.order },
    });
  }
  console.log(`Synced ${categories.length} categories.`);

  for (const source of sources as Array<{
    name: string;
    url: string;
    homepageUrl?: string;
    categorySlug: string;
    fetchIntervalMinutes?: number;
  }>) {
    await prisma.source.upsert({
      where: { url: source.url },
      create: {
        name: source.name,
        url: source.url,
        homepageUrl: source.homepageUrl,
        categorySlug: source.categorySlug,
        fetchIntervalMinutes: source.fetchIntervalMinutes ?? 30,
      },
      update: {
        name: source.name,
        homepageUrl: source.homepageUrl,
        categorySlug: source.categorySlug,
      },
    });
  }
  console.log(`Synced ${sources.length} sources.`);

  await seedPlans(prisma);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
