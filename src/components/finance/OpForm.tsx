"use client";
import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { saveOp, type FinState } from "@/actions/finance";
import { Messages } from "@/components/ui";
import { BASE, CURRENCIES, fmtAmount, normCur, rateLabel, todayYmd } from "@/lib/finance/currency";

type Opt = { id: string; label: string };
export type OpFormRefs = {
  dirs: { id: string; name: string; label: string; parentId: string | null }[];
  cats: { id: string; name: string; kind: "EXPENSE" | "INCOME" | "ANY" }[];
  partners: Opt[];
  accounts: string[];
  /** Контрагенты: недавние и частые первыми. */
  counterparties: { id: string; name: string; categoryIds: string[] }[];
};
export type OpValues = {
  id?: string;
  type: "EXPENSE" | "INCOME" | "SETTLEMENT";
  amount: string;
  currency: string;
  date: string;
  manualRate: string;
  directionId: string;
  categoryId: string;
  partnerId: string;
  toPartnerId: string;
  account: string;
  note: string;
  counterparty: string;
};

const TABS = [
  { key: "EXPENSE", label: "Расход" },
  { key: "INCOME", label: "Доход" },
  { key: "SETTLEMENT", label: "Возврат долга" },
] as const;
const CUR_SIGN: Record<string, string> = { EUR: "€", USD: "$", UAH: "₴", USDT: "₮" };
const LS = "zx_fin_last";

const yesterday = () => {
  const d = new Date(Date.now() - 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Кнопка-«таблетка» для выбора одного значения. */
function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-[13.5px] font-medium transition ${on ? "border-ink bg-ink text-bg" : "border-line bg-surface text-ink-2 hover:border-line-2 hover:text-ink"}`}>
      {children}
    </button>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div><span className="label">{label}</span><div className="flex flex-wrap gap-1.5">{children}</div></div>;
}

/**
 * Одна форма для всех операций, всё выбирается кнопками. Курс подставляется сам по дате (середина рынка),
 * его можно переписать: «1 EUR = N валюты» — так же, как в Google. После записи сумма и комментарий очищаются, остальное остаётся.
 * `lockDirection` — форма во вкладке направления: само направление не выбирается, только его подраздел.
 */
export function OpForm({ refs, initial, myPartnerId, onDone, lockDirection }: { refs: OpFormRefs; initial?: Partial<OpValues>; myPartnerId?: string; onDone?: string; lockDirection?: string }) {
  const router = useRouter();
  const editing = !!initial?.id;
  const [v, setV] = useState<OpValues>(() => ({
    type: "EXPENSE", amount: "", currency: BASE, date: todayYmd(), manualRate: "", directionId: lockDirection ?? "", categoryId: "",
    partnerId: myPartnerId ?? refs.partners[0]?.id ?? "", toPartnerId: "", account: "", note: "", counterparty: "", ...initial,
  }));
  const set = <K extends keyof OpValues>(k: K, val: OpValues[K]) => setV((s) => ({ ...s, [k]: val }));
  const [state, action, pending] = useActionState<FinState, FormData>(saveOp, {});

  // Новая операция: валюта и кошелёк — как в прошлый раз.
  useEffect(() => {
    if (editing || initial?.currency) return;
    try {
      const last = JSON.parse(localStorage.getItem(LS) ?? "{}") as { currency?: string; account?: string };
      setV((s) => ({ ...s, currency: last.currency && (CURRENCIES as readonly string[]).includes(last.currency) ? last.currency : s.currency, account: s.account || last.account || "" }));
    } catch { /* нет хранилища */ }
  }, [editing, initial?.currency]);

  useEffect(() => {
    if (!state.at) return;
    if (editing) { if (onDone) router.push(onDone); return; }
    try { localStorage.setItem(LS, JSON.stringify({ currency: v.currency, account: v.account })); } catch { /* нет хранилища */ }
    setV((s) => ({ ...s, amount: "", note: "", manualRate: "", counterparty: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.at]);

  // Рыночный курс на дату.
  const cur = normCur(v.currency) || BASE;
  const [auto, setAuto] = useState<{ rate: number; date: string; stale: boolean } | null | "loading" | "none">(null);
  useEffect(() => {
    if (cur === BASE) { setAuto({ rate: 1, date: v.date, stale: false }); return; }
    setAuto("loading");
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/finance/rate?cur=${encodeURIComponent(cur)}&date=${v.date}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => setAuto(j && typeof j.rate === "number" ? j : "none"))
        .catch(() => { if (!ctl.signal.aborted) setAuto("none"); });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [cur, v.date]);

  const amount = Number(v.amount.replace(/\s/g, "").replace(",", "."));
  const manual = Number(v.manualRate.replace(/\s/g, "").replace(",", "."));
  const rate = cur === BASE ? 1 : manual > 0 ? 1 / manual : typeof auto === "object" && auto ? auto.rate : 0;
  const eur = amount > 0 && rate ? amount * rate : 0;

  // Направление и подраздел: верхний уровень → его подразделы.
  const tops = refs.dirs.filter((d) => !d.parentId);
  const picked = refs.dirs.find((d) => d.id === v.directionId);
  const topId = picked ? picked.parentId ?? picked.id : "";
  const subs = refs.dirs.filter((d) => d.parentId === topId);
  const cats = useMemo(() => refs.cats.filter((c) => c.kind === "ANY" || c.kind === v.type || c.id === v.categoryId), [refs.cats, v.type, v.categoryId]);
  const curList = (CURRENCIES as readonly string[]).includes(cur) ? [...CURRENCIES] : [...CURRENCIES, cur];
  // Контрагент: в выбранной категории — только её контрагенты, без категории — недавние.
  const cpRef = useRef<HTMLInputElement>(null);
  const cpName = v.counterparty.replace(/\s+/g, " ").trim();
  const cpMatch = cpName ? refs.counterparties.find((c) => c.name.toLowerCase() === cpName.toLowerCase()) : undefined;
  const cpChips = (v.categoryId ? refs.counterparties.filter((c) => c.categoryIds.includes(v.categoryId)) : refs.counterparties).slice(0, v.categoryId ? 16 : 8);
  const catName = refs.cats.find((c) => c.id === v.categoryId)?.name;
  const pickCp = (c: { name: string; categoryIds: string[] }) => setV((s) => ({
    ...s, counterparty: s.counterparty === c.name ? "" : c.name,
    // Без выбранной категории: у контрагента одна категория — ставим её сами.
    categoryId: s.categoryId || (c.categoryIds.length === 1 ? c.categoryIds[0] : ""),
  }));
  const whoLabel = v.type === "EXPENSE" ? "Кто платил" : v.type === "INCOME" ? "Кто получил" : "Кто отдал";

  return (
    <form action={action} className="space-y-3.5">
      <Messages error={state.error} ok={state.ok} />
      {v.id && <input type="hidden" name="id" value={v.id} />}
      {(["type", "currency", "date", "directionId", "categoryId", "partnerId", "toPartnerId"] as const).map((k) => <input key={k} type="hidden" name={k} value={k === "currency" ? cur : v[k]} />)}

      <div className="grid grid-cols-3 gap-1 rounded-xl bg-ink/5 p-1">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => set("type", t.key)} className={`rounded-lg px-2 py-1.5 text-[13.5px] font-medium transition ${v.type === t.key ? "bg-surface text-ink shadow-[var(--shadow-card)]" : "text-muted hover:text-ink"}`}>{t.label}</button>
        ))}
      </div>

      <div>
        <div className="flex items-stretch gap-2">
          <input name="amount" className="input flex-1 min-w-0 text-[22px] font-bold tabular-nums" inputMode="decimal" autoComplete="off" placeholder="0" value={v.amount} onChange={(e) => set("amount", e.target.value)} required autoFocus={!editing} aria-label="Сумма" />
        </div>
        <div className="mt-1.5 grid grid-cols-4 gap-1">
          {curList.map((c) => (
            <button key={c} type="button" onClick={() => set("currency", c)}
              className={`rounded-lg border py-1.5 text-[13px] font-semibold transition ${cur === c ? "border-ink bg-ink text-bg" : "border-line bg-surface text-ink-2 hover:border-line-2"}`}>
              {CUR_SIGN[c] ? `${CUR_SIGN[c]} ` : ""}{c}
            </button>
          ))}
        </div>
        {cur !== BASE && (
          <div className="mt-1.5 text-[12.5px]">
            {eur > 0 && <span className="font-semibold">≈ {fmtAmount(eur, "EUR", { digits: 2 })} · </span>}
            {manual > 0 ? <span>свой курс: {rateLabel(cur, 1 / manual)}</span>
              : auto === "loading" ? <span className="text-muted">ищу курс…</span>
              : auto === "none" ? <span className="text-danger">курса {cur} нет — впишите свой</span>
              : auto && typeof auto === "object" ? <span className="text-muted">курс {auto.date}: {rateLabel(cur, auto.rate)}{auto.stale ? " (последний известный)" : ""}</span> : null}
            <details className="mt-1" open={!!v.manualRate}>
              <summary className="cursor-pointer text-muted hover:text-ink">Свой курс (реальный обмен или списание банка)</summary>
              <label className="mt-1.5 flex items-center gap-2"><span className="whitespace-nowrap">1 EUR =</span>
                <input name="manualRate" className="input max-w-[140px]" inputMode="decimal" placeholder={typeof auto === "object" && auto ? String(+(1 / auto.rate).toFixed(4)) : ""} value={v.manualRate} onChange={(e) => set("manualRate", e.target.value)} />
                <span>{cur}</span>
              </label>
            </details>
          </div>
        )}
      </div>

      {v.type !== "SETTLEMENT" && (
        <>
          {!lockDirection && (
            <Row label="Направление">
              {tops.map((d) => <Chip key={d.id} on={topId === d.id} onClick={() => set("directionId", topId === d.id ? "" : d.id)}>{d.name}</Chip>)}
            </Row>
          )}
          {subs.length > 0 && (
            <Row label={lockDirection ? "Подраздел" : `Подраздел · ${tops.find((t) => t.id === topId)?.name ?? ""}`}>
              <Chip on={v.directionId === topId} onClick={() => set("directionId", topId)}>Всё направление</Chip>
              {subs.map((d) => <Chip key={d.id} on={v.directionId === d.id} onClick={() => set("directionId", d.id)}>{d.name}</Chip>)}
            </Row>
          )}
          <Row label="Категория">
            {cats.map((c) => <Chip key={c.id} on={v.categoryId === c.id} onClick={() => set("categoryId", v.categoryId === c.id ? "" : c.id)}>{c.name}</Chip>)}
          </Row>
          <div>
            <span className="label">{v.type === "INCOME" ? "От кого" : "Кому платили"}{catName ? ` · ${catName}` : ""}</span>
            {cpChips.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {cpChips.map((c) => <Chip key={c.id} on={cpMatch?.id === c.id} onClick={() => pickCp(c)}>{c.name}</Chip>)}
              </div>
            )}
            <input name="counterparty" className="input" list="fin-cps" autoComplete="off" placeholder={cpChips.length ? "Другой или новый…" : "Например, Ahrefs, Hetzner, фрилансер"} value={v.counterparty} onChange={(e) => set("counterparty", e.target.value)} />
            <datalist id="fin-cps">{refs.counterparties.map((c) => <option key={c.id} value={c.name} />)}</datalist>
            <input ref={cpRef} type="hidden" name="cpConfirm" defaultValue="0" />
            {cpName && !cpMatch && <p className="help mt-1">Новый контрагент — при записи спрошу, добавить ли «{cpName}» в систему{catName ? ` (категория «${catName}»)` : ""}.</p>}
            {cpMatch && v.categoryId && !cpMatch.categoryIds.includes(v.categoryId) && <p className="help mt-1">«{cpMatch.name}» пока не в категории «{catName}» — при записи предложу добавить.</p>}
          </div>
        </>
      )}

      <Row label={whoLabel}>
        {refs.partners.map((p) => <Chip key={p.id} on={v.partnerId === p.id} onClick={() => setV((s) => ({ ...s, partnerId: p.id, toPartnerId: s.toPartnerId === p.id ? "" : s.toPartnerId }))}>{p.label}</Chip>)}
      </Row>
      {v.type === "SETTLEMENT" && (
        <Row label="Кому отдал">
          {refs.partners.filter((p) => p.id !== v.partnerId).map((p) => <Chip key={p.id} on={v.toPartnerId === p.id} onClick={() => set("toPartnerId", p.id)}>{p.label}</Chip>)}
        </Row>
      )}

      <Row label="Дата">
        <Chip on={v.date === todayYmd()} onClick={() => set("date", todayYmd())}>Сегодня</Chip>
        <Chip on={v.date === yesterday()} onClick={() => set("date", yesterday())}>Вчера</Chip>
        <input type="date" className="input w-auto py-1.5" value={v.date} max={todayYmd()} onChange={(e) => e.target.value && set("date", e.target.value)} aria-label="Другая дата" />
      </Row>

      <input name="note" className="input" placeholder="Комментарий: за что" value={v.note} onChange={(e) => set("note", e.target.value)} />
      <input name="account" className="input" list="fin-accounts" placeholder={v.type === "INCOME" ? "На какой кошелёк (необязательно)" : "Карта / кошелёк (необязательно)"} value={v.account} onChange={(e) => set("account", e.target.value)} />
      <datalist id="fin-accounts">{refs.accounts.map((a) => <option key={a} value={a} />)}</datalist>

      <button type="submit" className="btn-brand w-full" disabled={pending || !refs.partners.length} onClick={(e) => {
        if (cpRef.current) cpRef.current.value = "0";
        // Контрагент: новый — добавляем только с согласия; известный в новой категории — спрашиваем, привязать ли.
        if (v.type !== "SETTLEMENT" && cpName) {
          if (!cpMatch) {
            if (!window.confirm(`Добавить контрагента «${cpName}» в систему${catName ? ` (категория «${catName}»)` : ""}?\n\nОК — добавить и записать операцию.\nОтмена — вернуться к форме.`)) { e.preventDefault(); return; }
            if (cpRef.current) cpRef.current.value = "1";
          } else if (v.categoryId && !cpMatch.categoryIds.includes(v.categoryId)) {
            const yes = window.confirm(`Добавить «${cpMatch.name}» в категорию «${catName}»? В прежних категориях он тоже останется.\n\nОК — добавить. Отмена — записать без этого.`);
            if (cpRef.current) cpRef.current.value = yes ? "1" : "0";
          }
        }
        // Возврат долга меняет расчёт между партнёрами — только с подтверждением, чтобы не записать случайно.
        if (v.type !== "SETTLEMENT" || !(amount > 0)) return;
        const name = (id: string) => refs.partners.find((p) => p.id === id)?.label ?? "?";
        const ok = window.confirm(`${editing ? "Сохранить" : "Записать"} возврат долга?\n\n${name(v.partnerId)} → ${v.toPartnerId ? name(v.toPartnerId) : "?"}: ${fmtAmount(amount, cur, { digits: 2 })}${cur !== BASE && eur > 0 ? ` (≈ ${fmtAmount(eur, "EUR", { digits: 2 })})` : ""}`);
        if (!ok) e.preventDefault();
      }}>
        {pending ? "Сохраняю…" : editing ? "Сохранить" : amount > 0 ? `Записать ${fmtAmount(amount, cur, { digits: 2 })}` : "Записать"}
      </button>
    </form>
  );
}
