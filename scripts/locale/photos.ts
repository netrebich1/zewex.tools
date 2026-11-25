/**
 * Кадры под темы (docs/copy/LOCALES-PLAN.md, 2а, шаг 3): по английским атрибутам темы (attrs) ищем кадры ниши в банке —
 * опубликованные ArtPhoto (wpUrl) и резерв ArtPhotoCandidate (reserve/keep) — по описанию и фактам (английский текст; факты
 * иногда на русском — тогда работает только описание). Все атрибуты темы должны совпасть (И), значения расширяются словарём
 * синонимов (pink → pink|rose|blush…, christmas → christmas|xmas|holiday|festive…). Считаем уникальные sha256, ёмкость
 * статей ≈ кадры / 14 (20 кадров на статью при пересечении ≤ 30 %), статус ready при ≥ 12 кадрах, иначе waiting_photos.
 * Лимиты использования по языку (LocPhotoUse) появятся на этапе сборки — здесь только потенциал банка.
 *
 *   npx tsx scripts/locale/photos.ts --lang cs --niche nails [--min-photos 12]
 */
import { prisma } from "@/lib/db";
import { LOCALE_LANGS } from "@/lib/locale/languages";

const args = process.argv.slice(2);
const get = (k: string) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));

/** Синонимы значений атрибутов (английский текст описаний и фактов). Ключ — слово в нижнем регистре. */
const SYN: Record<string, string> = {
  pink: "pink|rose|blush|fuchsia|magenta|rosy", red: "red|cherry|burgundy|wine|crimson|scarlet", white: "white|ivory|milky|snow", black: "black|onyx|noir",
  blue: "blue|navy|cobalt|sky|denim|teal|turquoise", nude: "nude|beige|neutral|taupe|sheer|natural[- ]tone", green: "green|olive|sage|emerald|mint|khaki",
  purple: "purple|lavender|lilac|violet|plum|mauve", yellow: "yellow|mustard|lemon", orange: "orange|coral|peach|apricot|terracotta", brown: "brown|chocolate|coffee|mocha|caramel|tan",
  gold: "gold|golden|gilded", silver: "silver|metallic|chrome", grey: "gr[ae]y|charcoal", gray: "gr[ae]y|charcoal",
  ombre: "ombr[eé]|gradient|fade|fading|faded|baby ?boomer", french: "french|tips?\\b|smile line", glitter: "glitter|sparkl|shimmer|sequin|rhinestone", chrome: "chrome|mirror|metallic",
  cat: "cat[- ]?eye|magnetic", eye: "cat[- ]?eye|magnetic", marble: "marble|marbled|veined", milky: "milky|translucent|sheer white|soft white", neon: "neon|fluorescent|bright",
  almond: "almond", square: "square|squoval", coffin: "coffin|ballerina|tapered square", ballerina: "coffin|ballerina", oval: "oval", stiletto: "stiletto|pointed", round: "round|rounded",
  short: "short", long: "long|extra[- ]long|extended", medium: "medium|mid[- ]length",
  christmas: "christmas|xmas|holiday|festive|snowflake|santa|candy ?cane|reindeer|winter holiday", summer: "summer|tropical|beach|vacation|sunny|palm", autumn: "autumn|fall\\b|pumpkin|burnt orange|maple|leaf", fall: "autumn|fall\\b|pumpkin|burnt orange|maple",
  winter: "winter|snow|ice|frost|icy", spring: "spring|tulip|blossom|pastel|daisy", wedding: "wedding|bridal|bride|bridesmaid", party: "party|celebration|festive|new year",
  gel: "gel|shellac|polish", acrylic: "acrylic|sculpted|extension", artificial: "acrylic|gel|extension|press[- ]on|artificial", shellac: "shellac|gel polish",
  art: "art|design|pattern|motif|painted|drawing", natural: "natural|bare|minimal|clean", nails: "nail", nail: "nail", manicure: "manicure|nails?\\b", pedicure: "pedicure|toes?|toenail|feet",
  doll: "doll|kawaii|bow|cute", japanese: "japanese|minimal|sheer|glossy nude", trendy: "", inspiration: "", ideas: "", colored: "color|colou?rful|bright", baby: "baby ?boomer|french ombre", boomer: "baby ?boomer|french ombre",
};
const STOP = new Set(["and", "or", "with", "the", "a", "of", "for", "in", "on", "to", "style", "styles", "look", "looks", "idea", "ideas", "inspiration", "trendy", "trend", "design", "designs"]);

function attrRegexes(attrs: Record<string, unknown>): RegExp[] {
  const out: RegExp[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "season" && typeof v === "string" && /^(all|any|evergreen|none)$/i.test(v)) continue;
    const words = String(v ?? "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w));
    for (const w of words) {
      const syn = SYN[w];
      if (syn === "") continue;
      out.push(new RegExp(`\\b(?:${syn ?? w.replace(/s$/, "")})`, "i"));
    }
  }
  return out;
}

type Photo = { sha: string; text: string };

async function loadNichePhotos(niche: string): Promise<Photo[]> {
  const pub = await prisma.$queryRaw<Array<{ sha: string; description: string | null; facts: unknown }>>`
    SELECT p.sha256 sha, p.description, p.facts FROM ArtPhoto p
    JOIN Article a ON a.id = p.articleId LEFT JOIN ArtRecipe r ON r.id = a.recipeId LEFT JOIN ArtSite s ON s.id = a.siteId
    WHERE p.wpUrl IS NOT NULL AND p.excluded = 0 AND p.sha256 IS NOT NULL AND COALESCE(r.nicheCode, s.nicheCode) = ${niche}`;
  const res = await prisma.$queryRaw<Array<{ sha: string; description: string | null; facts: unknown }>>`
    SELECT c.sha256 sha, c.aiDescription description, c.aiFacts facts FROM ArtPhotoCandidate c
    JOIN Article a ON a.id = c.articleId LEFT JOIN ArtRecipe r ON r.id = a.recipeId LEFT JOIN ArtSite s ON s.id = a.siteId
    WHERE c.status IN ('reserve','keep') AND c.sha256 IS NOT NULL AND c.aiDescription IS NOT NULL AND COALESCE(r.nicheCode, s.nicheCode) = ${niche}`;
  const bySha = new Map<string, Photo>();
  for (const row of [...pub, ...res]) {
    if (bySha.has(row.sha)) continue;
    const facts = row.facts ? (typeof row.facts === "string" ? row.facts : JSON.stringify(row.facts)) : "";
    bySha.set(row.sha, { sha: row.sha, text: `${row.description ?? ""} ${facts}`.toLowerCase() });
  }
  return [...bySha.values()];
}

async function main() {
  const lang = LOCALE_LANGS[get("--lang")[0] ?? "cs"];
  const niche = get("--niche")[0] ?? "nails";
  const minPhotos = Number(get("--min-photos")[0] ?? 12);
  const photos = await loadNichePhotos(niche);
  console.log(`кадров ниши «${niche}» в банке (уникальных): ${photos.length}`);
  const topics = await prisma.locTopic.findMany({ where: { lang: lang.code, niche, status: { not: "rejected" } }, orderBy: { volume: "desc" } });
  const rows: Array<Record<string, unknown>> = [];
  for (const t of topics) {
    const res = attrRegexes((t.attrs ?? {}) as Record<string, unknown>);
    const matched = res.length ? photos.filter((p) => res.every((re) => re.test(p.text))) : [];
    const n = matched.length;
    const capacity = Math.floor(n / 14);
    const status = n >= minPhotos ? "ready" : "waiting_photos";
    await prisma.locTopic.update({ where: { id: t.id }, data: { photos: n, capacity, status } });
    rows.push({ primary: t.primary, en: t.nameEn, vol: t.volume, attrs: JSON.stringify(t.attrs).slice(0, 70), photos: n, articles: capacity, status });
  }
  console.table(rows);
  const ready = rows.filter((r) => r.status === "ready");
  console.log(`тем ${rows.length}: готово к сборке ${ready.length} (статей по кадрам ≈ ${ready.reduce((s, r) => s + Number(r.articles), 0)}), ждут кадров ${rows.length - ready.length}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
