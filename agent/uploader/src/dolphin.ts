/**
 * Dolphin Anty Local API (http://localhost:3001, работает только пока Dolphin открыт на этом ПК):
 *   POST /v1.0/auth/login-with-token {token}          — вход по токену API (один раз после запуска Dolphin)
 *   GET  /v1.0/browser_profiles?limit=&page=           — список профилей (Bearer токен)
 *   GET  /v1.0/browser_profiles/{id}/start?automation=1 — запуск профиля → {automation:{port, wsEndpoint}}
 *   GET  /v1.0/browser_profiles/{id}/stop               — закрыть профиль
 * Список профилей при недоступности локального списка берётся с https://dolphin-anty-api.com (тот же токен).
 */
import { AgentError } from "./errors";
import { log } from "./log";

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

  /** Все профили, постранично. Сначала локальный API, при 401 — вход по токену и повтор; если локальный список недоступен — облачный API. */
  async profiles(): Promise<DolphinProfile[]> {
    const out: DolphinProfile[] = [];
    const parse = (j: unknown): { items: DolphinProfile[]; total: number | null } => {
      const o = (j && typeof j === "object" ? j : {}) as { data?: unknown; total?: unknown };
      const arr = Array.isArray(o.data) ? o.data : [];
      const items = arr.map((p) => { const r = (p ?? {}) as Record<string, unknown>; return { id: String(r.id ?? ""), name: String(r.name ?? ""), tags: r.tags, platform: typeof r.platform === "string" ? r.platform : null }; }).filter((p) => p.id && p.name);
      return { items, total: typeof o.total === "number" ? o.total : null };
    };
    const fetchAll = async (get: (page: number) => Promise<{ status: number; json: unknown }>) => {
      for (let page = 1; page <= 200; page++) {
        const { status, json } = await get(page);
        if (status === 401 || status === 403) throw new AgentError("dolphin_auth", "Dolphin: нет доступа к списку профилей (токен)");
        if (status >= 400) throw new Error(`Dolphin: HTTP ${status} при чтении профилей`);
        const { items, total } = parse(json);
        out.push(...items);
        if (!items.length || items.length < 50 || (total != null && out.length >= total)) break;
      }
    };
    try {
      if (!this.authed) await this.login();
      await fetchAll((page) => this.get(`/v1.0/browser_profiles?limit=50&page=${page}`));
      if (out.length) return out;
    } catch (e) {
      if (e instanceof AgentError && e.kind === "dolphin_offline") throw e;
      log.warn("локальный список профилей не прочитан, пробую облачный API", e);
    }
    if (!this.token) return out;
    await fetchAll(async (page) => {
      const res = await fetch(`https://dolphin-anty-api.com/browser_profiles?limit=50&page=${page}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30000) });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    });
    return out;
  }

  /** Запуск профиля с автоматизацией → адрес CDP. */
  async start(profileId: string): Promise<{ port: number; wsEndpoint: string; ws: string }> {
    if (!this.authed) await this.login();
    let r = await this.get<{ success?: boolean; automation?: { port?: number; wsEndpoint?: string }; error?: string; message?: string }>(`/v1.0/browser_profiles/${profileId}/start?automation=1`, 120000);
    if (r.status === 401) { this.authed = false; await this.login(); r = await this.get(`/v1.0/browser_profiles/${profileId}/start?automation=1`, 120000); }
    const j = r.json;
    if (r.status === 404) throw new AgentError("profile_not_found", `профиль ${profileId} не найден в Dolphin`);
    if (!j?.automation?.port || !j.automation.wsEndpoint) {
      const msg = String(j?.error ?? j?.message ?? `HTTP ${r.status}`);
      if (/already|running|запущен/i.test(msg)) throw new AgentError("profile_busy", `профиль уже открыт: ${msg}`);
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
