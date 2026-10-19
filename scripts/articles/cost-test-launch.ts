/**
 * Тестовый запуск для замера расходов (cost-fixes-b, 2026-10-16): N ключей на сайте women-club.online (англ.) с рецептами
 * «реальные фото» ногти / волосы / одежда, норма 30 фото, черновик до одобрения, тестовая метка, и флаги cost-fixes-b
 * в снимке рецепта каждой статьи (`Article.recipe.photoSearch.rateMode` / `.searchSizeFilter`).
 *
 *   npx tsx scripts/articles/cost-test-launch.ts --name="cost-b slim+filter" [--rateMode=slim|full] [--sizeFilter=1|0]
 *       [--per=5] [--photoCount=30] [--photoReview=1|0] [--label=cost-b] [--keywords=a;b;c] [--apply]
 *
 * Без --apply только печатает, что будет создано. Ключи по умолчанию (по 5 на нишу) подобраны 2026-10-16: их нет среди
 * 4000 заголовков сайта и в прежних тестах (запуски 97c16bc6, 2f7e7129, 680241ad, 160186e2, bf37757f, d580e62d).
 * launchArticles сам пропустит ключ, который уже есть у сайта. Цепочки автозапуска сайта должны быть включены
 * (экран «Автозапуск»), иначе статьи останутся в очереди.
 */
import { setDefaultResultOrder } from "dns";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { launchArticles } from "@/lib/articles/launch";
import { mergeSiteSettings, type ArtRunSettings, type ArticleRecipeSnapshot, type KeywordInput } from "@/lib/articles/types";

setDefaultResultOrder("ipv4first");
const flag = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const has = (k: string) => process.argv.includes(`--${k}`);

export const SITE_ID = "6c1b4b83-505e-4e91-a02c-f6d64ac3b984";
export const RECIPES = {
  nails: "267cea29-ee61-43f9-8079-4c7c081a6968",
  hair: "93cd14c9-4953-4a13-a0aa-4df456453be6",
  outfits: "24896a02-6128-4fb0-9e84-9873e9c320a1",
} as const;

/** Ключи теста по нишам (5 на нишу). */
export const TEST_KEYWORDS: Record<keyof typeof RECIPES, string[]> = {
  nails: ["blueberry milk nails", "coquette nails", "strawberry nails", "pistachio nails", "vanilla chrome nails"],
  hair: ["layered lob", "cowboy copper hair", "dark cherry hair", "bubble braid hairstyles", "peekaboo highlights"],
  outfits: ["sweater vest outfits", "ballet flats outfits", "linen pants outfits", "puffer vest outfits", "cowboy boots outfits"],
};

async function main() {
  const name = flag("name") || `cost-b ${new Date().toISOString().slice(0, 16)}`;
  const rateMode = (flag("rateMode") || "full") as "full" | "slim";
  if (!["full", "slim"].includes(rateMode)) throw new Error("--rateMode=full|slim");
  const sizeFilter = flag("sizeFilter") === "1";
  const per = Number(flag("per") || 5);
  const photoCount = Number(flag("photoCount") || 30);
  const photoReview = flag("photoReview") !== "0";
  const testLabel = flag("label") || "cost-b";
  const apply = has("apply");

  const site = await prisma.artSite.findUnique({ where: { id: SITE_ID }, select: { id: true, name: true, teamId: true, createdById: true, isActive: true, settings: true } });
  if (!site?.createdById) throw new Error("Сайт теста не найден или без автора");
  const owner = await prisma.user.findUnique({ where: { id: site.createdById }, select: { id: true, role: true, memberships: { select: { teamId: true, role: true } } } });
  if (!owner || owner.role !== "ADMIN") throw new Error("Автор сайта не админ — запускайте от админа (--user пока не поддерживается)");
  const me = {
    id: owner.id, email: "", name: "", role: "ADMIN", teamIds: owner.memberships.map((t) => t.teamId), leadTeamIds: owner.memberships.filter((t) => t.role === "LEAD").map((t) => t.teamId),
    perms: {} as CurrentUser["perms"], superAdmin: true, memberView: false, impersonator: null, privateTools: [],
  } as CurrentUser;

  // Список ключей: --keywords=a;b;c (ниша угадывается по слову) или встроенные по `per` на нишу.
  const custom = flag("keywords")?.split(";").map((k) => k.trim()).filter(Boolean);
  const keywords: KeywordInput[] = [];
  if (custom?.length) {
    for (const k of custom) {
      const niche: keyof typeof RECIPES = /nail/i.test(k) ? "nails" : /outfit|dress|skirt|pants|boots|flats|vest|coat|jacket/i.test(k) ? "outfits" : "hair";
      keywords.push({ keyword: k, recipeId: RECIPES[niche], photoCount });
    }
  } else {
    for (const niche of Object.keys(RECIPES) as Array<keyof typeof RECIPES>) {
      for (const k of TEST_KEYWORDS[niche].slice(0, per)) keywords.push({ keyword: k, recipeId: RECIPES[niche], photoCount });
    }
  }

  const settings: ArtRunSettings = {
    recipeId: RECIPES.nails,
    photoCount: { mode: "exact", min: photoCount, max: photoCount },
    photoReview,
    publishMode: "moderate_first",
    search: { country: "", language: "", freshness: "" },
    yearInUrlPercent: null,
    testLabel,
  };
  const chains = mergeSiteSettings(site.settings).autostart;
  console.log(`Автозапуск сайта сейчас: фото ${chains.photoEnabled ? "вкл" : "ВЫКЛ"}, написание ${chains.writingEnabled ? "вкл" : "ВЫКЛ"} (с --apply включатся).`);
  console.log(`Сайт ${site.name} (${site.isActive ? "активен" : "В АРХИВЕ"}), запуск «${name}», ${keywords.length} ключей, фото ${photoCount}, модерация фото ${photoReview ? "да" : "нет"}, черновик до одобрения`);
  console.log(`Флаги снимка: rateMode=${rateMode}, searchSizeFilter=${sizeFilter}`);
  for (const k of keywords) console.log(`  ${k.keyword}  →  ${Object.entries(RECIPES).find(([, id]) => id === k.recipeId)?.[0]}`);
  if (!apply) {
    console.log("Сухой прогон: добавьте --apply, чтобы создать запуск.");
    await prisma.$disconnect();
    return;
  }

  // Цепочки автозапуска сайта («фото» и «написание») должны быть включены, иначе статьи останутся в очереди
  // (у women-club они выключены после прошлых тестов). Остальные настройки сайта не трогаем.
  const st = mergeSiteSettings(site.settings);
  if (!st.autostart.photoEnabled || !st.autostart.writingEnabled) {
    const raw = (site.settings ?? {}) as Record<string, unknown>;
    const autostart = { ...((raw.autostart as Record<string, unknown> | undefined) ?? {}), photoEnabled: true, writingEnabled: true };
    await prisma.artSite.update({ where: { id: site.id }, data: { settings: { ...raw, autostart } as object } });
    console.log(`Автозапуск сайта включён: фото ${st.autostart.photoEnabled ? "уже был" : "включён"}, написание ${st.autostart.writingEnabled ? "уже было" : "включено"} (лимиты ${st.autostart.photoLimit}/${st.autostart.writingLimit}).`);
  }
  const res = await launchArticles(me, { siteId: site.id, settings, keywords, name });
  console.log(`Создан запуск ${res.runId}: статей ${res.created}; пропущено ${res.skipped.length ? res.skipped.join(", ") : "—"}; невалидных ${res.invalid.length}`);

  // Флаги cost-fixes-b — в снимок рецепта каждой статьи запуска (воркер исполняет снимок, не рецепт).
  const arts = await prisma.article.findMany({ where: { runId: res.runId }, select: { id: true, recipe: true } });
  for (const a of arts) {
    const snap = a.recipe as unknown as ArticleRecipeSnapshot;
    const recipe: ArticleRecipeSnapshot = { ...snap, photoSearch: { ...snap.photoSearch, rateMode, searchSizeFilter: sizeFilter } };
    await prisma.article.update({ where: { id: a.id }, data: { recipe: recipe as unknown as object } });
  }
  console.log(`Снимки обновлены у ${arts.length} статей. Отчёт после прохождения: npx tsx scripts/articles/cost-test-report.ts ${res.runId} --out=<папка>`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
