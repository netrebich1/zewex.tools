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
  // Только закрытые инструменты (PRIVATE_TOOLS): без доступа раздел не виден.
  { slug: "wexora", name: "Wexora", icon: "chart", order: 5 },
  { slug: "analytics", name: "Аналитика", icon: "chart", order: 6 },
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
  // gpt-image-2 у OpenAI тарифицируется по токенам: текст запроса $5, готовая картинка $30 за 1M (цена «за картинку» давала неверный расход).
  openai: { chat: ["gpt-4.1-mini", "GPT-4.1 mini", 0.4, 1.6], image: ["gpt-image-2", "GPT Image 2", 5, 30, null] },
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
// кроме текстов промтов, которые ещё никто не правил в UI (нет версий). Промт с версиями (правили в портале)
// обновляется, только если в prompts.json у него новая метка `seedRev`: сид пишет новую версию «seed:<rev> …»
// (история правок остаётся, прежний текст можно вернуть из версии) — один раз на метку, дальше правки в UI не трогает.
// Рецептам дописываются только недостающие ключи stageModels (модель шага, выбранная в портале, не меняется).

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
  // Профиль без описанной ниши пропускаем, иначе seed падает на внешнем ключе и ломает деплой.
  if (!artCfg.niches.some((n) => n.code === p.nicheCode)) { console.warn(`seed: profile for unknown niche "${p.nicheCode}" skipped (add it to config.json niches)`); continue; }
  await prisma.artNicheProfile.upsert({ where: { nicheCode: p.nicheCode }, update: {}, create: p });
}
for (const s of artPrompts.sets) {
  await prisma.artPromptSet.upsert({ where: { id: s.id }, update: {}, create: s });
}
let promptsCreated = 0, promptsVersioned = 0;
for (const p of artPrompts.prompts) {
  const { createdAt, seedRev, ...rest } = p;
  const existing = await prisma.artPrompt.findUnique({
    where: { id: p.id },
    select: { id: true, text: true, system: true, versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, text: true, system: true } } },
  });
  if (!existing) {
    await prisma.artPrompt.create({ data: { ...rest, createdAt: new Date(createdAt) } });
    promptsCreated++;
  } else if (!existing.versions.length) {
    // Текст ещё не редактировали в портале — обновляем до версии из переноса (исправления аудита).
    await prisma.artPrompt.update({ where: { id: p.id }, data: { system: rest.system, text: rest.text, name: rest.name } });
  } else if (seedRev) {
    // Промт правили в портале: новая версия от сида, один раз на метку seedRev (аудит текстов 2026-10-15).
    const mark = `seed:${seedRev}`;
    const applied = await prisma.artPromptVersion.findFirst({ where: { promptId: p.id, changeSummary: { startsWith: mark } }, select: { id: true } });
    const same = existing.text === rest.text && (existing.system ?? null) === (rest.system ?? null);
    if (!applied && !same) {
      const last = existing.versions[0];
      let next = last.version + 1;
      const ops = [];
      // Текущий текст расходится с последней версией (правка мимо UI) — сначала сохраняем его снимком.
      if (last.text !== existing.text || (last.system ?? null) !== (existing.system ?? null)) {
        ops.push(prisma.artPromptVersion.create({ data: { promptId: p.id, version: next++, system: existing.system, text: existing.text, changeSummary: "seed: снимок текущего текста перед обновлением" } }));
      }
      ops.push(prisma.artPrompt.update({ where: { id: p.id }, data: { system: rest.system, text: rest.text } }));
      ops.push(prisma.artPromptVersion.create({ data: { promptId: p.id, version: next, system: rest.system ?? null, text: rest.text, changeSummary: `${mark} — обновление из prompts.json (аудит текстов); прежний текст — версия ${next - 1}` } }));
      await prisma.$transaction(ops);
      promptsVersioned++;
    }
  }
}
let recipesPatched = 0;
for (const r of artCfg.recipes) {
  const ex = await prisma.artRecipe.findUnique({ where: { id: r.id }, select: { stageModels: true } });
  if (!ex) {
    await prisma.artRecipe.create({ data: r });
    continue;
  }
  const cur = ex.stageModels && typeof ex.stageModels === "object" ? ex.stageModels : {};
  const missing = Object.entries(r.stageModels ?? {}).filter(([k]) => !(k in cur));
  if (missing.length) {
    await prisma.artRecipe.update({ where: { id: r.id }, data: { stageModels: { ...cur, ...Object.fromEntries(missing) } } });
    recipesPatched++;
  }
}
console.log(`articles seed: ${artCfg.niches.length} niches, ${artCfg.profiles.length} profiles, ${artPrompts.sets.length} sets, ${artPrompts.prompts.length} prompts (${promptsCreated} new, ${promptsVersioned} new seed versions), ${artCfg.recipes.length} recipes (${recipesPatched} with new stage models)`);

// ───────────────────────────── Pin Blog Article (инфо-статьи) ─────────────────────────────
// Отдельный сервис рядом со «Статьями»: проект `blog`, свои слоты ключей, рецепт по умолчанию с промтами всех этапов
// (prisma/seed-data/blog/recipes.json). Идемпотентно: рецепт создаётся, если его нет; промты и параметры обновляются
// только пока их никто не правил в портале (нет BlogRecipeVersion) или при новой метке seedRev (новая версия).
const blogProject = await prisma.project.upsert({
  where: { slug: "blog" },
  update: {},
  create: { sectionId: pinterest.id, slug: "blog", name: "Pin Blog Article", description: "Инфо-статьи под Pinterest: исследование темы → адаптивный план → реальные фото по разделам → текст → проверка → WordPress", url: "/pinterest/blog", status: "ACTIVE", order: 4 },
});
const blogSlots = [
  { key: "text_main", name: "Тексты статьи (писатель)", capability: "CHAT", description: "План, секции, вступление и заключение, FAQ (модель по рецепту)", preferProviders: "openrouter,laozhang,openai" },
  { key: "text_fast", name: "Быстрые шаги", capability: "CHAT", description: "Исследование темы, починка меты, категория WordPress (gemini-2.5-flash по рецепту)", preferProviders: "openrouter,laozhang,openai" },
  { key: "vision", name: "Оценка фото (vision)", capability: "CHAT", description: "Релевантность кадра разделу статьи, качество, настоящее ли фото", preferProviders: "openrouter,laozhang,openai" },
  { key: "photo_dfs", name: "Поиск фото (DataForSEO)", capability: "SEO_DATA", description: "Google Images через DataForSEO — основной источник реальных фото", preferProviders: "dataforseo" },
  { key: "photo_serp", name: "Поиск фото (SerpAPI)", capability: "SERP", description: "Запасной источник Google Images", preferProviders: "serpapi" },
  { key: "serp_organic", name: "Выдача Google (SerpAPI)", capability: "SERP", description: "People Also Ask и заголовки топа для исследования темы (необязательно, включается в рецепте)", preferProviders: "serpapi" },
];
for (const sl of blogSlots) {
  await prisma.slot.upsert({ where: { projectId_key: { projectId: blogProject.id, key: sl.key } }, update: { preferProviders: sl.preferProviders }, create: { ...sl, projectId: blogProject.id } });
}
{
  const blogSeed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "seed-data", "blog", "recipes.json"), "utf8"));
  let created = 0, updated = 0;
  for (const r of blogSeed.recipes) {
    const { seedRev, ...data } = r;
    const ex = await prisma.blogRecipe.findUnique({ where: { id: r.id }, select: { id: true, prompts: true, params: true, versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, changeSummary: true } } } });
    if (!ex) {
      await prisma.blogRecipe.create({ data });
      created++;
      continue;
    }
    const mark = `seed:${seedRev ?? 0}`;
    const applied = await prisma.blogRecipeVersion.findFirst({ where: { recipeId: r.id, changeSummary: { startsWith: mark } }, select: { id: true } });
    if (!ex.versions.length) {
      // Никто не правил в портале — подтягиваем свежие промты и параметры из сида (модели и настройки поиска не трогаем).
      await prisma.blogRecipe.update({ where: { id: r.id }, data: { prompts: r.prompts, params: r.params } });
      updated++;
    } else if (seedRev && !applied) {
      const next = ex.versions[0].version + 1;
      await prisma.$transaction([
        prisma.blogRecipeVersion.create({ data: { recipeId: r.id, version: next, prompts: ex.prompts, params: ex.params, changeSummary: "seed: снимок текущих промтов перед обновлением" } }),
        prisma.blogRecipe.update({ where: { id: r.id }, data: { prompts: r.prompts, params: r.params } }),
        prisma.blogRecipeVersion.create({ data: { recipeId: r.id, version: next + 1, prompts: r.prompts, params: r.params, changeSummary: `${mark} — обновление из recipes.json; прежние промты — версия ${next}` } }),
      ]);
      updated++;
    }
  }
  console.log(`blog seed: ${blogSeed.recipes.length} recipes (${created} new, ${updated} updated)`);
}

// Финансы Wexora: закрытый инструмент (PRIVATE_TOOLS), видят владелец и те, кому он выдал доступ.
const wexora = await prisma.section.findUnique({ where: { slug: "wexora" } });
await prisma.project.upsert({
  where: { slug: "finance" },
  update: {},
  create: { sectionId: wexora.id, slug: "finance", name: "Финансы", description: "Доходы и расходы по направлениям, кто что платил и кто кому должен", url: "/finance", status: "ACTIVE", order: 1 },
});
// Направления и категории — только в пустую базу, дальше правятся в настройках инструмента.
if ((await prisma.finDirection.count()) === 0) {
  const tree = [["Пинтерест", ["Кулинария", "Женское"]], ["Гемблинг", []], ["Укр сайты", []], ["Общее Wexora", []]];
  for (const [i, [name, kids]] of tree.entries()) {
    const d = await prisma.finDirection.create({ data: { name, order: i + 1 } });
    for (const [j, k] of kids.entries()) await prisma.finDirection.create({ data: { name: k, parentId: d.id, order: j + 1 } });
  }
}
// Категория → строка P&L (lib/finance/pnl.ts); kind выводится из строки.
const finCats = [
  ["Серверы и хостинг", "OPEX"], ["ИИ и API", "COGS"], ["Домены", "COGS"], ["Сервисы и подписки", "OPEX"],
  ["Реклама", "OPEX"], ["Люди и фриланс", "COGS"], ["Налоги и комиссии", "TAX"], ["Партнёрки", "REVENUE"], ["Продажа", "REVENUE"], ["Прочее", "OTHER"],
];
const pnlKind = { REVENUE: "INCOME", COGS: "EXPENSE", OPEX: "EXPENSE", TAX: "EXPENSE", OTHER: "ANY" };
if ((await prisma.finCategory.count()) === 0) {
  for (const [i, [name, pnl]] of finCats.entries()) await prisma.finCategory.create({ data: { name, pnl, kind: pnlKind[pnl], order: i + 1 } });
} else if ((await prisma.finCategory.count({ where: { pnl: { not: "OPEX" } } })) === 0) {
  // Категории созданы до появления строк P&L (все OPEX по умолчанию): разложить один раз, дальше правится в настройках.
  for (const [name, pnl] of finCats) {
    const n = await prisma.finCategory.updateMany({ where: { name }, data: { pnl, kind: pnlKind[pnl] } });
    if (!n.count && pnl === "TAX") await prisma.finCategory.create({ data: { name, pnl, kind: "EXPENSE", order: 7 } });
  }
  await prisma.finCategory.updateMany({ where: { kind: "INCOME", pnl: "OPEX" }, data: { pnl: "REVENUE" } });
}
// ───────────────────────────── DeepL Articler (раздел Discovery) ─────────────────────────────
// Пакетная адаптация статей WP: цепочка переводов DeepL → H2 → постредактура → ключи. Ключи DeepL — в настройках
// инструмента (DeeplKey), редактура — слот text_main (OpenRouter). Промты и сценарии — только если их ещё нет.
const discovery = await prisma.section.findUnique({ where: { slug: "discovery" } });
if (discovery) {
  const deeplProject = await prisma.project.upsert({
    where: { slug: "deepl" },
    update: {},
    create: { sectionId: discovery.id, slug: "deepl", name: "DeepL Articler", description: "Пакетная адаптация статей WordPress: перевод DeepL по цепочке языков, H2, постредактура, ключи, публикация", url: "/discovery/deepl", status: "ACTIVE", order: 1 },
  });
  await prisma.slot.upsert({
    where: { projectId_key: { projectId: deeplProject.id, key: "text_main" } },
    update: { preferProviders: "openrouter" },
    create: { projectId: deeplProject.id, key: "text_main", name: "Редактура (OpenRouter)", capability: "CHAT", description: "H2, постредактура после перевода, добор ключей", preferProviders: "openrouter" },
  });
  const deeplSeed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "seed-data", "deepl", "prompts.json"), "utf8"));
  for (const p of deeplSeed.prompts) await prisma.deeplPrompt.upsert({ where: { id: p.id }, update: {}, create: p });
  for (const s of deeplSeed.scenarios) await prisma.deeplScenario.upsert({ where: { id: s.id }, update: {}, create: s });
  console.log(`deepl seed: ${deeplSeed.prompts.length} prompts, ${deeplSeed.scenarios.length} scenarios`);
}
// ───────────────────────────── Трафик сайтов (Google Analytics 4) ─────────────────────────────
// Свои аккаунты Google подключаются внутри инструмента (OAuth / сервисный аккаунт), слоты ключей ИИ не нужны.
const analyticsSection = await prisma.section.findUnique({ where: { slug: "analytics" } });
if (analyticsSection) {
  await prisma.project.upsert({
    where: { slug: "analytics" },
    update: {},
    create: { sectionId: analyticsSection.id, slug: "analytics", name: "Трафик сайтов", description: "Все аккаунты Google Analytics в одном кабинете: визиты, страницы, источники, рост и падение, сравнение периодов, группы сайтов", url: "/analytics", status: "ACTIVE", order: 1 },
  });
}
console.log("seed done");
await prisma.$disconnect();
