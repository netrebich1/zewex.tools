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
import { joinHeadingTail } from "@/lib/articles/text/textGuards";
import { cleanTitleArtifacts } from "../../worker/articles/stages/meta";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const siteArg = args.includes("--site") ? args[args.indexOf("--site") + 1] : "";
const limit = Number(args[args.indexOf("--limit") + 1]) || 100_000;
/** --severe: только дефекты (H1, описание, хвосты H2), без дотягивания регистра H2 — первый быстрый проход. */
const severe = args.includes("--severe");
/** Потоков всего и на один сайт: сохранение записи в WP медленное (Yoast, сброс кэша) — параллелим, но бережно. */
const concurrency = Number(args[args.indexOf("--concurrency") + 1]) || 6;
const perSite = Number(args[args.indexOf("--per-site") + 1]) || 2;

const KEEP_TAIL = /\b(?:Version|Variation|Take|Look|Twist)$/i;
const NEG_TAIL = /,\s*(?:With\s+)?(?:No|Not|Without|None)\b[^,]*$/i;
/** Хвост — предмет (обувь, одежда, аксессуар, декор): его присоединяем словами. */
const ITEM_TAIL = /\b(?:sandals|heels|boots|shoes|sneakers|loafers|flats|mules|pumps|coat|blazer|jacket|cardigan|top|shirt|blouse|sweater|tee|bag|clutch|tote|belt|scarf|hat|earrings|necklace|jewelry|tights|jeans|pants|trousers|skirt|shorts|pieces|accents?|details?|studs|pearls|rhinestones|charms|flowers|florals|foil|stones)$/i;

/** H2 опубликованной статьи: убрать хвост-отрицание, хвост дубля через запятую — словами, регистр. */
export function fixHeading(h: string, withCase = true): string {
  let s = String(h || "").replace(/\s+/g, " ").trim();
  s = s.replace(NEG_TAIL, "");
  // На опубликованных меняем только хвост-предмет («…, Strappy Heeled Sandals»); признак через запятую оставляем.
  const m = s.match(/^(.+?),\s+([^,]+)$/);
  if (m && !KEEP_TAIL.test(m[2]) && ITEM_TAIL.test(m[2]) && m[2].split(" ").length <= 5) s = joinHeadingTail(m[1], m[2]);
  return withCase ? titleCaseHeading(s) : s;
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
  console.log(`статей: ${rows.length}${dry ? " (без изменений)" : ""}${severe ? " · только дефекты" : ""} · потоков ${concurrency}, на сайт ${perSite}`);
  let changed = 0, h1n = 0, h2n = 0, descn = 0, failed = 0, done = 0;
  const samples: string[] = [];
  type Task = { a: (typeof rows)[number]; h1: string; title: string; desc: string; heads: Array<{ id: string; heading: string; next: string }> };
  const tasks: Task[] = [];
  for (const a of rows) {
    const sections = await prisma.artSection.findMany({ where: { articleId: a.id, position: { gte: 1, lt: 9990 } }, select: { id: true, heading: true } });
    const h1 = cleanTitleArtifacts(a.h1);
    const title = cleanTitleArtifacts(a.metaTitle);
    const desc = a.metaDescription.replace(/([.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase()).replace(/\b3d\b/g, "3D");
    const heads = sections.map((x) => ({ ...x, next: fixHeading(x.heading, !severe) })).filter((x) => x.next !== x.heading);
    if (h1 === a.h1 && title === a.metaTitle && desc === a.metaDescription && !heads.length) continue;
    changed++;
    if (h1 !== a.h1) h1n++;
    if (desc !== a.metaDescription) descn++;
    h2n += heads.length;
    if (samples.length < 12) {
      if (h1 !== a.h1) samples.push(`H1: ${a.h1} → ${h1}`);
      for (const h of heads.slice(0, 1)) samples.push(`H2: ${h.heading} → ${h.next}`);
    }
    tasks.push({ a, h1, title, desc, heads });
  }
  console.log(`к правке: ${tasks.length}`);

  const fix = async ({ a, h1, title, desc, heads }: Task) => {
    const acc = a.site.access;
    if (!acc?.username || !acc.appPasswordEnc) throw new Error("нет доступа WordPress");
    const creds = { baseUrl: acc.baseUrl, username: acc.username, appPassword: decryptSecret(acc.appPasswordEnc) };
    const post = await fetchPostRaw(creds, a.wpPostId!);
    const map = new Map(heads.map((h) => [decode(h.heading).toLowerCase(), h.next]));
    const swap = (src: string) => src.replace(/(<h2\b[^>]*>)([\s\S]*?)(<\/h2>)/gi, (m, open: string, inner: string, close: string) => {
      const next = map.get(decode(inner).toLowerCase());
      return next ? `${open}${encode(next)}${close}` : m;
    });
    const content = swap(post.content);
    const meta: Record<string, string> = {};
    if (title !== a.metaTitle) meta._yoast_wpseo_title = title;
    if (desc !== a.metaDescription) meta._yoast_wpseo_metadesc = desc;
    const patch = { ...(h1 !== a.h1 ? { title: h1 } : {}), ...(content !== post.content ? { content } : {}), ...(Object.keys(meta).length ? { meta } : {}) };
    if (Object.keys(patch).length) await updatePost(creds, a.wpPostId!, patch, { timeoutMs: 180_000 });
    const html = a.html ? swap(a.html) : "";
    await prisma.article.update({ where: { id: a.id }, data: { h1, metaTitle: title, metaDescription: desc, ...(html ? { html } : {}) } });
    for (const h of heads) await prisma.artSection.update({ where: { id: h.id }, data: { heading: h.next } });
  };

  if (!dry) {
    const started = Date.now();
    const bySite = new Map<string, number>();
    const queue = [...tasks];
    const worker = async () => {
      for (;;) {
        const i = queue.findIndex((t) => (bySite.get(t.a.siteId) ?? 0) < perSite);
        if (i < 0) {
          if (!queue.length) return;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        const t = queue.splice(i, 1)[0];
        bySite.set(t.a.siteId, (bySite.get(t.a.siteId) ?? 0) + 1);
        try {
          await fix(t);
        } catch (e) {
          failed++;
          console.warn(`${t.a.site.name} ${t.a.id}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          bySite.set(t.a.siteId, (bySite.get(t.a.siteId) ?? 1) - 1);
          done++;
          if (done % 25 === 0 || done === tasks.length) console.log(`… ${done}/${tasks.length} · ошибок ${failed} · ${((Date.now() - started) / 60_000).toFixed(1)} мин`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
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
