/**
 * Импорт справочных данных сервиса пинов из SQL-дампа Lovable (docs/replicate/*.sql)
 * в MariaDB портала. Идемпотентен (upsert по id). Запуск на сервере:
 *   node scripts/pins/import-seed.mjs --dir /path/to/replicate [--team zewex=<slug> --team pinora=<slug> --team wexora=<slug>]
 * Метки __TEAM_ZEWEX__ / __TEAM_PINORA__ / __TEAM_WEXORA__ заменяются на id команд портала
 * (по slug; команды создаются, если их нет).
 */
import { PrismaClient } from "@prisma/client";
import { join } from "path";
import { parseInsertFile, asArray, asObject } from "./parse-pg-inserts.mjs";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1];
};
const dir = opt("--dir", "docs/replicate");
const teamSlugs = { ZEWEX: "zewex", PINORA: "pinora", WEXORA: "wexora" };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--team") {
    const [k, v] = (args[i + 1] || "").split("=");
    if (k && v) teamSlugs[k.toUpperCase()] = v;
  }
}

const teamIds = {};
for (const [mark, slug] of Object.entries(teamSlugs)) {
  const name = mark === "ZEWEX" ? "Zewex" : mark === "PINORA" ? "PinOra" : "WexOra";
  const t = await prisma.team.upsert({ where: { slug }, update: {}, create: { slug, name, description: "Команда сервиса пинов" } });
  teamIds[`__TEAM_${mark}__`] = t.id;
}
const team = (v) => (v && teamIds[v]) || teamIds.__TEAM_ZEWEX__;
const date = (v) => {
  if (!v) return new Date();
  // '2026-08-16 15:14:38.464878+00' → ISO с полным смещением
  const iso = String(v).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

const THEMES = ["beauty-fashion", "food", "home-decor", "tattoo", "blog-info"];
const libraryOf = (id) => {
  if (id.startsWith("newyear-")) return "newyear";
  const th = THEMES.find((t) => id.startsWith(`v9-${t}-`));
  if (th) return `v9-${th}`;
  if (id.startsWith("mix-")) return "mix";
  if (id.startsWith("ref-")) return "ref";
  return "other";
};

const stats = {};
const count = (k) => (stats[k] = (stats[k] || 0) + 1);

// 01 pinora_themes
for (const r of parseInsertFile(join(dir, "01_pinora_themes.sql"), { table: "pinora_themes", columns: ["id", "name", "display_name", "instructions", "learned_rules", "sort_order", "created_at", "updated_at"] })) {
  await prisma.pinPinoraTheme.upsert({ where: { id: r.id }, update: {}, create: { id: r.id, name: r.name, displayName: r.display_name, instructions: asObject(r.instructions), learnedRules: asArray(r.learned_rules), sortOrder: r.sort_order } });
  count("pinora_themes");
}

// 02 canva_styles
for (const r of parseInsertFile(join(dir, "02_canva_styles.sql"), { table: "canva_styles", columns: ["id", "name", "category", "data", "is_active", "sort_order", "created_at", "updated_at"] })) {
  await prisma.pinCanvasStyle.upsert({ where: { id: r.id }, update: {}, create: { id: r.id, libraryId: libraryOf(r.id), name: r.name, category: r.category, data: asObject(r.data), isActive: !!r.is_active, sortOrder: r.sort_order, createdAt: date(r.created_at) } });
  count("canva_styles");
}

// 03 pin_examples (картинки скачает fetch-examples.mjs)
for (const r of parseInsertFile(join(dir, "03_pin_examples.sql"), { table: "pin_examples", columns: ["id", "niche", "image_url", "caption", "sort_order", "created_at", "updated_at", "style_id", "topic"] })) {
  await prisma.pinExample.upsert({ where: { id: r.id }, update: {}, create: { id: r.id, niche: r.niche, sourceUrl: r.image_url, caption: r.caption, sortOrder: r.sort_order, createdAt: date(r.created_at), styleId: r.style_id, topic: r.topic } });
  count("pin_examples");
}

// 04 sites — порядок колонок восстановлен по миграциям (28 значений)
const SITE_COLS = ["id", "account_id", "name", "slug", "default_topic", "default_headline_language", "default_subject_color_hint", "default_reference_url", "created_at", "updated_at", "default_season", "default_year", "season_percent", "year_percent", "format_2_3_percent", "default_number", "number_percent", "site_name_on_pin", "site_name_percent", "cta_percent", "gender_target", "buffer_access_token", "buffer_profile_ids", "daily_pins_min", "daily_pins_max", "team_id", "canvas_library_ids", "autopilot_settings"];
const siteIds = new Set();
for (const r of parseInsertFile(join(dir, "04_sites.sql"), { table: "sites", columns: SITE_COLS })) {
  const ap = asObject(r.autopilot_settings);
  const mid = (a, b) => Math.round(((a || 0) + (b ?? a ?? 0)) / 2);
  const pct = [r.season_percent, r.year_percent, r.number_percent, r.cta_percent, r.site_name_percent].filter((x) => x > 0);
  const recipe = {
    mix: {
      ai: ap.aiEnabled === false ? 0 : mid(ap.pinsPerPageMin ?? 3, ap.pinsPerPageMax ?? 5),
      photos: ap.photosEnabled === false ? 0 : mid(ap.photosMin ?? 2, ap.photosMax ?? 6),
      canvas: ap.canvasEnabled ? mid(ap.canvasPerPageMin ?? 2, ap.canvasPerPageMax ?? 4) : 0,
      pinora: ap.pinoraEnabled ? mid(ap.pinoraPlan?.perUrlMin ?? 2, ap.pinoraPlan?.perUrlMax ?? 2) : 0,
    },
    photosMode: ap.recipeSite ? "featured_only" : "all",
    sets: { aiSetIds: asArray(ap.pinSetIds), canvasSetIds: asArray(ap.canvasSetIds), pinoraTypes: asArray(ap.pinoraPlan?.types ?? []) },
    text: {
      language: ap.headlineLanguage || r.default_headline_language || "en",
      hashtags: (ap.hashtagPercent ?? 40) > 0,
      variety: pct.length ? Math.round(pct.reduce((a, b) => a + b, 0) / pct.length) : 60,
      elements: { season: r.season_percent > 0, year: r.year_percent > 0, number: r.number_percent > 0, cta: r.cta_percent > 0, siteName: r.site_name_percent > 0 && !!r.site_name_on_pin },
      audience: ["women", "men", "mix"].includes(r.gender_target) ? r.gender_target : "women",
      brandColor: r.default_subject_color_hint || undefined,
    },
    publishing: { wpConnectionId: null, linkDomain: "", photoLinkPercent: mid(ap.linkPercentMin ?? 30, ap.linkPercentMax ?? 50) },
    schedule: { pinsPerDay: Math.min(100, ap.maxPerDay || r.daily_pins_max || 90), startFrom: "next_free_day", moderationMode: "required", samplePercent: 20 },
    boards: { multiBoard: !!ap.multiBoard },
  };
  const legacy = { ...r, buffer_access_token: undefined, legacyWpConnectionId: ap.wpConnectionId ?? null };
  // (teamId, slug) уникальны; в дампе встречаются дубли slug у разных аккаунтов одной команды
  let slug = `${r.slug}`.slice(0, 80) || r.id.slice(0, 8);
  const tid = team(r.team_id);
  const taken = await prisma.pinSite.findFirst({ where: { teamId: tid, slug, NOT: { id: r.id } }, select: { id: true } });
  if (taken) slug = `${slug}-${r.id.slice(0, 4)}`;
  await prisma.pinSite.upsert({
    where: { id: r.id },
    update: {},
    create: { id: r.id, teamId: tid, name: r.name, slug, niche: r.default_topic || "", recipe, legacy, createdAt: date(r.created_at) },
  });
  siteIds.add(r.id);
  count("sites");
}

// 05 bulk_boards
for (const r of parseInsertFile(join(dir, "05_bulk_boards.sql"), { table: "bulk_boards", columns: ["id", "site_id", "name", "sort_order", "created_at", "updated_at", "team_id"] })) {
  if (!siteIds.has(r.site_id)) continue;
  await prisma.pinBoard.upsert({ where: { id: r.id }, update: {}, create: { id: r.id, siteId: r.site_id, name: r.name, sortOrder: r.sort_order } });
  count("boards");
}

// 06 bulk_pin_sets
for (const r of parseInsertFile(join(dir, "06_bulk_pin_sets.sql"), { table: "bulk_pin_sets", columns: ["id", "site_id", "name", "pin_count", "style_ids", "created_at", "updated_at", "topic", "set_kind", "canvas_style_ids", "team_id"] })) {
  if (!siteIds.has(r.site_id)) continue;
  const kind = r.set_kind === "canvas" ? "canvas" : "ai";
  await prisma.pinSet.upsert({ where: { id: r.id }, update: {}, create: { id: r.id, siteId: r.site_id, name: r.name, topic: r.topic || "", setKind: kind, styleIds: kind === "canvas" ? asArray(r.canvas_style_ids) : asArray(r.style_ids), pinCount: r.pin_count, createdAt: date(r.created_at) } });
  count("pin_sets");
}

// 07 site_style_presets → наборы ИИ без темы (помечены meta.source=preset)
for (const r of parseInsertFile(join(dir, "07_site_style_presets.sql"), { table: "site_style_presets", columns: ["id", "site_id", "name", "style_ids", "created_at", "updated_at"] })) {
  if (!siteIds.has(r.site_id)) continue;
  await prisma.pinSet.upsert({ where: { id: r.id }, update: {}, create: { id: r.id, siteId: r.site_id, name: r.name, topic: "", setKind: "ai", styleIds: asArray(r.style_ids), pinCount: asArray(r.style_ids).length, meta: { source: "preset" }, createdAt: date(r.created_at) } });
  count("presets");
}

// 08 style_topic_exclusions
for (const r of parseInsertFile(join(dir, "08_style_topic_exclusions.sql"), { table: "style_topic_exclusions", columns: ["id", "team_id", "site_id", "topic", "style_id", "kind", "style_name", "created_at"] })) {
  if (!siteIds.has(r.site_id)) continue;
  await prisma.pinStyleExclusion.upsert({ where: { id: r.id }, update: {}, create: { id: r.id, teamId: team(r.team_id), siteId: r.site_id, topic: r.topic || "", styleId: r.style_id, kind: r.kind || "ai", styleName: r.style_name || "" } });
  count("exclusions");
}

// 09 style_overrides → одна «заметка к стилю»
for (const r of parseInsertFile(join(dir, "09_style_overrides.sql"), { table: "style_overrides", columns: ["id", "account_id", "style_id", "instruction", "chat_log", "screenshots", "enabled", "created_at", "updated_at", "site_id", "topic", "poyo_model", "team_id"] })) {
  await prisma.pinStyleOverride.upsert({ where: { id: r.id }, update: {}, create: { id: r.id, teamId: team(r.team_id), siteId: r.site_id && siteIds.has(r.site_id) ? r.site_id : null, styleId: r.style_id, instruction: r.instruction || "", isActive: !!r.enabled } });
  count("overrides");
}

console.log("import done:", stats);
await prisma.$disconnect();
