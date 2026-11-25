/**
 * Проверка фильтра размера/ориентации в поиске картинок (cost-fixes-b, п.4): один и тот же запрос уходит в DataForSEO
 * без фильтра и с `searchSizeFilter` (tbs isz:l + iar:t), первые N кадров каждой выдачи скачиваются, и считается,
 * сколько из них прошло бы наш фильтр (короткая сторона ≥ 550, ориентация tall/square — как в рецепте).
 *   npx tsx scripts/articles/search-filter-test.ts "<ключ>" [--user=<userId>] [--team=<teamId>] [--n=100] [--serp]
 * Стоит ≈ $0.002 за запрос DataForSEO (две выдачи). --serp — то же для SerpApi (дороже). Ничего в базе не меняет
 * (кроме строк UsageLog за сами запросы).
 */
import { setDefaultResultOrder } from "dns";
import { prisma } from "@/lib/db";
import type { AiCtx } from "@/lib/articles/ai";
import { normalizeSearchConfig, orientationVerdict, searchDataForSeo, searchSerpApi, sizeVerdict, buildTbs, type PhotoCandidateInput, type SearchCfg } from "@/lib/articles/photo/search";
import { downloadImage, imageDims } from "@/lib/articles/photo/download";

setDefaultResultOrder("ipv4first");
const flag = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const has = (k: string) => process.argv.includes(`--${k}`);

type Stat = { fetched: number; downloaded: number; small: number; wrongAspect: number; pass: number; dims: Array<[number, number]> };

async function measure(items: PhotoCandidateInput[], cfg: SearchCfg, n: number): Promise<Stat> {
  const st: Stat = { fetched: items.length, downloaded: 0, small: 0, wrongAspect: 0, pass: 0, dims: [] };
  const slice = items.slice(0, n);
  let i = 0;
  const worker = async () => {
    for (;;) {
      const it = slice[i++];
      if (!it) return;
      let dims: { width: number; height: number } | null = it.width && it.height ? { width: it.width, height: it.height } : null;
      if (!dims) {
        try {
          const dl = await downloadImage([it.url, it.thumbUrl], { timeoutMs: 15_000 });
          if (!dl.ok || dl.usedThumbnail) continue;
          dims = await imageDims(dl.bytes);
        } catch {
          continue;
        }
      }
      if (!dims) continue;
      st.downloaded++;
      st.dims.push([dims.width, dims.height]);
      if (sizeVerdict(dims.width, dims.height, cfg)) { st.small++; continue; }
      if (orientationVerdict(dims.width, dims.height, cfg)) { st.wrongAspect++; continue; }
      st.pass++;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return st;
}

function line(name: string, s: Stat) {
  const pct = (x: number) => (s.downloaded ? `${Math.round((100 * x) / s.downloaded)}%` : "-");
  console.log(`${name}: выдача ${s.fetched}, скачано ${s.downloaded}, мелкие ${s.small} (${pct(s.small)}), ориентация ${s.wrongAspect} (${pct(s.wrongAspect)}), прошло ${s.pass} (${pct(s.pass)})`);
}

async function main() {
  const keyword = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!keyword) throw new Error("Укажите ключ: npx tsx scripts/articles/search-filter-test.ts \"purple bob\"");
  const n = Number(flag("n") || 100);
  let userId = flag("user");
  let teamId = flag("team");
  if (!userId || !teamId) {
    // По умолчанию — владелец сайта women-club.online (у него есть правила слотов поиска).
    const site = await prisma.artSite.findFirst({ where: { name: { contains: "women-club" } }, select: { createdById: true, teamId: true } });
    userId ||= site?.createdById || "";
    teamId ||= site?.teamId || "";
  }
  if (!userId || !teamId) throw new Error("Нужны --user и --team");
  const ctx: AiCtx = { userId, teamId };
  const base = normalizeSearchConfig({ orientation: ["tall", "square"], candidatesTotal: 100 });
  const plain: SearchCfg = { ...base, size_filter: false };
  const filtered: SearchCfg = { ...base, size_filter: true };
  console.log(`Ключ «${keyword}», tbs без фильтра = «${buildTbs(plain)}», с фильтром = «${buildTbs(filtered)}»`);
  const search = has("serp") ? searchSerpApi : searchDataForSeo;
  const limit = Math.max(100, n);
  const a = await search(ctx, keyword, plain, limit);
  if (a.error) console.log("без фильтра:", a.error);
  const b = await search(ctx, keyword, filtered, limit);
  if (b.error) console.log("с фильтром:", b.error);
  const urlsA = new Set(a.items.map((x) => x.url));
  const overlap = b.items.filter((x) => urlsA.has(x.url)).length;
  const sa = await measure(a.items, plain, n);
  const sb = await measure(b.items, filtered, n);
  line("без фильтра", sa);
  line("с фильтром ", sb);
  console.log(`общих URL в двух выдачах: ${overlap}`);
  const med = (d: Array<[number, number]>) => { const s = d.map(([w, h]) => Math.min(w, h)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  console.log(`медиана короткой стороны: без фильтра ${med(sa.dims)} px, с фильтром ${med(sb.dims)} px`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
