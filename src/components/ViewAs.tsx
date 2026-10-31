"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { impersonationCandidates, setActiveTeam, setMemberView, startImpersonation, stopImpersonation } from "@/actions/viewAs";
import { Icon } from "./Icons";

/** Переключатель «Админ / Сотрудник» у аватарки главного админа. */
export function ViewModeSwitch({ memberView }: { memberView: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const set = (on: boolean) => {
    if (on === memberView || pending) return;
    start(async () => { await setMemberView(on); router.refresh(); });
  };
  const btn = (on: boolean, label: string, hint: string) => {
    const active = on === memberView;
    return (
      <button
        type="button"
        onClick={() => set(on)}
        aria-pressed={active}
        title={hint}
        className={`h-7 rounded-full px-3 text-[12.5px] font-semibold transition ${active ? (on ? "text-white" : "bg-ink text-bg") : "text-muted hover:text-ink"}`}
        style={active && on ? { background: "var(--view-member)" } : undefined}
      >
        {label}
      </button>
    );
  };
  return (
    <div className={`hidden sm:inline-flex items-center gap-0.5 rounded-full border border-line bg-surface p-0.5 ${pending ? "opacity-60" : ""}`} role="group" aria-label="Режим интерфейса">
      {btn(false, "Админ", "Полный доступ: все сайты, прогоны, ключи и настройки")}
      {btn(true, "Сотрудник", "Как обычный сотрудник: только ваши команды, сайты и инструменты")}
    </div>
  );
}

/** Пункт меню с режимом для телефона, где переключатель у аватарки скрыт. */
export function ViewModeMenuItem({ memberView }: { memberView: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} className="menu-item sm:hidden" onClick={() => start(async () => { await setMemberView(!memberView); router.refresh(); })}>
      <Icon.shield width={16} height={16} /> {memberView ? "Вернуться в режим админа" : "Режим сотрудника"}
    </button>
  );
}

type Candidate = Awaited<ReturnType<typeof impersonationCandidates>>[number];

/** Выбор кабинета сотрудника: раскрывается в меню под аватаркой, список с поиском. */
export function ViewAsPicker() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Candidate[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (open && !list) impersonationCandidates().then(setList).catch(() => setList([]));
  }, [open, list]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!list) return [];
    return s ? list.filter((u) => `${u.name} ${u.email} ${u.teams.join(" ")}`.toLowerCase().includes(s)) : list;
  }, [list, q]);

  const enter = (id: string) => start(async () => {
    setError(null);
    const r = await startImpersonation(id);
    if (r?.error) setError(r.error);
  });

  if (!open) {
    return (
      <button type="button" className="menu-item" onClick={() => setOpen(true)}>
        <Icon.users width={16} height={16} /> Войти в кабинет сотрудника
      </button>
    );
  }
  return (
    <div className="px-1.5 py-1.5">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, логин или команда" className="input !py-1.5 sm:!text-[13.5px]" />
      {error && <p className="mt-1.5 px-1 text-[12.5px] text-danger">{error}</p>}
      <div className="mt-1.5 max-h-64 overflow-y-auto">
        {!list ? <p className="help px-2 py-2">Загружаю…</p> : shown.length === 0 ? <p className="help px-2 py-2">Никого не найдено</p> : shown.map((u) => (
          <button key={u.id} type="button" disabled={pending} onClick={() => enter(u.id)} className="menu-item !items-start !py-1.5 disabled:opacity-50">
            <span className="min-w-0">
              <span className="block truncate font-medium text-ink">{u.name}{u.role === "ADMIN" && <span className="help"> · админ</span>}</span>
              <span className="block truncate help">{u.email}{u.teams.length ? ` · ${u.teams.join(", ")}` : ""}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Кнопка входа в кабинет на странице сотрудника. */
export function EnterCabinetButton({ userId }: { userId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button type="button" disabled={pending} className="btn-ghost w-full" onClick={() => start(async () => { setError(null); const r = await startImpersonation(userId); if (r?.error) setError(r.error); })}>
        <Icon.users width={16} height={16} /> {pending ? "Вхожу…" : "Войти в кабинет"}
      </button>
      {error && <p className="mt-1.5 text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}

/** Полоса над шапкой в чужом кабинете: чей кабинет и кнопка возврата. Видна только вошедшему главному админу. */
export function ImpersonationBar({ name, email, by }: { name: string; email: string; by: string }) {
  return (
    <div className="text-white text-[13px]" style={{ background: "var(--view-as)" }}>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">Вы в кабинете: {name}</span>
        <span className="opacity-80 hidden md:inline">{email} · всё, что вы делаете, делается от имени этого сотрудника</span>
        <form action={stopImpersonation} className="ml-auto">
          <button className="inline-flex h-8 items-center rounded-full bg-white/95 px-3.5 text-[12.5px] font-semibold hover:bg-white" style={{ color: "var(--view-as)" }} title={`Вернуться в кабинет ${by}`}>
            Вернуться в свой кабинет
          </button>
        </form>
      </div>
    </div>
  );
}

type TeamOption = { id: string; name: string };

/**
 * Переключатель команд у аватарки: для сотрудника в нескольких командах и для главного админа в режиме сотрудника.
 * «Все» — как раньше, все команды сразу; команда — портал показывает только её сайты, ключи, расход и прогоны.
 */
export function TeamSwitch({ teams, activeTeamId }: { teams: TeamOption[]; activeTeamId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const set = (id: string | null) => {
    if (id === activeTeamId || pending) return;
    start(async () => { await setActiveTeam(id); router.refresh(); });
  };
  const btn = (id: string | null, label: string, hint: string) => {
    const active = id === activeTeamId;
    return (
      <button key={id ?? "all"} type="button" onClick={() => set(id)} aria-pressed={active} title={hint}
        className={`h-7 rounded-full px-3 text-[12.5px] font-semibold transition max-w-[160px] truncate ${active ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}>
        {label}
      </button>
    );
  };
  return (
    <div className={`hidden md:inline-flex items-center gap-0.5 rounded-full border border-line bg-surface p-0.5 ${pending ? "opacity-60" : ""}`} role="group" aria-label="Активная команда">
      {btn(null, "Все", "Все ваши команды сразу")}
      {teams.map((t) => btn(t.id, t.name, `Только команда «${t.name}»: её сайты, ключи, расход и прогоны`))}
    </div>
  );
}

/** Те же команды в меню под аватаркой — для узких экранов, где переключатель у аватарки скрыт. */
export function TeamMenuItems({ teams, activeTeamId }: { teams: TeamOption[]; activeTeamId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const pick = (id: string | null) => start(async () => { await setActiveTeam(id); router.refresh(); });
  return (
    <div className="md:hidden border-b border-line mb-1 pb-1">
      <div className="px-3 pt-1.5 pb-1 help">Команда</div>
      {[{ id: null as string | null, name: "Все команды" }, ...teams].map((t) => (
        <button key={t.id ?? "all"} type="button" disabled={pending} className={`menu-item ${t.id === activeTeamId ? "bg-ink/5 text-ink font-semibold" : ""}`} onClick={() => pick(t.id)}>
          <Icon.users width={16} height={16} /> {t.name}
        </button>
      ))}
    </div>
  );
}
