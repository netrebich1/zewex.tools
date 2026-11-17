/**
 * WordPress для DeepL Articler: сайты из раздела «Сайты» (SiteAccess, сервис `deepl` отмечен или список сервисов пуст),
 * выборка постов по статусу и дате публикации, сырой HTML поста (context=edit → content.raw со шорткодами),
 * публикация в исходный пост или новым постом, откат к сохранённому оригиналу.
 */
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import type { CurrentUser } from "@/lib/auth";
import { canAccessSiteAccess, siteAccessWhere } from "@/lib/sites/access";
import { normalizeBaseUrl, stripHtml, type WpCreds } from "@/lib/pins/wp/client";
import { PROJECT_SLUG } from "./types";

export type DeeplSite = { id: string; name: string; baseUrl: string; ready: boolean };

const enabledFor = (projects: unknown) => {
  const list = Array.isArray(projects) ? (projects as string[]) : [];
  return list.length === 0 || list.includes(PROJECT_SLUG);
};

/** Сайты, доступные пользователю в инструменте. */
export async function listSites(me: CurrentUser): Promise<DeeplSite[]> {
  const rows = await prisma.siteAccess.findMany({
    where: await siteAccessWhere(me),
    select: { id: true, name: true, baseUrl: true, username: true, appPasswordEnc: true, projects: true },
    orderBy: { name: "asc" },
  });
  return rows.filter((r) => enabledFor(r.projects)).map((r) => ({ id: r.id, name: r.name, baseUrl: r.baseUrl, ready: !!r.username && !!r.appPasswordEnc }));
}

export async function siteCreds(accessId: string): Promise<WpCreds & { name: string }> {
  const a = await prisma.siteAccess.findUnique({ where: { id: accessId }, select: { name: true, baseUrl: true, username: true, appPasswordEnc: true, projects: true } });
  if (!a) throw new Error("Сайт не найден");
  if (!enabledFor(a.projects)) throw new Error(`Сайт «${a.name}» не подключён к DeepL Articler — отметьте сервис на странице сайта`);
  if (!a.username || !a.appPasswordEnc) throw new Error(`У сайта «${a.name}» не заполнены логин и Application Password (раздел «Сайты»)`);
  return { name: a.name, baseUrl: a.baseUrl, username: a.username, appPassword: decryptSecret(a.appPasswordEnc) };
}

export async function requireSite(me: CurrentUser, accessId: string): Promise<WpCreds & { name: string }> {
  if (!accessId || !(await canAccessSiteAccess(me, accessId))) throw new Error("Сайт не найден");
  return siteCreds(accessId);
}

const api = (c: WpCreds, path: string) => `${normalizeBaseUrl(c.baseUrl)}/wp-json/wp/v2${path}`;
const auth = (c: WpCreds) => `Basic ${Buffer.from(`${c.username}:${c.appPassword}`, "utf8").toString("base64")}`;

function humanError(status: number, text: string): string {
  if (/invalid_username|incorrect_password|rest_not_logged_in/.test(text) || status === 401) {
    return "WordPress отклонил логин: в разделе «Сайты» укажите имя пользователя WP (не домен) и действующий Application Password";
  }
  let msg = text;
  try {
    const j = JSON.parse(text) as { message?: string };
    if (j?.message) msg = j.message;
  } catch {
    /* не JSON */
  }
  return `WordPress ${status}: ${stripHtml(msg).slice(0, 300)}`;
}

async function wp<T>(c: WpCreds, path: string, init: RequestInit = {}, timeoutMs = 30_000, attempts = 3): Promise<{ data: T; headers: Headers }> {
  let lastErr = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(api(c, path), {
        ...init,
        headers: { Authorization: auth(c), Accept: "application/json", "User-Agent": "ZewexDeepl/1.0 (+https://zewex.tools)", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (res.ok) return { data: JSON.parse(text) as T, headers: res.headers };
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(humanError(res.status, text)), { final: true });
      lastErr = humanError(res.status, text);
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(lastErr || "WordPress не отвечает");
}

export type WpListItem = { id: number; title: string; date: string; status: string; link: string; categories: number[] };
export type PostsFilter = { status: string; after?: string; before?: string; categories?: number[]; search?: string; limit?: number };

/** yyyy-mm-dd → граница дня по времени сайта (WP сравнивает date в локальном времени сайта). */
function boundary(d: string, end: boolean): string {
  const day = d.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T${end ? "23:59:59" : "00:00:00"}` : d;
}

/** Посты по статусу и дате публикации, новые сверху; до limit (≤500) штук. */
export async function listPosts(c: WpCreds, f: PostsFilter): Promise<{ posts: WpListItem[]; total: number }> {
  const limit = Math.max(1, Math.min(500, f.limit ?? 500));
  const posts: WpListItem[] = [];
  let total = 0;
  for (let page = 1; posts.length < limit; page++) {
    const qs = new URLSearchParams({
      per_page: "100",
      page: String(page),
      status: f.status || "draft",
      orderby: "date",
      order: "desc",
      context: "edit",
      _fields: "id,link,date,title,status,categories",
    });
    if (f.after) qs.set("after", boundary(f.after, false));
    if (f.before) qs.set("before", boundary(f.before, true));
    if (f.categories?.length) qs.set("categories", f.categories.join(","));
    if (f.search?.trim()) qs.set("search", f.search.trim());
    let res: { data: Array<Record<string, unknown>>; headers: Headers };
    try {
      res = await wp<Array<Record<string, unknown>>>(c, `/posts?${qs}`);
    } catch (e) {
      if (page > 1 && /rest_post_invalid_page_number|400/.test(String((e as Error).message))) break;
      throw e;
    }
    total = Number(res.headers.get("x-wp-total")) || total;
    for (const p of res.data) {
      const t = p.title as { raw?: string; rendered?: string } | string | undefined;
      posts.push({
        id: Number(p.id),
        title: stripHtml(typeof t === "string" ? t : (t?.raw ?? t?.rendered ?? "")),
        date: String(p.date ?? "").slice(0, 16).replace("T", " "),
        status: String(p.status ?? ""),
        link: String(p.link ?? ""),
        categories: Array.isArray(p.categories) ? (p.categories as number[]) : [],
      });
    }
    const pages = Number(res.headers.get("x-wp-totalpages")) || 1;
    if (page >= pages || res.data.length < 100) break;
  }
  return { posts: posts.slice(0, limit), total: total || posts.length };
}

export async function listCategories(c: WpCreds): Promise<Array<{ id: number; name: string; count: number }>> {
  const out: Array<{ id: number; name: string; count: number }> = [];
  for (let page = 1; page <= 5; page++) {
    const { data, headers } = await wp<Array<{ id: number; name: string; count: number }>>(c, `/categories?per_page=100&page=${page}&orderby=count&order=desc&_fields=id,name,count`);
    out.push(...data.map((x) => ({ id: x.id, name: stripHtml(x.name), count: x.count })));
    if (page >= (Number(headers.get("x-wp-totalpages")) || 1)) break;
  }
  return out;
}

export type WpRawPost = { id: number; title: string; html: string; link: string; status: string; date: string };

/** Пост целиком для правки: content.raw (шорткоды, картинки, ссылки как в редакторе). */
export async function getPost(c: WpCreds, id: number): Promise<WpRawPost> {
  const { data: p } = await wp<Record<string, unknown>>(c, `/posts/${id}?context=edit`);
  const t = p.title as { raw?: string; rendered?: string } | undefined;
  const content = p.content as { raw?: string; rendered?: string } | undefined;
  return {
    id: Number(p.id),
    title: t?.raw ?? stripHtml(t?.rendered ?? ""),
    html: content?.raw ?? content?.rendered ?? "",
    link: String(p.link ?? ""),
    status: String(p.status ?? ""),
    date: String(p.date ?? ""),
  };
}

/** Обновить пост (id) или создать новый; возвращает ссылку и id. */
export async function savePost(c: WpCreds, id: number | null, payload: Record<string, unknown>): Promise<{ id: number; link: string }> {
  const { data } = await wp<{ id: number; link: string }>(c, id ? `/posts/${id}` : "/posts", { method: "POST", body: JSON.stringify(payload) }, 90_000, id ? 2 : 1);
  // Новый пост не повторяем: повтор после таймаута мог бы создать дубль.
  return { id: data.id, link: data.link };
}
