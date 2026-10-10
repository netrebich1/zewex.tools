import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const prisma = new PrismaClient();

const providers = [
  { slug: "openai", name: "OpenAI", kind: "LLM", adapter: "OPENAI_COMPAT", authType: "BEARER", baseUrl: "https://api.openai.com/v1", modelsEndpoint: "models", docsUrl: "https://platform.openai.com/docs", order: 1 },
  { slug: "openrouter", name: "OpenRouter", kind: "LLM", adapter: "OPENAI_COMPAT", authType: "BEARER", baseUrl: "https://openrouter.ai/api/v1", modelsEndpoint: "models", docsUrl: "https://openrouter.ai/docs", order: 2 },
  { slug: "laozhang", name: "laozhang.ai", kind: "LLM", adapter: "OPENAI_COMPAT", authType: "BEARER", baseUrl: "https://api.laozhang.ai/v1", modelsEndpoint: "models", docsUrl: "https://docs.laozhang.ai", order: 3 },
  { slug: "perplexity", name: "Perplexity", kind: "LLM", adapter: "OPENAI_COMPAT", authType: "BEARER", baseUrl: "https://api.perplexity.ai", modelsEndpoint: null, docsUrl: "https://docs.perplexity.ai", order: 4 },
  { slug: "dataforseo", name: "DataForSEO", kind: "DATA", adapter: "DATAFORSEO", authType: "BASIC", baseUrl: "https://api.dataforseo.com/v3", modelsEndpoint: null, docsUrl: "https://docs.dataforseo.com/v3/", order: 5 },
  { slug: "serpapi", name: "SerpAPI", kind: "DATA", adapter: "SERPAPI", authType: "QUERY", baseUrl: "https://serpapi.com", modelsEndpoint: null, docsUrl: "https://serpapi.com/search-api", order: 6 },
];

const manualModels = {
  perplexity: [
    { modelId: "sonar", name: "Sonar", capabilities: "CHAT", inputPrice: 1, outputPrice: 1, contextLength: 128000 },
    { modelId: "sonar-pro", name: "Sonar Pro", capabilities: "CHAT", inputPrice: 3, outputPrice: 15, contextLength: 200000 },
    { modelId: "sonar-reasoning-pro", name: "Sonar Reasoning Pro", capabilities: "CHAT", inputPrice: 2, outputPrice: 8, contextLength: 128000 },
    { modelId: "sonar-deep-research", name: "Sonar Deep Research", capabilities: "CHAT", inputPrice: 2, outputPrice: 8, contextLength: 128000 },
  ],
};

const sections = [
  { slug: "pinterest", name: "Pinterest", icon: "pin", order: 1 },
  { slug: "gambling", name: "Gambling", icon: "dice", order: 2 },
  { slug: "seo", name: "SEO", icon: "search", order: 3 },
  { slug: "discovery", name: "Discovery", icon: "compass", order: 4 },
];

// Seed only creates what is missing; it never overwrites values the admin may have edited in the UI.
for (const p of providers) {
  await prisma.provider.upsert({ where: { slug: p.slug }, update: {}, create: p });
}
for (const [slug, models] of Object.entries(manualModels)) {
  const provider = await prisma.provider.findUnique({ where: { slug } });
  for (const m of models) {
    await prisma.model.upsert({
      where: { providerId_modelId: { providerId: provider.id, modelId: m.modelId } },
      update: {},
      create: { ...m, providerId: provider.id, source: "MANUAL", isEnabled: true },
    });
  }
}
for (const s of sections) {
  await prisma.section.upsert({ where: { slug: s.slug }, update: {}, create: s });
}

// Модели по умолчанию: с ними ключ подключается к сервису одной галочкой, без выбора модели.
const defaults = {
  openrouter: { chat: ["google/gemini-2.5-flash", "Gemini 2.5 Flash (OpenRouter)", 0.3, 2.5], image: ["google/gemini-2.5-flash-image", "Gemini 2.5 Flash Image (OpenRouter)", null, null, 0.04] },
  laozhang: { chat: ["gemini-2.5-flash", "Gemini 2.5 Flash (laozhang)", 0.3, 2.5], image: ["gpt-image-2", "GPT Image 2 (laozhang)", null, null, 0.02] },
  openai: { chat: ["gpt-4.1-mini", "GPT-4.1 mini", 0.4, 1.6], image: ["gpt-image-2", "GPT Image 2", null, null, 0.02] },
  perplexity: { chat: ["sonar", "Sonar", 1, 1] },
};
for (const [slug, d] of Object.entries(defaults)) {
  const provider = await prisma.provider.findUnique({ where: { slug } });
  if (!provider) continue;
  const patch = {};
  for (const [cap, [modelId, name, inputPrice, outputPrice, unitPrice]] of Object.entries(d)) {
    await prisma.model.upsert({
      where: { providerId_modelId: { providerId: provider.id, modelId } },
      update: { isEnabled: true },
      create: { providerId: provider.id, modelId, name, capabilities: cap === "image" ? "IMAGE" : "CHAT", inputPrice, outputPrice, unitPrice: unitPrice ?? null, source: "MANUAL", isEnabled: true },
    });
    if (cap === "chat" && !provider.defaultChatModel) patch.defaultChatModel = modelId;
    if (cap === "image" && !provider.defaultImageModel) patch.defaultImageModel = modelId;
  }
  if (Object.keys(patch).length) await prisma.provider.update({ where: { id: provider.id }, data: patch });
}

// Проект «Pinterest Pins» и его слоты: команды привязывают к ним свои ключи.
const pinterest = await prisma.section.findUnique({ where: { slug: "pinterest" } });
const pins = await prisma.project.upsert({
  where: { slug: "pins" },
  update: {},
  create: { sectionId: pinterest.id, slug: "pins", name: "Pinterest Pins", description: "Массовое создание пинов: прогоны, модерация, расписание, выгрузка CSV", url: "/pinterest/pins", status: "MIGRATING", order: 1 },
});
const pinSlots = [
  { key: "text_main", name: "Тексты (основная модель)", capability: "CHAT", description: "Промты ИИ-пинов, Pinora, тексты пинов, хуки Canvas, подбор досок", preferProviders: "openrouter,laozhang,openai" },
  { key: "text_fast", name: "Тексты (быстрая модель)", capability: "CHAT", description: "Ключевое слово, тема и ниша страницы; дешёвая модель", preferProviders: "openrouter,laozhang,openai" },
  { key: "image_main", name: "Картинки пинов", capability: "IMAGE", description: "Генерация ИИ-пинов (gpt-image-2 или аналог), 1024×1536", preferProviders: "openai,laozhang,openrouter" },
];
for (const sl of pinSlots) {
  await prisma.slot.upsert({ where: { projectId_key: { projectId: pins.id, key: sl.key } }, update: { preferProviders: sl.preferProviders }, create: { ...sl, projectId: pins.id } });
}
// Проект «Подбор доменов» (раздел Gambling): ИИ-отбор + анализ выдачи (DataForSEO, SerpAPI как запасной).
const gambling = await prisma.section.findUnique({ where: { slug: "gambling" } });
const domains = await prisma.project.upsert({
  where: { slug: "domains" },
  update: {},
  create: { sectionId: gambling.id, slug: "domains", name: "Подбор доменов", description: "Бренды × приставки × зоны: свободные домены по RDAP, анализ Google TOP-10, ИИ-отбор, выгрузка CSV/XLSX", url: "/gambling/domains", status: "ACTIVE", order: 1 },
});
const domainSlots = [
  { key: "text_main", name: "ИИ-отбор доменов", capability: "CHAT", description: "Выбор лучших свободных доменов под бренд-запрос", preferProviders: "openrouter,laozhang,openai" },
  { key: "serp_dfs", name: "Выдача Google (DataForSEO)", capability: "SEO_DATA", description: "TOP-10 по брендам для анализа приставок и зон; основной источник", preferProviders: "dataforseo" },
  { key: "serp_api", name: "Выдача Google (SerpAPI)", capability: "SERP", description: "Запасной источник TOP-10, если DataForSEO не подключён или недоступен", preferProviders: "serpapi" },
];
for (const sl of domainSlots) {
  await prisma.slot.upsert({ where: { projectId_key: { projectId: domains.id, key: sl.key } }, update: { preferProviders: sl.preferProviders }, create: { ...sl, projectId: domains.id } });
}
// Системная запись сайта для каждого сайта инструмента без неё (сайты, импортированные из легаси).
// Адрес выводится из имени, логин и Application Password владелец вводит в разделе «Сайты». Идемпотентно.
const orphans = await prisma.pinSite.findMany({ where: { wpConnectionId: null }, select: { id: true, name: true, teamId: true } });
for (const s of orphans) {
  const host = s.name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/[^a-z0-9.-]/g, "");
  const name = host || s.name.trim();
  const baseUrl = `https://${host || s.name.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "")}`;
  const access = await prisma.siteAccess.create({ data: { teamId: s.teamId, kind: "wordpress", name, baseUrl, username: "", appPasswordEnc: "", projects: ["pins"] } });
  await prisma.pinSite.update({ where: { id: s.id }, data: { wpConnectionId: access.id, name } });
}
if (orphans.length) console.log(`site accesses created for ${orphans.length} tool sites`);

// ───────────────────────────── Pinterest Articles ─────────────────────────────
// Проект «Статьи» и его слоты; ниши, профили, наборы промтов, промты и рецепты из перенесённого сервиса
// (prisma/seed-data/articles/*.json, старые UUID сохранены). Идемпотентно: существующие записи не перезаписываются,
// кроме текстов промтов, которые ещё никто не правил в UI (нет версий).

const seedDir = join(dirname(fileURLToPath(import.meta.url)), "seed-data", "articles");
const articlesProject = await prisma.project.upsert({
  where: { slug: "articles" },
  update: {},
  create: { sectionId: pinterest.id, slug: "articles", name: "Pinterest Articles", description: "Статьи-подборки под Pinterest: реальные фото → модерация → текст → публикация в WordPress", url: "/pinterest/articles", status: "MIGRATING", order: 2 },
});
const articleSlots = [
  { key: "text_main", name: "Тексты статьи (писатель)", capability: "CHAT", description: "Секции, вступление и заключение, мета (deepseek-v4-flash/pro по рецепту)", preferProviders: "openrouter,laozhang,openai" },
  { key: "text_fast", name: "Быстрые шаги текста", capability: "CHAT", description: "Запросы поиска фото, план статьи, план секций, alt-тексты (gemini-2.5-flash-lite по рецепту)", preferProviders: "openrouter,laozhang,openai" },
  { key: "vision", name: "Оценка и отбор фото (vision)", capability: "CHAT", description: "Оценка кандидатов по картинкам, сравнение, финальный отбор, ИИ-модерация", preferProviders: "openrouter,laozhang,openai" },
  { key: "image_main", name: "Генерация картинок", capability: "IMAGE", description: "Формат «ИИ-фото»: gpt-image-2 (quality low, 1024×1536)", preferProviders: "openai,laozhang,openrouter" },
  { key: "photo_dfs", name: "Поиск фото (DataForSEO)", capability: "SEO_DATA", description: "Google Images через DataForSEO — основной источник реальных фото ($0.004/запрос)", preferProviders: "dataforseo" },
  { key: "photo_serp", name: "Поиск фото (SerpAPI)", capability: "SERP", description: "Запасной источник Google Images, если DataForSEO не подключён", preferProviders: "serpapi" },
];
for (const sl of articleSlots) {
  await prisma.slot.upsert({ where: { projectId_key: { projectId: articlesProject.id, key: sl.key } }, update: { preferProviders: sl.preferProviders }, create: { ...sl, projectId: articlesProject.id } });
}

const artCfg = JSON.parse(readFileSync(join(seedDir, "config.json"), "utf8"));
const artPrompts = JSON.parse(readFileSync(join(seedDir, "prompts.json"), "utf8"));
for (const n of artCfg.niches) {
  await prisma.artNiche.upsert({ where: { code: n.code }, update: {}, create: n });
}
for (const p of artCfg.profiles) {
  await prisma.artNicheProfile.upsert({ where: { nicheCode: p.nicheCode }, update: {}, create: p });
}
for (const s of artPrompts.sets) {
  await prisma.artPromptSet.upsert({ where: { id: s.id }, update: {}, create: s });
}
let promptsCreated = 0;
for (const p of artPrompts.prompts) {
  const { createdAt, ...rest } = p;
  const existing = await prisma.artPrompt.findUnique({ where: { id: p.id }, select: { id: true, versions: { select: { id: true }, take: 1 } } });
  if (!existing) {
    await prisma.artPrompt.create({ data: { ...rest, createdAt: new Date(createdAt) } });
    promptsCreated++;
  } else if (!existing.versions.length) {
    // Текст ещё не редактировали в портале — обновляем до версии из переноса (исправления аудита).
    await prisma.artPrompt.update({ where: { id: p.id }, data: { system: rest.system, text: rest.text, name: rest.name } });
  }
}
for (const r of artCfg.recipes) {
  await prisma.artRecipe.upsert({ where: { id: r.id }, update: {}, create: r });
}
console.log(`articles seed: ${artCfg.niches.length} niches, ${artCfg.profiles.length} profiles, ${artPrompts.sets.length} sets, ${artPrompts.prompts.length} prompts (${promptsCreated} new), ${artCfg.recipes.length} recipes`);
console.log("seed done");
await prisma.$disconnect();
