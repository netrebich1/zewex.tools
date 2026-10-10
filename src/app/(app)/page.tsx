import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { sp, type SearchParams } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { ToolsBrowser, type ToolSection } from "@/components/tools/ToolsBrowser";
import { keyWhere, usageWhere } from "@/lib/permissions";

export const dynamic = "force-dynamic";

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

/** Главная: инструменты по разделам, избранное и поиск. Разделы и инструменты заводятся через prisma/seed.mjs. */
export default async function Dashboard({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const isAdmin = me.role === "ADMIN";
  const [sections, favorites, keys, rules, calls] = await Promise.all([
    prisma.section.findMany({ orderBy: { order: "asc" }, include: { projects: { orderBy: [{ order: "asc" }, { name: "asc" }], include: { _count: { select: { slots: true } } } } } }),
    prisma.favoriteTool.findMany({ where: { userId: me.id }, select: { projectId: true } }),
    prisma.apiKey.count({ where: { status: "ACTIVE", ...(keyWhere(me) ?? { id: "" }) } }),
    prisma.binding.count(),
    prisma.usageLog.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) }, ...usageWhere(me) } }),
  ]);
  const data: ToolSection[] = sections.map((s) => ({
    id: s.id, slug: s.slug, name: s.name, icon: s.icon,
    projects: s.projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name, description: p.description, url: p.url, status: p.status, slots: p._count.slots })),
  }));
  const total = data.reduce((n, s) => n + s.projects.length, 0);
  const live = data.reduce((n, s) => n + s.projects.filter((p) => p.status === "ACTIVE").length, 0);

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[13px] text-muted mb-1">Привет, {firstName(me.name)}</p>
          <h1 className="h1">Инструменты</h1>
          <p className="help mt-1">Работает {live} из {total}. Звёздочка на карточке добавляет инструмент в избранное.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { label: "ключей", value: keys, href: "/keys", icon: Icon.key },
            { label: "правил", value: rules, href: "/providers", icon: Icon.route },
            { label: "вызовов за 7 дней", value: calls, href: "/usage", icon: Icon.chart },
          ].map((s) => (
            <Link key={s.href} href={s.href} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] hover:border-line-2 hover:shadow-[var(--shadow-card)] transition">
              <s.icon width={14} height={14} className="text-muted" />
              <span className="font-semibold tabular-nums">{s.value}</span>
              <span className="text-muted">{s.label}</span>
            </Link>
          ))}
        </div>
      </div>

      <ToolsBrowser sections={data} favoriteIds={favorites.map((f) => f.projectId)} isAdmin={isAdmin} initialTab={sp(params, "section")} />
    </>
  );
}
