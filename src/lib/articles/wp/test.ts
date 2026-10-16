/**
 * Проверка подключения сайта для сервиса «Статьи». Порт supabase/functions/test-wp-connection/index.ts:
 * GET /wp-json/wp/v2/users/me (имя, роли, право upload_files); при mediaTest — загрузка PNG 1×1 в медиатеку и удаление.
 */
import { WpError, normalizeBaseUrl, uploadMedia, type WpCreds } from "@/lib/pins/wp/client";
import { deleteMedia, fetchMe } from "./posts";

/** PNG 1×1 (оригинал test-wp-connection :56). */
const TEST_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export type SiteConnectionResult = {
  ok: boolean;
  note: string;
  user?: string;
  roles?: string[];
  canUpload?: boolean;
  /** Результат тестовой загрузки (только при mediaTest) */
  mediaOk?: boolean;
  mediaDeleted?: boolean;
};

export async function testArticleSiteConnection(creds: WpCreds, opts: { mediaTest?: boolean; signal?: AbortSignal } = {}): Promise<SiteConnectionResult> {
  try {
    normalizeBaseUrl(creds.baseUrl);
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
  if (!creds.username.trim() || !creds.appPassword.trim()) return { ok: false, note: "Не указаны логин или пароль приложения" };

  let me: Awaited<ReturnType<typeof fetchMe>>;
  try {
    me = await fetchMe(creds, { signal: opts.signal });
  } catch (e) {
    if (e instanceof WpError && (e.status === 401 || e.status === 403)) {
      return { ok: false, note: `Доступ отклонён (HTTP ${e.status}): проверьте логин и пароль приложения. ${e.message}`.trim() };
    }
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }

  const result: SiteConnectionResult = {
    ok: true,
    note: me.canUpload
      ? `Подключение работает${me.name ? `, пользователь ${me.name}` : ""}${me.roles.length ? ` (${me.roles.join(", ")})` : ""}`
      : `Подключение работает (${me.name}), но у пользователя нет права загружать файлы (upload_files) — публикация с фото не пройдёт`,
    user: me.name || undefined,
    roles: me.roles,
    canUpload: me.canUpload,
  };
  if (!me.canUpload) result.ok = false;
  if (!opts.mediaTest) return result;

  // Тестовая загрузка и удаление (оригинал :57-72)
  try {
    const up = await uploadMedia(creds, { data: TEST_PNG, filename: "zx-upload-test.png", mime: "image/png" }, {}, { signal: opts.signal, timeoutMs: 30_000, maxRetries: 0 });
    result.mediaOk = true;
    result.mediaDeleted = await deleteMedia(creds, up.id, { signal: opts.signal }).catch(() => false);
    result.note += result.mediaDeleted ? ". Медиатека принимает файлы" : ". Медиатека принимает файлы (тестовый файл удалить не удалось — удалите zx-upload-test.png вручную)";
  } catch (e) {
    result.ok = false;
    result.mediaOk = false;
    result.note += `. Медиатека не принимает файлы: ${e instanceof Error ? e.message : String(e)}`;
  }
  return result;
}
