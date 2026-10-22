/**
 * Исправление заголовков уже опубликованных статей (аудит woman-trend 2026-10-22). Для каждой COMPLETED-статьи с записью
 * на сайте:
 *  - H1 (заголовок записи) и SEO-тайтл — cleanTitleArtifacts (повтор фразы «for Brunettes for Brunettes», «: &», «: Cuts»);
 *  - мета-описание — заглавная после конца предложения, «3D»;
 *  - H2 секций — хвост дубля через запятую → словами («…, Black Open-Toe Sandals» → «… and Black Open-Toe Sandals»),
 *    хвосты-отрицания («, With No Visible Bangs») убираются, один регистр (titleCaseHeading).
 * Запись на сайте правится точечно: заголовок, Yoast-поля и текст H2 внутри сырого content (картинки, подписи, метка
 * статьи не трогаются). База обновляется тем же. Идемпотентно.
 *
 *   cd /var/www/zewex_tools_usr/data/app && sudo -u zewex_tools_usr -H npx tsx scripts/articles/fix-published-titles.ts [--dry] [--site woman-trend.com] [--limit N]
 */
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { fetchPostRaw, updatePost } from "@/lib/articles/wp/posts";
import { titleCaseHeading } from "@/lib/articles/text/polish";
import { cleanTitleArtifacts } from "../../worker/articles/stages/meta";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const siteArg = args.includes("--site") ? args[args.indexOf("--site") + 1] : "";
const limit = Number(args[args.indexOf("--limit") + 1]) || 100_000;

const KEEP_TAIL = /\b(?:Version|Variation|Take|Look|Twist)$/i;
const NEG_TAIL = /,\s*(?:With\s+)?(?:No|Not|Without|None)\b[^,]*$/i;

/** H2 опубликованной статьи: убрать хвост-отрицание, хвост дубля через запятую — словами, регистр. */
export function fixHeading(h: string): string {
  let s = String(h || "").replace(/\s+/g, " ").trim();
  s = s.replace(NEG_TAIL, "");
  const m = s.match(/^(.+?),\s+([^,]+)$/);
  if (m && !KEEP_TAIL.test(m[2]) && m[2].split(" ").length <= 5) {
    const base = m[1];
    const tail = m[2].replace(/^(?:With|And)\s+/i, "");
    s = /\bwith\b/i.test(base) ? `${base} and ${tail}` : `${base} With ${tail}`;
  }
  return titleCaseHeading(s);
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#0?38;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const encode = (s: string) => s.replace(/&/g, "&amp;");

async function main() {
  const rows = await prisma.article.findMany({
    where: { status: "COMPLETED", wpPostId: { not: null }, ...(siteArg ? { site: { name: { contains: siteArg } } } : {}) },
    select: { id: true, h1: true, metaTitle: true, metaDescription: true, wpPostId: true, html: true, siteId: true, site: { select: { name: true, access: { select: { baseUrl: true, username: true, appPasswordEnc: true } } } } },
    orderBy: { finishedAt: "desc" },
    take: limit,
  });
  console.log(`статей: ${rows.length}${dry ? " (без изменений)" : ""}`);
  let changed = 0, h1n = 0, h2n = 0, descn = 0, failed = 0;
  const samples: string[] = [];
  for (const a of rows) {
    const sections = await prisma.artSection.findMany({ where: { articleId: a.id, position: { gte: 1, lt: 9990 } }, select: { id: true, heading: true } });
    const h1 = cleanTitleArtifacts(a.h1);
    const title = cleanTitleArtifacts(a.metaTitle);
    const desc = a.metaDescription.replace(/([.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase()).replace(/\b3d\b/g, "3D");
    const heads = sections.map((s) => ({ ...s, next: fixHeading(s.heading) })).filter((s) => s.next !== s.heading);
    const dirty = h1 !== a.h1 || title !== a.metaTitle || desc !== a.metaDescription || heads.length > 0;
    if (!dirty) continue;
    changed++;
    if (h1 !== a.h1) h1n++;
    if (desc !== a.metaDescription) descn++;
    h2n += heads.length;
    if (samples.length < 12) {
      if (h1 !== a.h1) samples.push(`H1: ${a.h1} → ${h1}`);
      for (const h of heads.slice(0, 1)) samples.push(`H2: ${h.heading} → ${h.next}`);
    }
    if (dry) continue;
    try {
      const acc = a.site.access;
      if (!acc?.username || !acc.appPasswordEnc) throw new Error("нет доступа WordPress");
      const creds = { baseUrl: acc.baseUrl, username: acc.username, appPassword: decryptSecret(acc.appPasswordEnc) };
      const post = await fetchPostRaw(creds, a.wpPostId!);
      let content = post.content;
      const map = new Map(heads.map((h) => [decode(h.heading).toLowerCase(), h.next]));
      content = content.replace(/(<h2\b[^>]*>)([\s\S]*?)(<\/h2>)/gi, (m, open: string, inner: string, close: string) => {
        const next = map.get(decode(inner).toLowerCase());
        return next ? `${open}${encode(next)}${close}` : m;
      });
      const meta: Record<string, string> = {};
      if (title !== a.metaTitle) meta._yoast_wpseo_title = title;
      if (desc !== a.metaDescription) meta._yoast_wpseo_metadesc = desc;
      await updatePost(creds, a.wpPostId!, {
        ...(h1 !== a.h1 ? { title: h1 } : {}),
        ...(content !== post.content ? { content } : {}),
        ...(Object.keys(meta).length ? { meta } : {}),
      });
      let html = a.html ?? "";
      if (html) html = html.replace(/(<h2\b[^>]*>)([\s\S]*?)(<\/h2>)/gi, (m, open: string, inner: string, close: string) => {
        const next = map.get(decode(inner).toLowerCase());
        return next ? `${open}${encode(next)}${close}` : m;
      });
      await prisma.article.update({ where: { id: a.id }, data: { h1, metaTitle: title, metaDescription: desc, ...(html ? { html } : {}) } });
      for (const h of heads) await prisma.artSection.update({ where: { id: h.id }, data: { heading: h.next } });
    } catch (e) {
      failed++;
      console.warn(`${a.site.name} ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (changed % 50 === 0) console.log(`… ${changed} статей поправлено`);
  }
  console.log(samples.join("\n"));
  console.log(`итого: статей с правками ${changed}, H1 ${h1n}, H2 ${h2n}, описаний ${descn}, ошибок ${failed}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
