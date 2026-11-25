"use server";
/** Финансы проекта: доходы и расходы вне ИИ. Только главные админы (canSeeFinance). */
import { revalidatePath } from "next/cache";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canSeeFinance, loadAccessForUser } from "@/lib/projects/access";
import { ensureCard } from "@/lib/projects/card";
import { logEventByCard } from "@/lib/projects/events";
import { FINANCE_CATEGORIES, financeCategoryLabel } from "@/lib/projects/steps";
import { fmtMoney, parseNumber } from "@/lib/utils";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const refresh = (accessId: string) => { revalidatePath(`/pinterest/projects/${accessId}`); revalidatePath("/pinterest/projects"); };

async function guard(accessId: string) {
  const me = await requireUser();
  if (!canSeeFinance(me)) throw new Error("Финансы видят только главные админы");
  const access = await loadAccessForUser(me, accessId);
  if (!access) throw new Error("Сайт не найден");
  const card = await ensureCard(accessId);
  return { me, card };
}

export async function addFinance(_p: FormState, f: FormData): Promise<FormState> {
  const accessId = str(f, "accessId");
  try {
    const { me, card } = await guard(accessId);
    const kind = str(f, "kind") === "income" ? "income" : "expense";
    const amount = parseNumber(f.get("amountUsd"));
    if (amount == null || amount <= 0) return { error: "Введите сумму" };
    const date = str(f, "date") || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Неверная дата" };
    const category = FINANCE_CATEGORIES.some((c) => c.key === str(f, "category")) ? str(f, "category") : "other";
    await prisma.prjFinance.create({ data: { cardId: card.id, date: new Date(`${date}T00:00:00Z`), kind, amountUsd: amount, category, note: str(f, "note") || null, createdById: me.id } });
    await logEventByCard(card.id, { kind: "finance_added", userId: me.id, summary: `${kind === "income" ? "Доход" : "Расход"} ${fmtMoney(amount)} · ${financeCategoryLabel(category)}${str(f, "note") ? ` · ${str(f, "note")}` : ""} (${date})` });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

export async function deleteFinance(_p: FormState, f: FormData): Promise<FormState> {
  const accessId = str(f, "accessId"), id = str(f, "id");
  try {
    const { card } = await guard(accessId);
    await prisma.prjFinance.deleteMany({ where: { id, cardId: card.id } });
    refresh(accessId);
    return {};
  } catch (e) { return fail(e); }
}

/**
 * Импорт выгрузки: вставленный текст (CSV/TSV или строки «дата; сумма; доход|расход; категория; заметка»).
 * Строка-дубль (тот же сайт, дата, сумма, вид, заметка) не создаётся повторно — ключ importKey.
 */
export async function importFinance(_p: FormState, f: FormData): Promise<FormState> {
  const accessId = str(f, "accessId");
  try {
    const { me, card } = await guard(accessId);
    const text = str(f, "text");
    if (!text) return { error: "Вставьте строки" };
    const sep = text.includes("\t") ? "\t" : text.includes(";") ? ";" : ",";
    const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, "")));
    const parsed: Array<{ date: string; amount: number; kind: string; category: string; note: string | null; key: string }> = [];
    const bad: string[] = [];
    for (const cols of rows) {
      const [d0, a0, k0, c0, ...rest] = cols;
      const date = normDate(d0 ?? "");
      const amount = parseNumber(a0 ?? null);
      if (!date || amount == null || amount === 0) { if (!/дата|date|сумма|amount/i.test(cols.join(" "))) bad.push(cols.join(sep)); continue; }
      const kindRaw = (k0 ?? "").toLowerCase();
      const kind = amount < 0 || /расх|expense|cost|минус/.test(kindRaw) ? "expense" : /дох|income|revenue|плюс/.test(kindRaw) ? "income" : "expense";
      const catRaw = (c0 ?? "").toLowerCase();
      const category = FINANCE_CATEGORIES.find((c) => c.key === catRaw || c.label.toLowerCase() === catRaw)?.key ?? "other";
      const note = rest.join(" ").trim() || (c0 && category === "other" ? c0 : null);
      const key = createHash("sha1").update([card.id, date, Math.abs(amount).toFixed(2), kind, note ?? ""].join("|")).digest("hex");
      parsed.push({ date, amount: Math.abs(amount), kind, category, note, key });
    }
    if (!parsed.length) return { error: `Не распознано ни одной строки. Формат: дата${sep} сумма${sep} доход/расход${sep} категория${sep} заметка` };
    const exist = new Set((await prisma.prjFinance.findMany({ where: { importKey: { in: parsed.map((p) => p.key) } }, select: { importKey: true } })).map((x) => x.importKey));
    const fresh = parsed.filter((p) => !exist.has(p.key));
    if (fresh.length) await prisma.prjFinance.createMany({ data: fresh.map((p) => ({ cardId: card.id, date: new Date(`${p.date}T00:00:00Z`), kind: p.kind, amountUsd: p.amount, category: p.category, note: p.note, source: "import", importKey: p.key, createdById: me.id })) });
    const inc = fresh.filter((p) => p.kind === "income").reduce((a, p) => a + p.amount, 0);
    const exp = fresh.filter((p) => p.kind === "expense").reduce((a, p) => a + p.amount, 0);
    await logEventByCard(card.id, { kind: "finance_added", userId: me.id, summary: `Импорт: ${fresh.length} строк (доход ${fmtMoney(inc)}, расход ${fmtMoney(exp)})${exist.size ? `, пропущено дублей ${exist.size}` : ""}` });
    refresh(accessId);
    return { ok: `Добавлено ${fresh.length}, дублей пропущено ${parsed.length - fresh.length}${bad.length ? `, не распознано ${bad.length}` : ""}` };
  } catch (e) { return fail(e); }
}

/** 2026-10-22 / 22.10.2026 / 22/10/2026 → 2026-10-22 */
function normDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
