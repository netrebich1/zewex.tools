import { PrismaClient } from "@prisma/client";
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

for (const p of providers) {
  await prisma.provider.upsert({ where: { slug: p.slug }, update: { name: p.name, baseUrl: p.baseUrl, docsUrl: p.docsUrl, order: p.order }, create: p });
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
  await prisma.section.upsert({ where: { slug: s.slug }, update: { order: s.order }, create: s });
}
console.log("seed done");
await prisma.$disconnect();
