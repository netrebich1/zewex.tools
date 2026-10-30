"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { canManageProject, loadProjectFor } from "@/lib/news/access";
import { requestRun } from "@/lib/news/runs";
import { testTelegram } from "@/lib/news/pipeline";
import { buildSiteBrief, startSiteWork } from "@/lib/news/work";
import { fetchText } from "@/lib/news/fetch";
import { BASE_PATH, CATEGORIES, DEFAULT_SETTINGS, parseSettings, projectSites, siteHost, SOURCE_KINDS, TIERS, type NewsSettings } from "@/lib/news/types";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const list = (v: string) => v.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
const numOr = (v: string, d: number) => (v === "" || !Number.isFinite(Number(v.replace(",", "."))) ? d : Number(v.replace(",", ".")));
const done = () => revalidatePath(BASE_PATH, "layout");

// ───────── Прогон ─────────

export async function runNow(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const p = await loadProjectFor(me, str(f, "project"));
    const scope = str(f, "scope") || "all";
    const r = await requestRun(p.id, me.id, scope, canManageProject(me, p));
    if (!r.ok) return { error: r.error };
    done();
    return { ok: "Прогон поставлен в очередь — новые карточки появятся в ленте сами, страницу можно не обновлять" };
  } catch (e) {
    return fail(e);
  }
}

/** «+ ТЗ для сайта»: модель предлагает 3 угла под этот сайт (op=again — другие углы). */
export async function takeToWork(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const c = await prisma.newsCluster.findUniqueOrThrow({ where: { id: str(f, "id") } });
    await loadProjectFor(me, c.projectId);
    await startSiteWork(me.id, c.id, str(f, "site"), str(f, "op") === "again");
    done();
    return { ok: "Углы готовы — выберите один, и модуль соберёт ТЗ для этого сайта" };
  } catch (e) {
    return fail(e);
  }
}

/** ТЗ сайта по выбранному углу. */
export async function makeBriefAction(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const b = await prisma.newsBrief.findUniqueOrThrow({ where: { id: str(f, "brief") } });
    await loadProjectFor(me, b.projectId);
    await buildSiteBrief(me.id, b.id, Number(str(f, "idx")));
    done();
    return { ok: "ТЗ готово — новость перешла во вкладку «ТЗ готово». Скопируйте ТЗ и отдайте Claude" };
  } catch (e) {
    return fail(e);
  }
}

/** ТЗ сайта: отметить «опубликовано» / вернуть / удалить. */
export async function setBriefStatus(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const b = await prisma.newsBrief.findUniqueOrThrow({ where: { id: str(f, "brief") } });
    await loadProjectFor(me, b.projectId);
    const op = str(f, "op");
    if (op === "delete") await prisma.newsBrief.delete({ where: { id: b.id } });
    else if (op === "published" || op === "ready") {
      if (!b.brief) throw new Error("Сначала соберите ТЗ");
      await prisma.newsBrief.update({ where: { id: b.id }, data: { status: op } });
    } else throw new Error("Неизвестное действие");
    done();
    return { ok: op === "delete" ? "ТЗ для сайта удалено" : op === "published" ? "Отмечено: опубликовано" : "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}

export async function setClusterStatus(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const c = await prisma.newsCluster.findUniqueOrThrow({ where: { id: str(f, "id") } });
    await loadProjectFor(me, c.projectId);
    const status = str(f, "status");
    if (!["new", "in_work", "published", "rejected"].includes(status)) throw new Error("Неизвестный статус");
    await prisma.newsCluster.update({ where: { id: c.id }, data: { status } });
    done();
    return { ok: "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}

// ───────── Проект и настройки ─────────

export async function createProject(_p: FormState, f: FormData): Promise<FormState> {
  let id = "";
  try {
    const me = await requireUser();
    if (me.role !== "ADMIN") throw new Error("Новый проект создаёт администратор");
    const name = str(f, "name");
    const teamId = str(f, "teamId");
    if (!name) throw new Error("Укажите название (обычно домен сайта)");
    if (!teamId) throw new Error("Выберите команду, с ключей которой пойдёт расход");
    const p = await prisma.newsProject.create({ data: { name, teamId, siteUrl: str(f, "siteUrl"), siteAccessId: str(f, "siteAccessId") || null, settings: {}, createdById: me.id } });
    // Google Trends и раздел «Розваги» Google News нужны любому проекту — добавляем сразу.
    await prisma.newsSource.createMany({ data: [
      { projectId: p.id, kind: "trends", name: "Google Trends: Україна", url: "UA", tier: "competitor" },
      { projectId: p.id, kind: "gnews_topic", name: "Google News: Розваги (Україна)", url: "ENTERTAINMENT", tier: "competitor" },
    ] });
    id = p.id;
  } catch (e) {
    return fail(e);
  }
  done();
  redirect(`${BASE_PATH}/sources?project=${id}`);
}

const SETTING_NUMBERS: (keyof NewsSettings)[] = [
  "intervalMin", "maxAgeHours", "topN", "urgentScore", "minScore", "clusterSim", "clusterSimEntity", "clusterWindowHours", "embedMargin", "classifyPerDay", "monthlyBudgetUsd",
  "gnewsEntitiesPerQuery", "gnewsGroupsPerRun", "topEntityWeight", "autoSummaryPerDay",
];

/** Сайты для ТЗ: добавить, изменить, поднять выше, убрать (готовые ТЗ убранного сайта остаются). */
export async function saveSite(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const p = await loadProjectFor(me, str(f, "project"), true);
    const cur = parseSettings(p.settings);
    // Пока список пуст, в нём неявно стоит сайт проекта — делаем его явным, чтобы не потерять.
    const sites = [...projectSites(p, cur)];
    const op = str(f, "op");
    const host = str(f, "host");
    const idx = sites.findIndex((x) => x.host === host);
    const row = () => {
      const h = siteHost(str(f, "url"));
      if (!h || !h.includes(".")) throw new Error("Укажите адрес сайта, например site.ua");
      if (sites.some((x, i) => x.host === h && i !== idx)) throw new Error(`Сайт ${h} уже есть в списке`);
      return { host: h, name: str(f, "name") || h, about: str(f, "about") };
    };
    let msg = "Сохранено";
    if (op === "add") {
      sites.push(row());
      msg = "Сайт добавлен — кнопка «+ ТЗ» появится в карточках новостей";
    } else {
      if (idx < 0) throw new Error("Сайт не найден — обновите страницу");
      if (op === "update") {
        const next = row();
        // Сменили адрес — готовые ТЗ переезжают на новый, чтобы не потеряться.
        if (next.host !== host) await prisma.newsBrief.updateMany({ where: { projectId: p.id, site: host }, data: { site: next.host } });
        sites[idx] = next;
      } else if (op === "up" && idx > 0) [sites[idx - 1], sites[idx]] = [sites[idx], sites[idx - 1]];
      else if (op === "delete") {
        sites.splice(idx, 1);
        msg = "Сайт убран";
      }
    }
    await prisma.newsProject.update({ where: { id: p.id }, data: { settings: { ...cur, sites } as unknown as Prisma.InputJsonValue } });
    done();
    return { ok: msg };
  } catch (e) {
    return fail(e);
  }
}

export async function saveSettings(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const p = await loadProjectFor(me, str(f, "project"), true);
    const cur = parseSettings(p.settings);
    const next: Record<string, unknown> = { ...cur };
    for (const k of SETTING_NUMBERS) next[k] = numOr(str(f, k), cur[k] as number);
    for (const k of ["classifyModel", "embedModel", "briefModel", "hl", "gl", "ceid", "houseStyle", "siteAbout"] as const) next[k] = str(f, k);
    next.titleSuffix = String(f.get("titleSuffix") ?? "").trimEnd();
    for (const k of ["embedFilter", "autoProxy", "telegramAlerts"] as const) next[k] = f.get(k) === "on";
    next.targetCategories = f.getAll("targetCategories").map(String).filter((c) => (CATEGORIES as readonly string[]).includes(c) && c !== "other");
    for (const k of ["stopWords", "stopExceptions", "stopRubrics", "nicheWords", "gnewsQueries"] as const) {
      const raw = str(f, k);
      next[k] = raw ? list(raw) : DEFAULT_SETTINGS[k];
    }
    const settings = parseSettings(next);
    const token = str(f, "tgToken");
    const data: Prisma.NewsProjectUpdateInput = {
      name: str(f, "name") || p.name,
      siteUrl: str(f, "siteUrl"),
      siteAccessId: str(f, "siteAccessId") || null,
      isActive: f.get("isActive") === "on",
      settings: settings as unknown as Prisma.InputJsonValue,
      tgChatId: str(f, "tgChatId") || null,
      ...(token ? { tgTokenEnc: encryptSecret(token) } : {}),
      ...(f.get("tgClear") === "on" ? { tgTokenEnc: null, tgChatId: null } : {}),
      ...(!p.createdById ? { createdById: me.id } : {}),
    };
    if (me.role === "ADMIN" && str(f, "teamId")) data.teamId = str(f, "teamId");
    // Новый интервал действует сразу: следующий плановый прогон — от сейчас.
    if (settings.intervalMin !== cur.intervalMin) data.nextRunAt = new Date(Date.now() + settings.intervalMin * 60_000);
    await prisma.newsProject.update({ where: { id: p.id }, data });
    done();
    return { ok: "Настройки сохранены — действуют со следующего прогона" };
  } catch (e) {
    return fail(e);
  }
}

export async function testBot(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const p = await loadProjectFor(me, str(f, "project"), true);
    const r = await testTelegram(p.id);
    return r.ok ? { ok: "Сообщение отправлено — проверьте Telegram" } : { error: `Telegram: ${r.error}` };
  } catch (e) {
    return fail(e);
  }
}

// ───────── Источники ─────────

function sourceData(f: FormData) {
  const kind = str(f, "kind");
  if (!(SOURCE_KINDS as readonly string[]).includes(kind)) throw new Error("Выберите тип источника");
  const url = str(f, "url");
  if (!url) throw new Error(kind === "gnews_query" ? "Впишите запрос Google News" : "Впишите адрес ленты");
  if ((kind === "rss" || kind === "sitemap") && !/^https?:\/\//i.test(url)) throw new Error("Адрес ленты должен начинаться с http:// или https://");
  const tier = str(f, "tier");
  const cats = (k: string) => {
    const v = list(str(f, k)).map((x) => x.toLowerCase());
    return v.length ? v : Prisma.DbNull;
  };
  return {
    kind, url, name: str(f, "name") || url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80),
    tier: (TIERS as readonly string[]).includes(tier) ? tier : "competitor",
    lang: str(f, "lang") || (tier === "world" ? "en" : "uk"),
    weight: Math.min(2, Math.max(0.3, numOr(str(f, "weight"), 1))),
    profile: f.get("profile") === "on",
    viaProxy: f.get("viaProxy") === "on",
    intervalMin: str(f, "intervalMin") ? Math.max(10, Math.round(numOr(str(f, "intervalMin"), 40))) : null,
    includeCats: cats("includeCats"),
    excludeCats: cats("excludeCats"),
    includeUrls: cats("includeUrls"),
  };
}

export async function addSource(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const p = await loadProjectFor(me, str(f, "project"), true);
    const d = sourceData(f);
    const dup = await prisma.newsSource.findFirst({ where: { projectId: p.id, url: d.url } });
    if (dup) return { error: `Такой источник уже есть: «${dup.name}»` };
    await prisma.newsSource.create({ data: { projectId: p.id, ...d } });
    done();
    return { ok: `Источник «${d.name}» добавлен — опросится в ближайший прогон` };
  } catch (e) {
    return fail(e);
  }
}

export async function updateSource(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const src = await prisma.newsSource.findUniqueOrThrow({ where: { id: str(f, "id") } });
    await loadProjectFor(me, src.projectId, true);
    const op = str(f, "op");
    if (op === "toggle") await prisma.newsSource.update({ where: { id: src.id }, data: { isActive: !src.isActive } });
    else if (op === "delete") await prisma.newsSource.delete({ where: { id: src.id } });
    else if (op === "save") await prisma.newsSource.update({ where: { id: src.id }, data: sourceData(f) });
    else if (op === "test") {
      const { fetchSource, activeProxies } = await import("@/lib/news/sources");
      const p = await prisma.newsProject.findUniqueOrThrow({ where: { id: src.projectId } });
      const r = await fetchSource({ id: src.id, kind: src.kind, url: src.url, viaProxy: src.viaProxy, lang: src.lang }, parseSettings(p.settings), await activeProxies());
      if (r.error) return { error: `${src.name}: ${r.error}${r.viaProxy ? " (через прокси)" : ""}` };
      const newest = r.items.map((i) => i.publishedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
      const sample = r.items.slice(0, 3).map((i) => `«${i.title.slice(0, 70)}»`).join(", ");
      return { ok: `${src.name}: ${r.items.length || r.trends.length} материалов${newest ? `, самый свежий ${new Date(newest).toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" })}` : ""}${r.viaProxy ? ", через прокси" : ""}. ${sample}` };
    }
    done();
    return { ok: "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}

// ───────── Сущности ─────────

/** Строки «Имя | тип | вес | варианты через запятую | группа» (кроме имени всё можно не писать). */
export async function addEntities(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const p = await loadProjectFor(me, str(f, "project"), true);
    const lines = str(f, "lines").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("Впишите хотя бы одну строку");
    const existing = new Set((await prisma.newsEntity.findMany({ where: { projectId: p.id }, select: { name: true } })).map((e) => e.name.toLowerCase()));
    let added = 0;
    let skipped = 0;
    for (const line of lines) {
      const [name, type, weight, aliases, grp] = line.split("|").map((x) => x.trim());
      if (!name || existing.has(name.toLowerCase())) {
        skipped++;
        continue;
      }
      await prisma.newsEntity.create({
        data: {
          projectId: p.id, name, type: ["person", "brand", "event", "trend", "product"].includes(type) ? type : "person", weight: Math.min(2, Math.max(0.3, numOr(weight ?? "", 1))),
          aliases: list(aliases ?? "").map((a) => a.replace(/\s+/g, " ")), grp: grp ?? "",
        },
      });
      existing.add(name.toLowerCase());
      added++;
    }
    done();
    return { ok: `Добавлено ${added}${skipped ? `, пропущено ${skipped} (уже есть или пустое имя)` : ""}` };
  } catch (e) {
    return fail(e);
  }
}

export async function updateEntity(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const e = await prisma.newsEntity.findUniqueOrThrow({ where: { id: str(f, "id") } });
    await loadProjectFor(me, e.projectId, true);
    const op = str(f, "op");
    if (op === "toggle") await prisma.newsEntity.update({ where: { id: e.id }, data: { isActive: !e.isActive } });
    else if (op === "delete") await prisma.newsEntity.delete({ where: { id: e.id } });
    else if (op === "save") {
      const type = str(f, "type");
      await prisma.newsEntity.update({
        where: { id: e.id },
        data: { name: str(f, "name") || e.name, type: ["person", "brand", "event", "trend", "product"].includes(type) ? type : e.type, weight: Math.min(2, Math.max(0.3, numOr(str(f, "weight"), e.weight))), aliases: list(str(f, "aliases")), grp: str(f, "grp") },
      });
    }
    done();
    return { ok: "Сохранено" };
  } catch (err) {
    return fail(err);
  }
}

// ───────── Прокси (администратор) ─────────

export async function saveProxy(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    if (me.role !== "ADMIN") throw new Error("Прокси настраивает администратор");
    const op = str(f, "op") || "add";
    if (op === "add") {
      const url = str(f, "url");
      let u: URL;
      try {
        u = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`);
      } catch {
        throw new Error("Формат: http://логин:пароль@хост:порт");
      }
      if (!u.port) throw new Error("Укажите порт прокси");
      await prisma.newsProxy.create({ data: { label: str(f, "label") || u.hostname, urlEnc: encryptSecret(u.toString()) } });
      done();
      return { ok: "Прокси добавлен — проверьте его кнопкой «Проверить»" };
    }
    const row = await prisma.newsProxy.findUniqueOrThrow({ where: { id: str(f, "id") } });
    if (op === "toggle") await prisma.newsProxy.update({ where: { id: row.id }, data: { isActive: !row.isActive } });
    else if (op === "delete") await prisma.newsProxy.delete({ where: { id: row.id } });
    else if (op === "test") {
      const { decryptSecret } = await import("@/lib/crypto");
      const r = await fetchText("https://news.google.com/rss?hl=uk&gl=UA&ceid=UA:uk", { proxyUrl: decryptSecret(row.urlEnc), timeoutMs: 20_000 });
      await prisma.newsProxy.update({ where: { id: row.id }, data: r.ok ? { lastOkAt: new Date(), lastError: null } : { lastError: (r.error ?? `HTTP ${r.status}`).slice(0, 500) } });
      done();
      return r.ok ? { ok: `«${row.label}» работает: Google News ответил через прокси` } : { error: `«${row.label}»: ${r.error ?? r.status}` };
    }
    done();
    return { ok: "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}

// ───────── Избранное, ресёрч, тренды ─────────

/** Звёздочка: «хочу написать». При добавлении сразу собирается ресёрч по источникам (картинки, вставки). */
export async function toggleStar(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const c = await prisma.newsCluster.findUniqueOrThrow({ where: { id: str(f, "id") } });
    await loadProjectFor(me, c.projectId);
    const on = !c.starred;
    await prisma.newsCluster.update({ where: { id: c.id }, data: { starred: on, starredById: on ? me.id : null, starredAt: on ? new Date() : null } });
    if (on && !c.researchAt) {
      const { deepResearch } = await import("@/lib/news/research");
      const r = await deepResearch(c.id);
      done();
      return { ok: `В избранном. Ресёрч: ${r.images.length} картинок, ${r.embeds.length} вставок из ${r.pages.filter((p) => p.ok).length} страниц` };
    }
    done();
    return { ok: on ? "В избранном" : "Убрано из избранного" };
  } catch (e) {
    return fail(e);
  }
}

export async function researchAction(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const c = await prisma.newsCluster.findUniqueOrThrow({ where: { id: str(f, "id") } });
    await loadProjectFor(me, c.projectId);
    const { deepResearch } = await import("@/lib/news/research");
    const r = await deepResearch(c.id);
    done();
    return { ok: `Ресёрч обновлён: ${r.images.length} картинок, ${r.embeds.length} вставок из ${r.pages.filter((p) => p.ok).length} страниц` };
  } catch (e) {
    return fail(e);
  }
}

/** Тренд без карточки: прогон по запросу Google News — найденные новости попадут в ленту кластером. */
export async function trendSearch(_p: FormState, f: FormData): Promise<FormState> {
  try {
    const me = await requireUser();
    const p = await loadProjectFor(me, str(f, "project"));
    const q = str(f, "q").slice(0, 120);
    if (!q) throw new Error("Пустой запрос");
    const r = await requestRun(p.id, me.id, `query:${q}`, true);
    if (!r.ok) return { error: r.error };
    done();
    return { ok: `Ищу новости по «${q}» в Google News — карточка появится в ленте через минуту-две` };
  } catch (e) {
    return fail(e);
  }
}
