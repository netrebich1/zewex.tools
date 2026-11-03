"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { mapLimit, resetDeeplPool } from "@/lib/deepl/deepl";
import { checkProxy, parseProxyLine, resetProxyCache } from "@/lib/deepl/net";
import { BASE_PATH } from "@/lib/deepl/types";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const PROXIES_PATH = `${BASE_PATH}/proxies`;

function done(): void {
  resetProxyCache();
  resetDeeplPool();
  revalidatePath(PROXIES_PATH);
}

/** Список прокси, по строке: ip:port:user:pass (или user:pass@ip:port, socks5://…). Повторы пропускаются, новые сразу проверяются. */
export async function addDeeplProxies(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    const lines = String(f.get("proxies") ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("Вставьте прокси, по одному в строке: ip:port:логин:пароль");
    const bad: string[] = [];
    const parsed = lines.map((l) => {
      const p = parseProxyLine(l);
      if (!p || p.port < 1 || p.port > 65535) bad.push(l.split(":").slice(0, 2).join(":"));
      return p;
    }).filter((p): p is NonNullable<typeof p> => !!p && p.port >= 1 && p.port <= 65535);
    const existing = new Set((await prisma.deeplProxy.findMany({ select: { host: true, port: true, username: true } })).map((p) => `${p.host}:${p.port}:${p.username}`));
    const ids: string[] = [];
    let dupes = 0;
    for (const p of parsed) {
      const k = `${p.host}:${p.port}:${p.username}`;
      if (existing.has(k)) { dupes++; continue; }
      existing.add(k);
      const row = await prisma.deeplProxy.create({ data: { host: p.host, port: p.port, username: p.username, passwordEnc: p.password ? encryptSecret(p.password) : "" } });
      ids.push(row.id);
    }
    const checks = await mapLimit(ids, 8, (id) => checkProxy(id).catch((e) => ({ ok: false, note: String(e), ip: null })));
    const okN = checks.filter((c) => c.ok).length;
    done();
    const parts = [`Добавлено прокси: ${ids.length}`, `работают: ${okN}`];
    if (ids.length - okN) parts.push(`не прошли проверку: ${ids.length - okN} (см. список)`);
    if (dupes) parts.push(`уже были: ${dupes}`);
    if (bad.length) parts.push(`не разобрал строк: ${bad.length} (${bad.slice(0, 3).join("; ")})`);
    return ids.length - okN || bad.length ? { error: parts.join(" · ") } : { ok: parts.join(" · ") };
  } catch (e) {
    return fail(e);
  }
}

export async function updateDeeplProxy(_p: FormState, f: FormData): Promise<FormState> {
  try {
    await requireUser();
    const id = str(f, "id");
    const op = str(f, "op");
    if (op === "delete") await prisma.deeplProxy.delete({ where: { id } });
    else if (op === "toggle") {
      const p = await prisma.deeplProxy.findUniqueOrThrow({ where: { id } });
      await prisma.deeplProxy.update({ where: { id }, data: p.isActive ? { isActive: false } : { isActive: true, failCount: 0, lastError: null } });
    } else if (op === "check") {
      const r = await checkProxy(id);
      done();
      return r.ok ? { ok: r.note } : { error: r.note };
    } else if (op === "check_all") {
      const rows = await prisma.deeplProxy.findMany({ select: { id: true } });
      const r = await mapLimit(rows, 8, (p) => checkProxy(p.id).catch(() => ({ ok: false, note: "", ip: null })));
      done();
      const bad = r.filter((x) => !x.ok).length;
      return bad ? { error: `Проверено ${r.length}: работают ${r.length - bad}, не прошли ${bad}` } : { ok: `Все прокси работают (${r.length})` };
    } else if (op === "delete_dead") {
      const r = await prisma.deeplProxy.deleteMany({ where: { OR: [{ isActive: false }, { lastCheckOk: false }] } });
      done();
      return { ok: `Удалено прокси: ${r.count}` };
    }
    done();
    return { ok: "Сохранено" };
  } catch (e) {
    return fail(e);
  }
}
