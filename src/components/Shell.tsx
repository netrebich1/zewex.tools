"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LogoFull, LogoMark } from "./Logo";
import { Icon, type IconName } from "./Icons";

type NavItem = { href: string; label: string; icon: IconName; admin?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "Инструменты", icon: "grid" },
  { href: "/keys", label: "Ключи", icon: "key" },
  { href: "/providers", label: "Провайдеры и модели", icon: "cloud" },
  { href: "/teams", label: "Команды", icon: "users" },
  { href: "/users", label: "Пользователи", icon: "shield", admin: true },
  { href: "/usage", label: "Расход", icon: "chart" },
  { href: "/account", label: "Аккаунт", icon: "user" },
];

const MOBILE = ["/", "/keys", "/providers", "/usage"];

export function Shell({ user, children }: { user: { name: string; email: string; role: string }; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/projects") : pathname.startsWith(href));
  const items = NAV.filter((n) => !n.admin || user.role === "ADMIN");

  const nav = (
    <nav className="flex flex-col gap-1">
      {items.map((n) => {
        const I = Icon[n.icon];
        return (
          <Link key={n.href} href={n.href} className={`nav-link ${isActive(n.href) ? "active" : ""}`} onClick={() => setOpen(false)}>
            <I width={18} height={18} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-line lg:bg-surface lg:sticky lg:top-0 lg:h-dvh">
        <div className="px-5 pt-6 pb-5">
          <Link href="/"><LogoFull className="h-7 w-auto" /></Link>
        </div>
        <div className="px-3 flex-1 overflow-y-auto">{nav}</div>
        <div className="border-t border-line p-4">
          <div className="text-[14px] font-medium truncate">{user.name}</div>
          <div className="help truncate">{user.email}</div>
          <form action="/logout" method="post" className="mt-3">
            <button className="btn-ghost btn-sm w-full"><Icon.logout width={16} height={16} /> Выйти</button>
          </form>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/90 backdrop-blur px-4 h-14">
        <Link href="/"><LogoFull className="h-6 w-auto" /></Link>
        <button className="btn-ghost btn-sm" onClick={() => setOpen(true)} aria-label="Меню"><Icon.menu /></button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-[82%] max-w-xs bg-surface shadow-2xl p-4 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <LogoMark className="h-7 w-auto" />
              <button className="btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Закрыть"><Icon.x /></button>
            </div>
            {nav}
            <div className="mt-auto border-t border-line pt-4">
              <div className="text-[14px] font-medium truncate">{user.name}</div>
              <div className="help truncate">{user.email}</div>
              <form action="/logout" method="post" className="mt-3">
                <button className="btn-ghost btn-sm w-full"><Icon.logout width={16} height={16} /> Выйти</button>
              </form>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8 pb-24 lg:pb-10">{children}</div>
      </main>

      {/* Mobile bottom tabs */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-surface/95 backdrop-blur grid grid-cols-4 pb-[env(safe-area-inset-bottom)]">
        {items.filter((n) => MOBILE.includes(n.href)).map((n) => {
          const I = Icon[n.icon];
          const active = isActive(n.href);
          return (
            <Link key={n.href} href={n.href} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active ? "text-ink" : "text-muted"}`}>
              <span className={`rounded-full px-3 py-0.5 ${active ? "bg-brand-soft" : ""}`}><I width={20} height={20} /></span>
              {n.label.split(" ")[0]}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
