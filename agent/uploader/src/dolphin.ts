/**
 * Dolphin Anty Local API (http://localhost:3001, работает только пока Dolphin открыт на этом ПК):
 *   POST /v1.0/auth/login-with-token {token}          — вход по токену API (один раз после запуска Dolphin)
 *   GET  /v1.0/browser_profiles?limit=&page=           — список профилей (Bearer токен)
 *   GET  /v1.0/browser_profiles/{id}/start?automation=1 — запуск профиля → {automation:{port, wsEndpoint}}
 *   GET  /v1.0/browser_profiles/{id}/stop               — закрыть профиль
 * Список профилей — из облака https://dolphin-anty-api.com/browser_profiles/list-cursor по токену команды (с 20.11.2026).
 */
import { AgentError } from "./errors";
import { log } from "./log";

const CLOUD = "https://dolphin-anty-api.com";

export type DolphinProfile = { id: string; name: string; tags?: unknown; platform?: string | null };

export class Dolphin {
  private authed = false;
  constructor(private token: string | null, private base = process.env.DOLPHIN_API || "http://localhost:3001") {}

  setToken(t: string | null) { if (t !== this.token) { this.token = t; this.authed = false; } }

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }

  /** Dolphin запущен? (любой ответ локального API) */
  async alive(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/v1.0/browser_profiles?limit=1`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  /** Вход по токену (Dolphin помнит его до перезапуска). */
  async login(): Promise<void> {
    if (!this.token) throw new AgentError("dolphin_auth", "в настройках портала не задан токен Dolphin API");
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1.0/auth/login-with-token`, { method: "POST", headers: this.headers(), body: JSON.stringify({ token: this.token }), signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw new AgentError("dolphin_offline", `Dolphin Anty не отвечает на ${this.base}: ${e instanceof Error ? e.message : e}`);
    }
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!res.ok || j.success === false) throw new AgentError("dolphin_auth", `Dolphin не принял токен API: ${j.error ?? res.status}`);
    this.authed = true;
  }

  private async get<T>(path: string, timeoutMs = 60000): Promise<{ status: number; json: T }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new AgentError("dolphin_offline", `Dolphin Anty не отвечает на ${this.base}: ${e instanceof Error ? e.message : e}`);
    }
    const json = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, json };
  }

  /**
   * Все профили аккаунта команды. С 20.11.2026 Dolphin отключил `GET /browser_profiles` (облако отвечает 410
   * E_BROWSER_PROFILE_LIST_GONE, локальный API — 401): список берём из облака `GET /browser_profiles/list-cursor`
   * по токену команды, страницы — по `next_page_url`. Это и есть профили аккаунта токена, а не того, в который вошло окно Dolphin.
   * Облако недоступно — пробуем старый локальный список (старые версии Dolphin) и сверяем аккаунт.
   */
  async profiles(): Promise<DolphinProfile[]> {
    const parse = (j: unknown): DolphinProfile[] => {
      const o = (j && typeof j === "object" ? j : {}) as { data?: unknown };
      const arr = Array.isArray(o.data) ? o.data : [];
      return arr.map((p) => {
        const r = (p ?? {}) as Record<string, unknown>;
        // Теги + заметка профиля (Dolphin: notes.content или строка) — портал ищет в них домен сайта для автосопоставления.
        const tags = Array.isArray(r.tags) ? r.tags.map((t) => (typeof t === "string" ? t : typeof t === "object" && t ? String((t as { name?: unknown }).name ?? "") : "")).filter(Boolean) : [];
        const notesRaw = r.notes && typeof r.notes === "object" ? (r.notes as { content?: unknown }).content : r.notes;
        const note = typeof notesRaw === "string" ? notesRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) : "";
        return { id: String(r.id ?? ""), name: String(r.name ?? ""), tags: note ? [...tags, `note:${note}`] : tags, platform: typeof r.platform === "string" ? r.platform : null };
      }).filter((p) => p.id && p.name);
    };
    if (!this.token) throw new AgentError("dolphin_auth", "в настройках портала не задан токен Dolphin API команды");
    try {
      return await this.cloudList(parse);
    } catch (e) {
      if (e instanceof AgentError && e.kind === "dolphin_auth") throw e;
      log.warn("облачный список профилей Dolphin не прочитан, пробую локальный", e);
    }
    const out: DolphinProfile[] = [];
    if (!this.authed) await this.login();
    for (let page = 1; page <= 200; page++) {
      const { status, json } = await this.get(`/v1.0/browser_profiles?limit=50&page=${page}`);
      if (status >= 400) throw new Error(`Dolphin: HTTP ${status} при чтении профилей (локально)`);
      const items = parse(json);
      out.push(...items);
      if (items.length < 50) break;
    }
    if (out.length) await this.checkAccount(out);
    return out;
  }

  private async cloudList(parse: (j: unknown) => DolphinProfile[]): Promise<DolphinProfile[]> {
    const byId = new Map<string, DolphinProfile>();
    let url: string | null = `${CLOUD}/browser_profiles/list-cursor?limit=50`;
    for (let i = 0; url && i < 200; i++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000) });
      if (res.status === 401 || res.status === 403) throw new AgentError("dolphin_auth", `Dolphin не принял токен API команды (HTTP ${res.status}) — проверьте токен в настройках портала`);
      if (!res.ok) throw new Error(`Dolphin: HTTP ${res.status} при чтении списка профилей`);
      const j = (await res.json().catch(() => ({}))) as { next_page_url?: unknown };
      const before = byId.size;
      for (const p of parse(j)) byId.set(p.id, p);
      const next = typeof j.next_page_url === "string" && j.next_page_url ? j.next_page_url : null;
      // Страница не дала новых профилей — дальше не идём (защита от зацикливания курсора).
      url = next && byId.size > before ? (/[?&]limit=/.test(next) ? next : `${next}${next.includes("?") ? "&" : "?"}limit=50`) : null;
    }
    return [...byId.values()];
  }

  /**
   * Локальный API отдаёт профили того аккаунта, в который вошло приложение Dolphin, а не аккаунта токена.
   * Сверяем с облачным списком по токену команды: ни одного общего профиля → Dolphin на ПК в чужом аккаунте.
   */
  private wrongAccount = false;
  private async checkAccount(local: DolphinProfile[]): Promise<void> {
    if (!this.token) return;
    let cloud: string[];
    try {
      const res = await fetch(`${CLOUD}/browser_profiles/list-cursor?limit=50`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) return;
      const j = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
      cloud = (Array.isArray(j.data) ? j.data : []).map((p) => String(p?.id ?? "")).filter(Boolean);
    } catch { return; }
    const ids = new Set(local.map((p) => p.id));
    this.wrongAccount = cloud.length ? !cloud.some((id) => ids.has(id)) : local.length > 0;
    if (this.wrongAccount) throw this.wrongAccountError();
  }
  private wrongAccountError() {
    return new AgentError("dolphin_auth", "Dolphin Anty на этом ПК вошёл в другой аккаунт, не в аккаунт вашей команды (токен в настройках портала). Выйдите из аккаунта в Dolphin и войдите в свой.");
  }

  /** Запуск профиля с автоматизацией → адрес CDP. */
  async start(profileId: string): Promise<{ port: number; wsEndpoint: string; ws: string }> {
    if (this.wrongAccount) throw this.wrongAccountError();
    if (!this.authed) await this.login();
    let r = await this.get<{ success?: boolean; automation?: { port?: number; wsEndpoint?: string }; error?: string; message?: string }>(`/v1.0/browser_profiles/${profileId}/start?automation=1`, 120000);
    if (r.status === 401) { this.authed = false; await this.login(); r = await this.get(`/v1.0/browser_profiles/${profileId}/start?automation=1`, 120000); }
    const j = r.json;
    if (r.status === 404) throw new AgentError("profile_not_found", `профиль ${profileId} не найден в Dolphin`);
    if (!j?.automation?.port || !j.automation.wsEndpoint) {
      const msg = String(j?.error ?? j?.message ?? `HTTP ${r.status}`);
      if (/already|running|запущен/i.test(msg)) throw new AgentError("profile_busy", `профиль уже открыт: ${msg}`);
      // Dolphin перед стартом 3 раза проверяет прокси профиля; мёртвый прокси → «Operation timed out» / E_PROXY_CHECK_ERROR.
      if (/proxy|operation timed out/i.test(msg)) throw new AgentError("proxy_failed", `прокси профиля не отвечает: ${msg}`);
      // Ядро браузера нужной версии не докачано: «Browser executable not found …\browser\1520\anty.exe».
      if (/executable not found|anty\.exe/i.test(msg)) throw new AgentError("browser_missing", `нет ядра браузера Dolphin: ${msg}`);
      if (/not found|не найден/i.test(msg)) throw new AgentError("profile_not_found", msg);
      throw new AgentError("dolphin_offline", `Dolphin не запустил профиль: ${msg}`);
    }
    return { port: j.automation.port, wsEndpoint: j.automation.wsEndpoint, ws: `ws://127.0.0.1:${j.automation.port}${j.automation.wsEndpoint}` };
  }

  async stop(profileId: string): Promise<void> {
    try { await this.get(`/v1.0/browser_profiles/${profileId}/stop`, 60000); } catch (e) { log.warn(`не удалось закрыть профиль ${profileId}`, e); }
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.get<{ version?: string; data?: { version?: string } }>(`/v1.0/version`, 5000);
      return r.json?.version ?? r.json?.data?.version ?? null;
    } catch {
      return null;
    }
  }
}
