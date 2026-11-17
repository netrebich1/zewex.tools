import { createHash, createSign, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * Доступ к Google Analytics: токены (OAuth и сервисный аккаунт), Admin API (список свойств), Data API (отчёты).
 * Секреты лежат зашифрованными в GaAccount; токен доступа кэшируется там же до истечения.
 */

const OAUTH_SCOPES = ["https://www.googleapis.com/auth/analytics.readonly", "openid", "https://www.googleapis.com/auth/userinfo.email"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

export type GaAccountRow = { id: string; kind: string; refreshTokenEnc: string | null; saKeyEnc: string | null; accessTokenEnc: string | null; accessExpires: Date | null };

export class GaError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
  /** Доступ отозван или ключ недействителен: синхронизацию аккаунта надо остановить до переподключения. */
  get auth() {
    return this.status === 401 || this.code === "invalid_grant" || this.code === "invalid_client";
  }
  get quota() {
    return this.status === 429 || this.code === "RESOURCE_EXHAUSTED";
  }
}

/* ---------- OAuth ---------- */

export function oauthConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const base = (process.env.APP_URL || "https://zewex.tools").replace(/\/+$/, "");
  return { clientId, clientSecret, redirectUri: `${base}/api/analytics/oauth/callback` };
}

export function oauthStartUrl(state: string): string {
  const cfg = oauthConfig();
  if (!cfg) throw new Error("OAuth не настроен");
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; id_token?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const j = (await r.json().catch(() => ({}))) as TokenResponse;
  if (!r.ok || !j.access_token) throw new GaError(j.error_description || j.error || `Google token: HTTP ${r.status}`, r.status, j.error);
  return j;
}

/** Обмен кода на токены + почта пользователя. */
export async function exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string; expiresIn: number; email: string }> {
  const cfg = oauthConfig();
  if (!cfg) throw new Error("OAuth не настроен");
  const t = await tokenRequest({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" });
  if (!t.refresh_token) throw new GaError("Google не выдал refresh token. Отзовите доступ приложения в настройках Google-аккаунта и подключите заново.", 400);
  const ui = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } });
  const info = (await ui.json().catch(() => ({}))) as { email?: string };
  return { refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in, email: info.email ?? "" };
}

/* ---------- Сервисный аккаунт ---------- */

export type ServiceKey = { client_email: string; private_key: string; token_uri?: string };

export function parseServiceKey(raw: string): ServiceKey {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error("Это не JSON. Скачайте ключ сервисного аккаунта в Google Cloud (IAM → Service accounts → Keys → JSON) и вставьте файл целиком.");
  }
  if (j.type !== "service_account" || typeof j.client_email !== "string" || typeof j.private_key !== "string") throw new Error("В JSON нет client_email и private_key: нужен ключ сервисного аккаунта (type: service_account).");
  return { client_email: j.client_email, private_key: j.private_key, token_uri: typeof j.token_uri === "string" ? j.token_uri : undefined };
}

async function serviceToken(key: ServiceKey): Promise<TokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope: OAUTH_SCOPES[0], aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  return tokenRequest({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` });
}

/* ---------- Токен доступа аккаунта ---------- */

/** Действующий access token: из кэша или новый (OAuth refresh / JWT сервисного аккаунта). Ошибка авторизации → GaError.auth. */
export async function accessToken(acc: GaAccountRow): Promise<string> {
  if (acc.accessTokenEnc && acc.accessExpires && acc.accessExpires.getTime() - Date.now() > 120_000) return decryptSecret(acc.accessTokenEnc);
  let t: TokenResponse;
  if (acc.kind === "service") {
    if (!acc.saKeyEnc) throw new GaError("У сервисного аккаунта нет ключа", 401, "invalid_grant");
    t = await serviceToken(parseServiceKey(decryptSecret(acc.saKeyEnc)));
  } else {
    const cfg = oauthConfig();
    if (!cfg) throw new GaError("OAuth не настроен (GOOGLE_OAUTH_CLIENT_ID / SECRET)", 500);
    if (!acc.refreshTokenEnc) throw new GaError("Нет refresh token: подключите аккаунт заново", 401, "invalid_grant");
    t = await tokenRequest({ refresh_token: decryptSecret(acc.refreshTokenEnc), client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token" });
  }
  const expires = new Date(Date.now() + Math.max(60, t.expires_in - 60) * 1000);
  await prisma.gaAccount.update({ where: { id: acc.id }, data: { accessTokenEnc: encryptSecret(t.access_token), accessExpires: expires } }).catch(() => {});
  acc.accessTokenEnc = encryptSecret(t.access_token);
  acc.accessExpires = expires;
  return t.access_token;
}

async function gaFetch<T>(acc: GaAccountRow, url: string, init?: RequestInit, attempt = 0): Promise<T> {
  const token = await accessToken(acc);
  const r = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (r.ok) return (await r.json()) as T;
  const body = (await r.json().catch(() => ({}))) as { error?: { message?: string; status?: string; code?: number } };
  const msg = body.error?.message || `Google API: HTTP ${r.status}`;
  // Протухший кэшированный токен — обновить и повторить один раз.
  if (r.status === 401 && attempt === 0) {
    acc.accessExpires = null;
    return gaFetch<T>(acc, url, init, 1);
  }
  if ((r.status === 429 || r.status >= 500) && attempt < 2) {
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    return gaFetch<T>(acc, url, init, attempt + 1);
  }
  throw new GaError(msg, r.status, body.error?.status);
}

/* ---------- Admin API: свойства ---------- */

export type GaPropertyInfo = { propertyId: string; name: string; gaAccountId: string; gaAccountName: string; url: string | null; host: string | null; timezone: string; currency: string };

type Summaries = { accountSummaries?: Array<{ account: string; displayName: string; propertySummaries?: Array<{ property: string; displayName: string; propertyType?: string }> }>; nextPageToken?: string };

/** Все GA4-свойства, доступные аккаунту, с адресом сайта и часовым поясом. */
export async function listProperties(acc: GaAccountRow): Promise<GaPropertyInfo[]> {
  const out: GaPropertyInfo[] = [];
  let pageToken = "";
  do {
    const s = await gaFetch<Summaries>(acc, `${ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`);
    for (const a of s.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) {
        const propertyId = p.property.replace(/^properties\//, "");
        type Details = { timeZone?: string; currencyCode?: string };
        type Streams = { dataStreams?: Array<{ type?: string; webStreamData?: { defaultUri?: string } }> };
        const [details, streams] = await Promise.all([
          gaFetch<Details>(acc, `${ADMIN}/properties/${propertyId}`).catch((): Details => ({})),
          gaFetch<Streams>(acc, `${ADMIN}/properties/${propertyId}/dataStreams?pageSize=50`).catch((): Streams => ({})),
        ]);
        const web = (streams.dataStreams ?? []).find((d) => d.type === "WEB_DATA_STREAM" && d.webStreamData?.defaultUri);
        const url = web?.webStreamData?.defaultUri ? normalizeUrl(web.webStreamData.defaultUri) : null;
        out.push({
          propertyId,
          name: p.displayName,
          gaAccountId: a.account.replace(/^accounts\//, ""),
          gaAccountName: a.displayName,
          url,
          host: url ? hostOf(url) : null,
          timezone: details.timeZone || "UTC",
          currency: details.currencyCode || "USD",
        });
      }
    }
    pageToken = s.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

function normalizeUrl(u: string): string {
  const s = u.trim();
  return (/^https?:\/\//i.test(s) ? s : `https://${s}`).replace(/\/+$/, "");
}
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* ---------- Data API: отчёты ---------- */

export type ReportRow = { dims: string[]; metrics: number[] };
export type ReportRequest = {
  dimensions: string[];
  metrics: string[];
  from: string;
  to: string;
  limit?: number;
  orderByMetricDesc?: string;
  orderByDimension?: string;
  dimensionFilter?: unknown;
};

/** runReport с постраничным добором; limit — всего строк. */
export async function runReport(acc: GaAccountRow, propertyId: string, req: ReportRequest): Promise<ReportRow[]> {
  const total = req.limit ?? 100_000;
  const page = Math.min(total, 100_000);
  const rows: ReportRow[] = [];
  let offset = 0;
  for (;;) {
    const body = {
      dateRanges: [{ startDate: req.from, endDate: req.to }],
      dimensions: req.dimensions.map((name) => ({ name })),
      metrics: req.metrics.map((name) => ({ name })),
      limit: String(Math.min(page, total - offset)),
      offset: String(offset),
      keepEmptyRows: false,
      returnPropertyQuota: false,
      ...(req.orderByMetricDesc ? { orderBys: [{ metric: { metricName: req.orderByMetricDesc }, desc: true }] } : req.orderByDimension ? { orderBys: [{ dimension: { dimensionName: req.orderByDimension } }] } : {}),
      ...(req.dimensionFilter ? { dimensionFilter: req.dimensionFilter } : {}),
    };
    const r = await gaFetch<{ rows?: Array<{ dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }>; rowCount?: number }>(acc, `${DATA}/properties/${propertyId}:runReport`, { method: "POST", body: JSON.stringify(body) });
    const got = r.rows ?? [];
    for (const row of got) rows.push({ dims: (row.dimensionValues ?? []).map((v) => v.value), metrics: (row.metricValues ?? []).map((v) => Number(v.value) || 0) });
    offset += got.length;
    if (!got.length || offset >= (r.rowCount ?? 0) || offset >= total) break;
  }
  return rows;
}

const realtimeCache = new Map<string, { at: number; value: number }>();

/** Активные пользователи за последние 30 минут (realtime API), кэш 60 с. */
export async function realtimeActiveUsers(acc: GaAccountRow, propertyId: string): Promise<number> {
  const c = realtimeCache.get(propertyId);
  if (c && Date.now() - c.at < 60_000) return c.value;
  const r = await gaFetch<{ rows?: Array<{ metricValues?: { value: string }[] }> }>(acc, `${DATA}/properties/${propertyId}:runRealtimeReport`, {
    method: "POST",
    body: JSON.stringify({ metrics: [{ name: "activeUsers" }], minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }] }),
  });
  const value = Number(r.rows?.[0]?.metricValues?.[0]?.value ?? 0) || 0;
  realtimeCache.set(propertyId, { at: Date.now(), value });
  return value;
}

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
