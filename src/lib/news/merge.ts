import { prisma } from "@/lib/db";
import { chatJson, withOp, type AiCtx } from "./llm";
import { cos, pack, unpack } from "./vec";
import { SLOT_CLASSIFY, type NewsSettings, type RunStats } from "./types";

/**
 * Склейка дублей кластеров. Первичная кластеризация (clusterStep) берёт порог по смыслу заголовка, а одна и та же
 * новость у разных изданий пересказана разными словами (сходство 0.70–0.89), при этом разные истории одного героя
 * бывают на 0.77–0.80 (Кардаш'ян в Римі и в Мехіко). Поэтому пары-кандидаты с общим героем решает модель:
 * «одно событие / один повод (интервью, пост) или разные». Ответ «разные» запоминается в notSame обоих кластеров.
 */

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "e", ё: "e", ж: "zh", з: "z", и: "i", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "u", я: "a",
};

/** «Кардаш'ян» / «Kardashian» → «krdshn», «Горова» / «Gorova» → «hrv»: согласные фамилии в общем виде латиницей. */
export function heroSkeleton(name: string | null | undefined): string {
  if (!name) return "";
  const last = name.toLowerCase().replace(/[’'ʼ`"«»]/g, "").split(/[\s\-–]+/).filter((t) => t.length > 1).pop() ?? "";
  const lat = [...last].map((ch) => CYR[ch] ?? ch).join("");
  return lat
    .replace(/[^a-z]/g, "")
    .replace(/kh|gh/g, "h")
    .replace(/g/g, "h")
    .replace(/ph/g, "f")
    .replace(/w/g, "v")
    .replace(/ck|c|q/g, "k")
    .replace(/x/g, "ks")
    .replace(/[aeiouyj]/g, "")
    .replace(/(.)\1+/g, "$1");
}

function lev1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ra = a.slice(i + (a.length >= b.length ? 1 : 0)), rb = b.slice(i + (b.length >= a.length ? 1 : 0));
  return ra === rb;
}

type Ent = { name?: string; orig?: string };
function heroes(c: { mainEntityName: string | null; entities: unknown }): string[] {
  const out = new Set<string>();
  const add = (n?: string | null) => {
    const k = heroSkeleton(n);
    if (k.length >= 3) out.add(k);
  };
  add(c.mainEntityName);
  if (Array.isArray(c.entities)) for (const e of c.entities as Ent[]) (add(e.name), add(e.orig));
  return [...out];
}
const shareHero = (a: string[], b: string[]) => a.some((x) => b.some((y) => (x.length >= 5 ? lev1(x, y) : x === y)));

const SYSTEM = `Ты выпускающий редактор новостного сайта. Тебе дают пары карточек (A и B): заголовки и начало текста публикаций.
Для каждой пары сначала кратко (до 8 слов) назови конкретный информационный повод A и повод B, потом реши same.
same=true только если редакция напишет про A и B ОДНУ статью, потому что повод один и тот же: то же интервью или эфир,
тот же пост в соцсетях, то же заявление, тот же выход в свет на одном мероприятии, тот же релиз или кампания, то же событие.
Разные подробности из одного интервью или одного события — тоже same=true: если в A и B упомянуто одно и то же интервью,
подкаст, шоу или эфир (тот же ведущий или канал) — same=true, даже если герой рассказывает там о разных темах.
same=false, если: герой тот же, но повод другой (другой пост, другой выход, другое заявление, другой день); общая только тема
(Хеллоуин, тренды, подборки) без общего конкретного события; разные люди с разными поводами; подборка или обзор против конкретной новости.
Сомневаешься — false.
Отдельно в showA и showB укажи, из какого интервью, подкаста, шоу или эфира взят материал (ведущий или канал), если это интервью; иначе пустая строка.
Ответ строго JSON: {"pairs":[{"pair":0,"a":"повод A","b":"повод B","showA":"","showB":"","same":false}]}`;

// Одно интервью (тот же ведущий или канал) у одного героя — одна статья, даже если издания взяли из него разные темы.
const SHOW_STOP = new Set(["youtube", "instagram", "tiktok", "telegram", "facebook", "podcast", "подкаст", "інтерв'ю", "інтервю", "интервью", "шоу", "канал", "ефір", "эфир"]);
const showWords = (v: unknown) =>
  typeof v === "string"
    ? v.split(/[\s,.;:!?«»"()\-–—/]+/).filter((w) => /^[A-ZА-ЯІЇЄҐ]/.test(w) && !SHOW_STOP.has(w.toLowerCase())).map(heroSkeleton).filter((k) => k.length >= 4)
    : [];
const sameShow = (a: unknown, b: unknown) => {
  const x = showWords(a), y = showWords(b);
  return x.length > 0 && x.some((k) => y.includes(k));
};

const HOST_RE = /(?:інтерв['’ʼ]?ю|интервью|подкаст\S*|шоу|ефір\S*|эфир\S*|YouTube-канал\S*|програм\S*|interview|podcast)\s+(?:(?:до|у|в|на|для|з|with|on|to)\s+)?([A-ZА-ЯІЇЄҐ][^\s,.;:!?«»"()]+(?:\s+[A-ZА-ЯІЇЄҐ][^\s,.;:!?«»"()]+){0,2})/g;
/** Скелеты фамилий ведущих интервью, упомянутых в тексте. */
export function interviewHosts(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HOST_RE)) {
    for (const w of m[1].split(/\s+/)) {
      if (SHOW_STOP.has(w.toLowerCase()) || /^youtube/i.test(w)) continue;
      const k = heroSkeleton(w);
      if (k.length >= 4) out.add(k);
    }
  }
  return [...out];
}

const isWork = (c: { status: string; starred: boolean; brief: string | null; angles: unknown }) => c.status === "in_work" || c.status === "published" || c.starred || !!c.brief || !!c.angles;

export async function mergeStep(projectId: string, ctx: AiCtx, s: NewsSettings, stats: RunStats, log: (m: string) => void, dry = false) {
  const since = new Date(Date.now() - s.clusterWindowHours * 3600_000);
  const cl = await prisma.newsCluster.findMany({
    where: { projectId, lastItemAt: { gte: since }, status: { not: "rejected" } },
    select: { id: true, title: true, titleUk: true, mainEntityName: true, entities: true, centroid: true, itemCount: true, notSame: true, status: true, starred: true, brief: true, angles: true, firstPublishedAt: true },
  });
  const v = cl.map((c) => unpack(c.centroid));
  const h = cl.map(heroes);
  const ns = cl.map((c) => new Set(Array.isArray(c.notSame) ? (c.notSame as string[]) : []));

  // Ведущие интервью из текстов публикаций («в інтерв'ю Раміні Есхакзай», «на YouTube-каналі Раміни Есхакзай»):
  // у одного героя одно и то же интервью — одна статья, модель тут ненадёжна (разные темы ответов считает разными новостями).
  const allItems = cl.length ? await prisma.newsItem.findMany({ where: { clusterId: { in: cl.map((c) => c.id) } }, select: { clusterId: true, lead: true } }) : [];
  const hostsBy = new Map<string, Set<string>>();
  for (const it of allItems) {
    if (!it.clusterId || !it.lead) continue;
    for (const k of interviewHosts(it.lead)) (hostsBy.get(it.clusterId) ?? hostsBy.set(it.clusterId, new Set()).get(it.clusterId)!).add(k);
  }
  const hosts = cl.map((c) => hostsBy.get(c.id) ?? new Set<string>());

  const auto: [number, number][] = [];
  const ask: { i: number; j: number; sim: number; hero: boolean }[] = [];
  for (let i = 0; i < cl.length; i++) {
    if (!v[i]) continue;
    for (let j = i + 1; j < cl.length; j++) {
      if (!v[j]) continue;
      if (isWork(cl[i]) && isWork(cl[j])) continue;
      const sim = cos(v[i]!, v[j]!);
      const hero = shareHero(h[i], h[j]);
      if (hero && sim >= 0.55 && [...hosts[i]].some((k) => hosts[j].has(k) && k !== heroSkeleton(cl[i].mainEntityName) && k !== heroSkeleton(cl[j].mainEntityName))) {
        auto.push([i, j]);
        continue;
      }
      if (ns[i].has(cl[j].id) || ns[j].has(cl[i].id)) continue;
      if (hero && sim >= 0.9) auto.push([i, j]);
      else if ((hero && sim >= 0.62) || sim >= 0.84) ask.push({ i, j, sim, hero });
    }
  }
  ask.sort((a, b) => b.sim - a.sim);
  const todo = ask.slice(0, 240);

  // Заголовки публикаций — модели нужно видеть, о чём пишут, а не только заголовок карточки.
  const ids = [...new Set(todo.flatMap((p) => [cl[p.i].id, cl[p.j].id]))];
  const items = ids.length ? await prisma.newsItem.findMany({ where: { clusterId: { in: ids } }, select: { clusterId: true, title: true, lead: true }, orderBy: { foundAt: "asc" } }) : [];
  const byC = new Map<string, { title: string; lead: string | null }[]>();
  for (const it of items) if (it.clusterId) byC.set(it.clusterId, [...(byC.get(it.clusterId) ?? []), it]);
  const desc = (k: number) => {
    const list = byC.get(cl[k].id) ?? [];
    const leads = [...new Set(list.map((x) => (x.lead ?? "").slice(0, 420)).filter((x) => x.length > 40))].slice(0, 2);
    return { titles: [...new Set([cl[k].titleUk ?? cl[k].title, ...list.slice(0, 3).map((x) => x.title)])].slice(0, 4), text: leads };
  };

  const same: [number, number][] = [...auto];
  const differ: [number, number][] = [];
  for (let b = 0; b < todo.length; b += 20) {
    const batch = todo.slice(b, b + 20);
    try {
      const r = await chatJson(withOp(ctx, "merge"), SLOT_CLASSIFY, SYSTEM, JSON.stringify(batch.map((p, n) => ({ pair: n, A: desc(p.i), B: desc(p.j) }))), ctx.classifyModel, 2500, 90_000, 0);
      const ans = new Map<number, boolean>();
      for (const x of Array.isArray(r.pairs) ? (r.pairs as { pair?: unknown; same?: unknown; showA?: unknown; showB?: unknown }[]) : []) ans.set(Number(x.pair), x.same === true || (!!batch[Number(x.pair)]?.hero && sameShow(x.showA, x.showB)));
      // Пара без ответа — не решена, спросим в следующий прогон.
      batch.forEach((p, n) => (ans.has(n) ? (ans.get(n) ? same : differ).push([p.i, p.j]) : undefined));
    } catch (e) {
      log(`склейка: пачка пропущена (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // «Разные» — запоминаем, чтобы не спрашивать каждый прогон.
  const addNs = new Map<number, Set<string>>();
  for (const [i, j] of differ) {
    (addNs.get(i) ?? addNs.set(i, new Set()).get(i)!).add(cl[j].id);
    (addNs.get(j) ?? addNs.set(j, new Set()).get(j)!).add(cl[i].id);
  }

  // Группы склейки без цепочек: карточка вливается только в ту, с которой у неё прямое «одна новость», и не вливается,
  // если модель сочла её другой новостью, чем уже принятая в группу. Цель — карточка в работе, иначе самая большая, иначе ранняя.
  const key = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`);
  const diffSet = new Set(differ.map(([i, j]) => key(i, j)));
  const adj = new Map<number, Set<number>>();
  for (const [i, j] of same) {
    (adj.get(i) ?? adj.set(i, new Set()).get(i)!).add(j);
    (adj.get(j) ?? adj.set(j, new Set()).get(j)!).add(i);
  }
  const pref = (a: number, b: number) => Number(isWork(cl[b])) - Number(isWork(cl[a])) || cl[b].itemCount - cl[a].itemCount || +cl[a].firstPublishedAt - +cl[b].firstPublishedAt;
  const taken = new Set<number>();
  const plan: { target: number; from: number[] }[] = [];
  for (const t of [...adj.keys()].sort(pref)) {
    if (taken.has(t)) continue;
    const from: number[] = [];
    for (const k of [...adj.get(t)!].sort(pref)) {
      if (taken.has(k) || isWork(cl[k]) || from.some((x) => diffSet.has(key(x, k)))) continue;
      from.push(k);
    }
    if (!from.length) continue;
    taken.add(t);
    for (const k of from) taken.add(k);
    plan.push({ target: t, from });
  }

  if (dry) {
    const t = (k: number) => (cl[k].titleUk ?? cl[k].title).slice(0, 80);
    for (const g of plan) log(`ГРУППА  ${t(g.target)}  ←  ${g.from.map(t).join("  ←  ")}`);
    for (const [i, j] of differ.slice(0, 25)) log(`DIFF  ${t(i)}  ||  ${t(j)}`);
    log(`пробно: авто ${auto.length}, спрошено ${todo.length} из ${ask.length}, одна новость ${same.length}, разные ${differ.length}, склеится карточек ${plan.reduce((n, g) => n + g.from.length, 0)}`);
    return;
  }

  let merged = 0;
  for (const { target, from } of plan) {
    const rows = await prisma.newsCluster.findMany({ where: { id: { in: [target, ...from].map((k) => cl[k].id) } } });
    const t = rows.find((r) => r.id === cl[target].id);
    if (!t) continue;
    const others = rows.filter((r) => r.id !== t.id);
    let vec = unpack(t.centroid);
    let n = t.itemCount;
    for (const o of others) {
      const ov = unpack(o.centroid);
      if (vec && ov) {
        const sum = new Float32Array(vec.length);
        for (let d = 0; d < vec.length; d++) sum[d] = vec[d] * n + ov[d] * o.itemCount;
        let len = 0;
        for (let d = 0; d < sum.length; d++) len += sum[d] * sum[d];
        len = Math.sqrt(len) || 1;
        for (let d = 0; d < sum.length; d++) sum[d] /= len;
        vec = sum;
      } else vec = vec ?? ov;
      n += o.itemCount;
    }
    // Избранное и ТЗ по сайтам склеенных карточек переходят к оставшейся (ТЗ сайта, который уже есть у неё, не дублируем).
    const starredFrom = others.find((o) => o.starred);
    const hasSites = new Set((await prisma.newsBrief.findMany({ where: { clusterId: t.id }, select: { site: true } })).map((b) => b.site));
    const moveBriefs = (await prisma.newsBrief.findMany({ where: { clusterId: { in: others.map((o) => o.id) } }, orderBy: { updatedAt: "desc" } })).filter((b) => (hasSites.has(b.site) ? false : (hasSites.add(b.site), true)));
    const keepNs = [...new Set([...(Array.isArray(t.notSame) ? (t.notSame as string[]) : []), ...others.flatMap((o) => (Array.isArray(o.notSame) ? (o.notSame as string[]) : []))])].slice(-300);
    await prisma.$transaction([
      prisma.newsItem.updateMany({ where: { clusterId: { in: others.map((o) => o.id) } }, data: { clusterId: t.id } }),
      prisma.newsBrief.updateMany({ where: { id: { in: moveBriefs.map((b) => b.id) } }, data: { clusterId: t.id } }),
      prisma.newsCluster.update({
        where: { id: t.id },
        data: {
          centroid: vec ? pack(vec) : null,
          itemCount: n,
          firstPublishedAt: new Date(Math.min(+t.firstPublishedAt, ...others.map((o) => +o.firstPublishedAt))),
          lastItemAt: new Date(Math.max(+t.lastItemAt, ...others.map((o) => +o.lastItemAt))),
          imageUrl: t.imageUrl ?? others.find((o) => o.imageUrl)?.imageUrl ?? null,
          ...(!t.starred && starredFrom ? { starred: true, starredById: starredFrom.starredById, starredAt: starredFrom.starredAt } : {}),
          notSame: keepNs,
        },
      }),
      prisma.newsCluster.deleteMany({ where: { id: { in: others.map((o) => o.id) } } }),
    ]);
    merged += others.length;
    for (const k of [target, ...from]) addNs.delete(k);
    if (merged <= 8) log(`склеено: «${(t.titleUk ?? t.title).slice(0, 60)}» ← ${others.length}`);
  }

  for (const [k, set] of addNs) {
    const cur = [...ns[k], ...set].slice(-300);
    await prisma.newsCluster.update({ where: { id: cl[k].id }, data: { notSame: cur } }).catch(() => undefined);
  }
  stats.clustersMerged = merged;
  if (todo.length || merged) log(`склейка дублей: проверено пар ${todo.length + auto.length}, склеено карточек ${merged}`);
}
