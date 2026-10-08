"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LogoFull, LogoMark } from "./Logo";
import { Icon, type IconName } from "./Icons";

type NavItem = { href: string; label: string; icon: IconName; admin?: boolean };

/** Меню под аватаркой: всё служебное. Основной экран — инструменты. */
const MENU: NavItem[] = [
  { href: "/keys", label: "Ключи ИИ", icon: "key" },
  { href: "/sites", label: "Сайты", icon: "layers" },
  { href: "/access", label: "Доступы к сайтам", icon: "shield" },
  { href: "/providers", label: "Провайдеры и модели", icon: "cloud" },
  { href: "/teams", label: "Команды", icon: "users" },
  { href: "/users", label: "Пользователи", icon: "user", admin: true },
  { href: "/usage", label: "Расход", icon: "chart" },
  { href: "/account", label: "Аккаунт", icon: "user" },
];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "•";
}

export function Shell({ user, children }: { user: { name: string; email: string; role: string }; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const items = MENU.filter((n) => !n.admin || user.role === "ADMIN");
  const isTools = pathname === "/" || pathname.startsWith("/projects") || pathname.startsWith("/pinterest");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center gap-3">
          <Link href="/" className="shrink-0" aria-label="Zewex Tools"><LogoFull className="h-6 w-auto hidden sm:block" /><LogoMark className="h-6 w-auto sm:hidden" /></Link>
          <nav className="flex items-center gap-1 ml-2">
            <Link href="/" className={`tab ${isTools ? "active" : ""}`}><Icon.grid width={15} height={15} /> Инструменты</Link>
          </nav>
          <div className="ml-auto flex items-center gap-2" ref={ref}>
            <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 rounded-full border border-line bg-surface pl-1 pr-2.5 py-1 hover:border-line-2 transition" aria-haspopup="menu" aria-expanded={open}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-ink text-bg text-[12px] font-bold">{initials(user.name)}</span>
              <span className="hidden sm:block text-[13.5px] font-medium max-w-[140px] truncate">{user.name}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-muted transition ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {open && (
              <div className="menu" role="menu">
                <div className="px-3 py-2 border-b border-line mb-1">
                  <div className="text-[14px] font-semibold truncate">{user.name}</div>
                  <div className="help truncate">{user.email}</div>
                </div>
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
