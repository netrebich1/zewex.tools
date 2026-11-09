/**
 * Добавить WordPress-сайт из командной строки: доступ (PinWpConnection/SiteAccess), сайт сервиса «Статьи» и,
 * с --copy, привязку к Article Copy. Пароль приложения берётся из переменной окружения WP_APP_PASSWORD.
 *   WP_APP_PASSWORD='xxxx xxxx …' npx tsx scripts/articles/add-site.ts --url https://site.com --login user --team Zewex --owner email@x --niche outfits [--copy]
 * Проверяет доступ запросом /users/me и падает, если WordPress не пустил.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { testConnection } from "@/lib/pins/wp/client";
import { DEFAULT_SITE_SETTINGS } from "@/lib/articles/types";

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const baseUrl = (opt("url") ?? "").replace(/\/+$/, "");
  const username = opt("login") ?? "";
  const appPassword = process.env.WP_APP_PASSWORD ?? "";
  if (!baseUrl || !username || !appPassword) throw new Error("Нужны --url, --login и WP_APP_PASSWORD");
  const team = await prisma.team.findFirst({ where: { name: opt("team") ?? "Zewex" }, select: { id: true, name: true } });
  const owner = await prisma.user.findFirst({ where: { email: opt("owner") ?? "" }, select: { id: true } });
  if (!team || !owner) throw new Error("Команда или владелец не найдены");
  const niche = opt("niche") ?? null;
  if (niche && !(await prisma.artNiche.findUnique({ where: { code: niche } }))) throw new Error(`Ниша ${niche} не найдена`);

  const r = await testConnection({ baseUrl, username, appPassword });
  if (!r.ok) throw new Error(`WordPress не пустил: ${r.note}`);
  const name = baseUrl.replace(/^https?:\/\//, "");
  if (await prisma.siteAccess.findFirst({ where: { baseUrl } })) throw new Error("Такой доступ уже есть");

  const access = await prisma.siteAccess.create({
    data: { teamId: team.id, kind: "wordpress", name, baseUrl, username, appPasswordEnc: encryptSecret(appPassword), projects: ["pins", "articles", "blog"], lastCheckedAt: new Date(), lastCheckOk: true, lastCheckNote: r.note },
    select: { id: true },
  });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  const site = await prisma.artSite.create({
    data: { teamId: team.id, accessId: access.id, name, slug, nicheCode: niche, settings: DEFAULT_SITE_SETTINGS as unknown as Prisma.InputJsonValue, createdById: owner.id },
    select: { id: true },
  });
  if (args.includes("--copy")) await prisma.copySite.create({ data: { artSiteId: site.id, teamId: team.id, publish: true, createdById: owner.id } });
  console.log(JSON.stringify({ ok: true, accessId: access.id, siteId: site.id, name, team: team.name, wpUser: r.user, copy: args.includes("--copy") }));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
