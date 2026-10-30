/**
 * Кто и что собирает просмотры у конкурентов: персоны и типы событий за 30 дней по выгрузке views-collect.ts.
 * 1) LLM по заголовку называет героев статьи и тип события; 2) считаем статьи и просмотры по персоне и по событию;
 * 3) пишем статистику в существующие сущности (compStats) и готовим файл новых сущностей для import-expansion.ts.
 * Lux FM прячет часть счётчиков (показывает 0) — нули Lux считаем «нет данных», статью учитываем, просмотры нет.
 * 4) --new: файл new-entities.json — персоны, которые собирают просмотры, но мы их не отслеживаем (варианты написания от LLM).
 * Запуск: npx tsx scripts/news/views-analyze.ts <month.jsonl> <outDir> [--write] [--new]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { chatJson } from "@/lib/news/llm";
import { heroSkeleton } from "@/lib/news/merge";
import { parseSettings, SLOT_CLASSIFY } from "@/lib/news/types";

type Row = { site: string; url: string; title: string; publishedAt: string; views: number };
type Person = { name: string; kind: string };
type Tagged = Row & { v: number | null; persons: Person[]; event: string };
type Origin = "ua" | "world";

export const EVENTS: Record<string, string> = {
  birth: "Рождение, беременность",
  divorce: "Развод, расставание",
  wedding: "Свадьба, помолвка",
  romance: "Новый роман, отношения",
  family: "Дети, родители, семья",
  body: "Тело, внешность, похудение, пластика",
  health: "Здоровье, болезнь, операция",
  look: "Образ, наряд, выход в свет",
  scandal: "Скандал, конфликт, хейт",
  confession: "Откровения, интервью, признание",
  career: "Работа, шоу, концерт, проект",
  money: "Деньги, дом, имущество",
  war: "Война, армия, волонтёрство, позиция",
  death: "Смерть, траур",
  other: "Другое",
};
const KINDS: Record<string, string> = { ua_star: "украинская звезда", world_star: "мировая звезда", ua_blogger: "украинский блогер", world_blogger: "мировой блогер", royal: "королевская семья", sport: "спортсмен", politic: "политик", other: "другое" };

const SYSTEM = `Ти аналітик українського жіночого медіа. Тобі дають заголовки статей розділу «шоубіз/зірки» українських сайтів.
Для кожного заголовка визнач:
- persons: 0–3 людини, ПРО КОГО стаття (головні герої, не згадані побіжно). Ім'я повністю, як пишуть українські медіа: «Катерина Тишкевич», «Кім Кардаш'ян», «MamaRika» (псевдонім як є). Якщо в заголовку лише прізвище чи «дружина X» — назви, кого саме, лише якщо впевнений; інакше не додавай. Для кожної kind: ${Object.keys(KINDS).join(" | ")} (ua_blogger/world_blogger — блогери, тіктокери, інфлюенсери; ua_star — актори, співаки, ведучі України).
- event: один код типу події: ${Object.entries(EVENTS).map(([k, v]) => `${k} (${v})`).join("; ")}.
Поверни лише JSON: {"items":[{"i":0,"persons":[{"name":"…","kind":"ua_star"}],"event":"birth"}]}`;

/** Ключ персоны: скелет каждого слова (транслит, без гласных) — «Кім Кардаш'ян» = «Ким Кардашьян» = «Kim Kardashian». */
const personKey = (name: string) => name.split(/[\s\-–]+/).filter((t) => t.length > 1).map((t) => heroSkeleton(t)).filter(Boolean).join(":");

async function main() {
  const [file, outDir] = process.argv.slice(2);
  const write = process.argv.includes("--write");
  const makeNew = process.argv.includes("--new");
  const rows = [...new Map(readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row).map((r) => [r.url, r])).values()];
  const p = await prisma.newsProject.findFirstOrThrow({ where: { siteUrl: { contains: "beautydaily" } } });
  const s = parseSettings(p.settings);
  let cost = 0;
  const ctx = { userId: p.createdById!, teamId: p.teamId, runId: "views-analyze", classifyModel: s.classifyModel, embedModel: s.embedModel, onCost: (u: number) => (cost += u) };

  // Разметка заголовков — с кэшем, чтобы повторный запуск не платил заново.
  const cacheFile = `${outDir}/tags.json`;
  const cache: Record<string, { persons: Person[]; event: string }> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const todo = rows.filter((r) => !cache[r.url]);
  const batches: Row[][] = [];
  for (let i = 0; i < todo.length; i += 40) batches.push(todo.slice(i, i + 40));
  for (let i = 0; i < batches.length; i += 4) {
    await Promise.all(batches.slice(i, i + 4).map(async (b) => {
      try {
        const j = await chatJson(ctx, SLOT_CLASSIFY, SYSTEM, b.map((r, k) => `${k}. ${r.title}`).join("\n"), s.classifyModel, 4000, 120_000, 0);
        for (const it of (j.items as { i: number; persons?: Person[]; event?: string }[]) ?? []) {
          const r = b[it.i];
          if (r) cache[r.url] = { persons: (it.persons ?? []).filter((x) => x?.name).slice(0, 3), event: EVENTS[it.event ?? ""] ? it.event! : "other" };
        }
      } catch (e) {
        console.error("batch", String((e as Error).message).slice(0, 100));
      }
    }));
    writeFileSync(cacheFile, JSON.stringify(cache));
    console.log(`разметка ${Math.min(i + 4, batches.length)}/${batches.length}, $${cost.toFixed(3)}`);
  }

  // Русские версии статей (у 24 Канала каждая новость выходит дважды) не считаем: иначе статьи о герое удваиваются.
  const russian = (t: string) => /[ыэъё]/i.test(t);
  const tagged: Tagged[] = rows.filter((r) => cache[r.url] && !russian(r.title)).map((r) => ({ ...r, v: r.site === "lux.fm" && !r.views ? null : r.views, ...cache[r.url] }));
  const siteList = [...new Set(tagged.map((r) => r.site))].sort();
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
  // Масштаб сайтов разный (у TSN медиана в тысячи, у 24 Канала в десятки) — индекс = просмотры / медиана сайта.
  const siteMedian = Object.fromEntries(siteList.map((st) => [st, median(tagged.filter((r) => r.site === st && r.v != null).map((r) => r.v!))]));

  // Сопоставление с нашими сущностями: полный ключ имени или любого варианта из двух слов и больше, либо один псевдоним.
  const ents = await prisma.newsEntity.findMany({ where: { projectId: p.id } });
  const entByKey = new Map<string, (typeof ents)[number]>();
  for (const e of ents) for (const n of [e.name, ...((e.aliases as string[]) ?? [])]) {
    const k = personKey(n);
    if (k && (k.includes(":") || (n.trim().split(/\s+/).length === 1 && n.length >= 5))) entByKey.set(k, e);
  }
  // «Чоловік Федишин», «донька Кароль» — не персона, а роль: такие упоминания не считаем.
  const ROLE = /^(чоловік|дружина|син|донька|дочка|мама|мати|батько|тато|брат|сестра|кохан|наречен|колишн|онук|бабус|дідус)/i;
  for (const r of tagged) r.persons = r.persons.filter((x) => !ROLE.test(x.name.trim()));
  const resolve = makeResolver(tagged.flatMap((r) => r.persons.map((x) => x.name)), entByKey);

  type Agg = { key: string; entityId: string | null; names: Map<string, number>; kinds: Map<string, number>; articles: number; views: number; index: number; sites: Record<string, { n: number; v: number }>; events: Record<string, number>; top: Tagged | null };
  const people = new Map<string, Agg>();
  for (const r of tagged) {
    // Один человек в статье считается один раз, даже если LLM назвал его двумя вариантами («Оля» и «Ольга Полякова»).
    const inArticle = new Set<string>();
    for (const ps of r.persons) {
      const key = resolve(ps.name);
      if (!key || inArticle.has(key)) continue;
      inArticle.add(key);
      const a = people.get(key) ?? { key, entityId: key.startsWith("e:") ? key.slice(2) : null, names: new Map(), kinds: new Map(), articles: 0, views: 0, index: 0, sites: {}, events: {}, top: null };
      a.names.set(ps.name, (a.names.get(ps.name) ?? 0) + 1);
      a.kinds.set(ps.kind, (a.kinds.get(ps.kind) ?? 0) + 1);
      a.articles++;
      a.views += r.v ?? 0;
      a.index += r.v != null && siteMedian[r.site] ? r.v / siteMedian[r.site] : 0;
      const st = (a.sites[r.site] ??= { n: 0, v: 0 });
      st.n++;
      st.v += r.v ?? 0;
      a.events[r.event] = (a.events[r.event] ?? 0) + 1;
      if (r.v != null && (!a.top || (a.top.v ?? 0) < r.v)) a.top = r;
      people.set(key, a);
    }
  }
  const best = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";
  const ranked = [...people.values()].filter((a) => a.articles >= 2).sort((x, y) => y.views - x.views);

  // Украинец или иностранец: по группе нашей сущности, потом по типу от LLM; спортсменов, политиков и «другое» уточняет LLM (кэш origin.json).
  const entGrp = (a: Agg) => (a.entityId ? ents.find((x) => x.id === a.entityId)?.grp ?? "" : "");
  const quick = (a: Agg): Origin | null => {
    const g = entGrp(a);
    if (g.startsWith("ua_")) return "ua";
    if (g.startsWith("world") || g === "royal") return "world";
    const k = best(a.kinds);
    return k.startsWith("ua_") ? "ua" : k.startsWith("world_") || k === "royal" ? "world" : null;
  };
  const originFile = `${outDir}/origin.json`;
  const originCache: Record<string, Origin> = existsSync(originFile) ? JSON.parse(readFileSync(originFile, "utf8")) : {};
  const unsure = ranked.filter((a) => !quick(a) && !originCache[best(a.names)]).map((a) => best(a.names));
  for (let i = 0; i < unsure.length; i += 60) {
    const b = unsure.slice(i, i + 60);
    try {
      const j = await chatJson(ctx, SLOT_CLASSIFY, `Для кожної людини скажи, чи вона з України (ua), чи іноземна (world). Українські спортсмени, політики, військові, блогери — ua. Поверни лише JSON: {"items":[{"i":0,"o":"ua"}]}`, b.map((n, k) => `${k}. ${n}`).join("\n"), s.classifyModel, 2000, 120_000, 0);
      for (const it of (j.items as { i: number; o?: string }[]) ?? []) if (b[it.i] && (it.o === "ua" || it.o === "world")) originCache[b[it.i]] = it.o;
    } catch (e) {
      console.error("origin", String((e as Error).message).slice(0, 100));
    }
  }
  writeFileSync(originFile, JSON.stringify(originCache));
  const originOf = (a: Agg): Origin | null => quick(a) ?? originCache[best(a.names)] ?? null;

  // События отдельно по украинцам и иностранцам: статья про украинца (хотя бы один герой) — украинская, иначе про иностранца.
  const articleOrigin = (r: Tagged): Origin | null => {
    const os = r.persons.map((x) => people.get(resolve(x.name))).filter((a): a is Agg => !!a).map(originOf);
    return os.includes("ua") ? "ua" : os.includes("world") ? "world" : null;
  };
  const tOrigin = new Map(tagged.map((r) => [r.url, articleOrigin(r)]));
  const eventStat = (rs: Tagged[]) => {
    const withV = rs.filter((r) => r.v != null);
    return { articles: rs.length, views: withV.reduce((x, r) => x + r.v!, 0), avg: withV.length ? Math.round(withV.reduce((x, r) => x + r.v!, 0) / withV.length) : 0, index: withV.length ? +(withV.reduce((x, r) => x + r.v! / (siteMedian[r.site] || 1), 0) / withV.length).toFixed(2) : 0 };
  };
  const events = Object.keys(EVENTS).map((k) => {
    const rs = tagged.filter((r) => r.event === k);
    return { code: k, label: EVENTS[k], ...eventStat(rs), ua: eventStat(rs.filter((r) => tOrigin.get(r.url) === "ua")), world: eventStat(rs.filter((r) => tOrigin.get(r.url) === "world")) };
  }).sort((x, y) => y.index - x.index);

  const period = `${tagged.map((r) => r.publishedAt).sort()[0]?.slice(0, 10)} — ${tagged.map((r) => r.publishedAt).sort().at(-1)?.slice(0, 10)}`;
  const people2 = ranked.map((a, i) => {
    const e = a.entityId ? ents.find((x) => x.id === a.entityId) ?? null : null;
    return {
      rank: i + 1, name: e?.name ?? best(a.names), kind: best(a.kinds), origin: originOf(a), entityId: e?.id ?? null, entityGrp: e?.grp ?? null, tracked: !!e,
      articles: a.articles, views: a.views, avg: Math.round(a.views / a.articles), index: +a.index.toFixed(1),
      sites: a.sites, events: Object.entries(a.events).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => ({ code: k, label: EVENTS[k], n })),
      top: a.top ? { title: a.top.title, url: a.top.url, site: a.top.site, views: a.top.v } : null,
    };
  });
  const report = { period, sites: siteList.map((st) => ({ site: st, articles: tagged.filter((r) => r.site === st).length, median: siteMedian[st] })), articles: tagged.length, people: people2, events, topArticles: tagged.filter((r) => r.v != null).sort((x, y) => (y.v! / (siteMedian[y.site] || 1)) - (x.v! / (siteMedian[x.site] || 1))).slice(0, 40).map((r) => ({ site: r.site, title: r.title, url: r.url, views: r.v, index: +(r.v! / (siteMedian[r.site] || 1)).toFixed(1), event: EVENTS[r.event], origin: tOrigin.get(r.url) ?? null, persons: r.persons.map((x) => x.name) })) };
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 1));
  const csv = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  writeFileSync(`${outDir}/people.csv`, "﻿" + [["#", "Персона", "Кто", "Отслеживаем", "Статей", "Просмотров", "В среднем", "Индекс", ...siteList.map((x) => `${x}: статей/просм.`), "Главные события", "Лучшая статья", "Её просмотры"].map(csv).join(";"),
    ...people2.map((x) => [x.rank, x.name, KINDS[x.kind] ?? x.kind, x.tracked ? "да" : "нет", x.articles, x.views, x.avg, x.index, ...siteList.map((st) => (x.sites[st] ? `${x.sites[st].n} / ${x.sites[st].v}` : "")), x.events.map((e) => `${e.label} (${e.n})`).join(", "), x.top?.title, x.top?.views].map(csv).join(";"))].join("\n"));
  console.log(`статей ${tagged.length}, персон ${people2.length}, из них уже отслеживаем ${people2.filter((x) => x.tracked).length}; LLM $${cost.toFixed(3)}`);

  // В отслеживание: не политики и не те, о ком писали почти только из-за смерти (будущих новостей о них не будет).
  const deathShare = (x: (typeof people2)[number]) => (x.events.find((e) => e.code === "death")?.n ?? 0) / x.articles;
  if (makeNew) await newEntities(ctx, s.classifyModel, people2.filter((x) => !x.tracked && x.articles >= 4 && x.kind !== "politic" && deathShare(x) < 0.5).slice(0, 120), `${outDir}/new-entities.json`);
  console.log(`LLM всего $${cost.toFixed(3)}`);
  if (!write) return;
  // Статистика в наши сущности; у сущностей без статей за период — обнуляем, чтобы не висели старые цифры.
  const at = new Date();
  await prisma.newsEntity.updateMany({ where: { projectId: p.id }, data: { compStats: Prisma.DbNull, compStatsAt: at } });
  for (const x of people2.filter((y) => y.entityId)) {
    await prisma.newsEntity.update({ where: { id: x.entityId! }, data: { compStats: { period, rank: x.rank, articles: x.articles, views: x.views, avg: x.avg, index: x.index, sites: x.sites, events: x.events, top: x.top }, compStatsAt: at } });
  }
  console.log("compStats записаны");
  // Весь рейтинг — на страницу «Просмотры» (Discover → Новости).
  await prisma.newsProject.update({ where: { id: p.id }, data: { viewsReport: report as unknown as Prisma.InputJsonValue, viewsReportAt: at } });
  console.log("рейтинг записан в проект");
}

main().finally(() => prisma.$disconnect());

/**
 * Один человек — один ключ. Наша сущность («e:id») по полному ключу имени; иначе фамилия + совместимое имя:
 * «Оля» и «Ольга» (скелеты «l» и «lh») — один человек, «Кім» и «Кортні» Кардаш'ян («km», «krtn») — разные.
 * Одна фамилия без имени («Сумська») присоединяется к единственному человеку с этой фамилией; если их несколько — отдельно.
 */
function makeResolver(names: string[], entByKey: Map<string, { id: string }>) {
  const parts = (n: string) => {
    const t = personKey(n).split(":").filter(Boolean);
    return { key: t.join(":"), last: t.at(-1) ?? "", first: t.length > 1 ? t[0] : "" };
  };
  const fits = (a: string, b: string) => {
    const n = Math.min(2, a.length, b.length);
    return n > 0 && a.slice(0, n) === b.slice(0, n);
  };
  const ents = [...entByKey.entries()].map(([k, e]) => ({ ...parts(k.split(":").join(" ")), key: k, id: e.id }));
  const ofEntity = (x: ReturnType<typeof parts>) =>
    entByKey.get(x.key)?.id ?? ents.find((e) => e.last === x.last && e.first && x.first && fits(e.first, x.first))?.id ?? null;
  // Кластеры по фамилии для тех, кого нет среди сущностей.
  const clusters = new Map<string, { first: string; id: string }[]>();
  for (const n of [...new Set(names)]) {
    const x = parts(n);
    if (!x.last || !x.first || ofEntity(x)) continue;
    const list = clusters.get(x.last) ?? [];
    if (!list.some((c) => fits(c.first, x.first))) list.push({ first: x.first, id: `n:${x.last}:${x.first}` });
    clusters.set(x.last, list);
  }
  return (n: string) => {
    const x = parts(n);
    if (!x.last) return "";
    const e = ofEntity(x);
    if (e) return `e:${e}`;
    const list = clusters.get(x.last) ?? [];
    if (x.first) return list.find((c) => fits(c.first, x.first))?.id ?? `n:${x.last}:${x.first}`;
    // Только фамилия или псевдоним: к единственному человеку с этой фамилией (наша сущность или кластер).
    const byEnt = [...new Set(ents.filter((e2) => e2.last === x.last && e2.first).map((e2) => e2.id))];
    if (byEnt.length === 1 && !list.length) return `e:${byEnt[0]}`;
    if (list.length === 1 && !byEnt.length) return list[0].id;
    return `n:${x.last}`;
  };
}

/** Новые сущности в формате import-expansion.ts: имя, варианты написания (укр/рус/лат, фамилия), группа, вес по месту в рейтинге. */
async function newEntities(ctx: Parameters<typeof chatJson>[0], model: string | undefined, list: { rank: number; name: string; kind: string; articles: number; views: number }[], out: string) {
  const sys = `Для кожної людини дай варіанти написання, за якими її знаходять у заголовках: українською, російською, латиницею, окремо прізвище (якщо воно не загальне слово), псевдонім. 3–6 варіантів. І групу: ua_top (українська зірка, яку знають усі), ua_second (українські шоу, другий ряд), ua_blogger (український блогер, тіктокер), world (мировая звезда), world_blogger (світовий блогер), royal (королівська родина), sport (спортсмен).
Поверни лише JSON: {"items":[{"i":0,"name":"як пишуть українські медіа","aliases":["…"],"grp":"ua_top"}]}`;
  const items: { name: string; type: string; grp: string; weight: number; aliases: string[] }[] = [];
  for (let i = 0; i < list.length; i += 30) {
    const b = list.slice(i, i + 30);
    const j = await chatJson(ctx, SLOT_CLASSIFY, sys, b.map((x, k) => `${k}. ${x.name} (${KINDS[x.kind] ?? x.kind})`).join("\n"), model, 4000, 120_000, 0);
    for (const it of (j.items as { i: number; name?: string; aliases?: string[]; grp?: string }[]) ?? []) {
      const x = b[it.i];
      if (!x) continue;
      // Вес по месту в рейтинге просмотров: топ-30 — первый ряд (каждый прогон запрос в Google News), дальше ниже.
      const weight = x.rank <= 30 ? 1.6 : x.rank <= 80 ? 1.3 : 1.1;
      items.push({ name: it.name || x.name, type: "person", grp: it.grp || "", weight, aliases: [...new Set([x.name, ...(it.aliases ?? [])].filter((a) => a && a.length > 2))] });
    }
  }
  writeFileSync(out, JSON.stringify({ about: "Персоны с наибольшими просмотрами у конкурентов, которых мы ещё не отслеживали (views-analyze.ts)", sources: [], entities: items }, null, 1));
  console.log(`новых сущностей: ${items.length} → ${out}`);
}
