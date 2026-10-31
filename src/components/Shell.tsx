"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LogoFull, LogoMark } from "./Logo";
import { Icon, type IconName } from "./Icons";
import { ThemeSwitch } from "./ThemeSwitch";
import { HeaderBalances } from "./HeaderBalances";
import { HeaderServer } from "./HeaderServer";
import { ImpersonationBar, TeamMenuItems, TeamSwitch, ViewAsPicker, ViewModeMenuItem, ViewModeSwitch } from "./ViewAs";
import { stopImpersonation } from "@/actions/viewAs";
import { canSeeBalances, showsBalances, canViewKeys, canViewProviders, canViewTeams, canViewUsage, canViewUsers, type Actor } from "@/lib/permissions";

type NavItem = { href: string; label: string; icon: IconName; show?: (u: Actor) => boolean };

/** Меню под аватаркой: всё служебное. Основной экран — инструменты. Пункты скрываются по правам. */
const MENU: NavItem[] = [
  { href: "/keys", label: "Ключи ИИ", icon: "key", show: canViewKeys },
  { href: "/sites", label: "Сайты", icon: "layers" },
  { href: "/providers", label: "Провайдеры и модели", icon: "cloud", show: canViewProviders },
  { href: "/teams", label: "Команды", icon: "users", show: canViewTeams },
  { href: "/users", label: "Пользователи", icon: "user", show: canViewUsers },
  { href: "/usage", label: "Расход", icon: "chart", show: canViewUsage },
  { href: "/account", label: "Аккаунт", icon: "user" },
];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "•";
}

type ShellUser = Actor & {
  name: string;
  email: string;
  /** Главный админ: переключатель «Админ / Сотрудник» и вход в кабинеты сотрудников. */
  superAdmin: boolean;
  memberView: boolean;
  /** Кто вошёл в этот кабинет (только в сессии вошедшего главного админа). */
  impersonator: { id: string; name: string; email: string } | null;
  /** Все команды пользователя и активная (переключатель в шапке, если команд больше одной и он не админ). */
  teams: { id: string; name: string }[];
  activeTeamId: string | null;
};

export function Shell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const items = MENU.filter((n) => !n.show || n.show(user));
  // Админу переключатель не нужен: он видит всё независимо от команд. В режиме сотрудника — нужен.
  const teamSwitch = user.role !== "ADMIN" && user.teams.length > 1;
  const isTools = pathname === "/" || pathname.startsWith("/projects") || pathname.startsWith("/pinterest") || pathname.startsWith("/gambling") || pathname.startsWith("/finance") || pathname.startsWith("/discovery") || pathname.startsWith("/analytics");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  useEffect(() => setOpen(false), [pathname]);

  // Цвет шапки показывает режим: синий — вы смотрите как сотрудник, фиолетовый — вы в чужом кабинете.
  const view = user.impersonator ? "view-as" : user.memberView ? "view-member" : "";

  return (
    <div className={`min-h-dvh flex flex-col ${view}`}>
      {user.impersonator && <ImpersonationBar name={user.name} email={user.email} by={user.impersonator.name} />}
      <header className="view-header sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl h-14 flex items-center gap-2 sm:gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:px-6">
          <Link href="/" className="shrink-0" aria-label="Zewex Tools"><LogoFull className="h-6 w-auto hidden sm:block" /><LogoMark className="h-6 w-auto sm:hidden" /></Link>
          {/* На телефоне вкладку не показываем: логотип и так ведёт к инструментам, а места в шапке нет. */}
          <nav className="hidden sm:flex items-center gap-1 ml-2">
            <Link href="/" className={`tab ${isTools ? "active" : ""}`} title="Инструменты" aria-label="Инструменты"><Icon.grid width={15} height={15} /> <span className="hidden xl:inline">Инструменты</span></Link>
          </nav>
          {/*
            Правая группа может сжиматься, но уступают место только балансы (min-w-0 у их плашки: обрезаются целыми суммами),
            остальные плашки не меньше своего содержимого. Раньше при нехватке места группа наезжала на аватар (2026-10-24).
          */}
          <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
            {user.impersonator && <span className="view-chip hidden lg:inline-flex">Кабинет сотрудника</span>}
            <HeaderServer />
            {showsBalances(user) && <HeaderBalances key={user.activeTeamId ?? "all"} mine={!canSeeBalances(user)} teamName={user.teams.find((t) => t.id === user.activeTeamId)?.name ?? null} />}
            {user.superAdmin && <ViewModeSwitch memberView={user.memberView} />}
            {teamSwitch && <TeamSwitch teams={user.teams} activeTeamId={user.activeTeamId} />}
            <ThemeSwitch />
          </div>
          <div className="relative flex shrink-0 items-center gap-2" ref={ref}>
            {/* Имя в шапке не помещается рядом с сервером, балансами и переключателем — оно в меню и в подсказке. */}
            <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 h-9 rounded-full border border-line bg-surface pl-1 pr-2.5 hover:border-line-2 transition" aria-haspopup="menu" aria-expanded={open} title={user.name} aria-label={`Меню: ${user.name}`}>
              <span className="view-avatar inline-flex h-7 w-7 items-center justify-center rounded-full bg-ink text-bg text-[12px] font-bold">{initials(user.name)}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-muted transition ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {open && (
              <div className="menu" role="menu">
                <div className="px-3 py-2 border-b border-line mb-1">
                  <div className="text-[14px] font-semibold truncate">{user.name}</div>
                  <div className="help truncate">{user.email}</div>
                  {user.memberView && <div className="mt-1.5 view-chip">Режим сотрудника</div>}
                  {user.impersonator && <div className="mt-1.5 help">Вы вошли как этот сотрудник. Вернуться: {user.impersonator.name}</div>}
                </div>
                {user.impersonator && (
                  <form action={stopImpersonation} className="border-b border-line mb-1 pb-1">
                    <button className="menu-item font-semibold" style={{ color: "var(--view-as)" }}><Icon.logout width={16} height={16} /> Вернуться в свой кабинет</button>
                  </form>
                )}
                {user.superAdmin && <ViewModeMenuItem memberView={user.memberView} />}
                {user.superAdmin && <ViewAsPicker />}
                {user.superAdmin && <div className="border-b border-line my-1" />}
                {teamSwitch && <TeamMenuItems teams={user.teams} activeTeamId={user.activeTeamId} />}
                {items.map((n) => {
                  const I = Icon[n.icon];
                  const active = pathname.startsWith(n.href);
                  return (
                    <Link key={n.href} href={n.href} role="menuitem" className={`menu-item ${active ? "bg-ink/5 text-ink" : ""}`}>
                      <I width={16} height={16} /> {n.label}
                    </Link>
                  );
                })}
                <form action="/logout" method="post" className="border-t border-line mt-1 pt-1">
                  <button className="menu-item text-danger hover:text-danger"><Icon.logout width={16} height={16} /> Выйти</button>
                </form>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1 min-w-0">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">{children}</div>
      </main>
    </div>
  );
}
