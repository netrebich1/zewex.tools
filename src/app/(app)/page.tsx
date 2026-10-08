import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, Empty, Field, PageHeader, sp, type SearchParams } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { createProject, createSection, deleteSection, updateSection } from "@/actions/admin";
import { Icon, type IconName } from "@/components/Icons";
import { STATUS_LABELS } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "neutral" | "ok" | "warn" | "brand"> = { PLANNED: "neutral", MIGRATING: "warn", ACTIVE: "ok", PAUSED: "brand" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const params = await searchParams;
  const sections = await prisma.section.findMany({ orderBy: { order: "asc" }, include: { projects: { orderBy: [{ order: "asc" }, { name: "asc" }], include: { _count: { select: { slots: true } } } } } });
  const current = sections.find((s) => s.slug === sp(params, "section")) ?? sections[0];
  const isAdmin = me.role === "ADMIN";
  const counts = await Promise.all([prisma.apiKey.count(), prisma.binding.count(), prisma.usageLog.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) } } })]);

  return (
    <>
      <PageHeader
        title={`Привет, ${me.name.split(" ")[0]}`}
        subtitle="Инструменты сгруппированы по разделам. Откройте инструмент, чтобы настроить слоты, ключи и модели."
      />

      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: "Ключей", value: counts[0], href: "/keys" },
          { label: "Правил", value: counts[1], href: "/providers" },
          { label: "Вызовов за 7 дней", value: counts[2], href: "/usage" },
        ].map((s) => (
          <Link key={s.label} href={s.href} className="card p-3 sm:p-4 hover:border-brand transition">
            <div className="text-[22px] sm:text-[26px] font-bold tracking-tight">{s.value}</div>
            <div className="help">{s.label}</div>
          </Link>
        ))}
      </div>

      {/* Section tabs */}
      <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
        <div className="flex gap-2 pb-3 min-w-max">
          {sections.map((s) => {
            const I = Icon[(s.icon as IconName) in Icon ? (s.icon as IconName) : "grid"];
            const active = s.id === current?.id;
            return (
              <Link key={s.id} href={`/?section=${s.slug}`} className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium border transition ${active ? "bg-ink text-white border-ink" : "bg-surface border-line text-ink-2 hover:border-ink/40"}`}>
                <I width={16} height={16} /> {s.name}
                <span className={`text-[12px] ${active ? "text-white/70" : "text-muted"}`}>{s.projects.length}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {!current ? (
        <Empty title="Разделов пока нет" hint="Создайте первый раздел ниже." />
      ) : current.projects.length === 0 ? (
        <Empty title={`В разделе «${current.name}» пока нет инструментов`} hint={isAdmin ? "Добавьте инструмент формой ниже." : "Администратор ещё не добавил инструменты."} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {current.projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.slug}`} className="card p-4 hover:border-brand transition flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-[16px] leading-tight">{p.name}</h3>
                <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{STATUS_LABELS[p.status] ?? p.status}</Badge>
              </div>
              {p.description && <p className="help line-clamp-2">{p.description}</p>}
              <div className="mt-auto flex items-center justify-between text-[12px] text-muted pt-2">
                <span>Слотов: {p._count.slots}</span>
                {p.url && <span className="text-brand font-medium">Открыть →</span>}
              </div>
            </Link>
          ))}
        </div>
      )}

      {isAdmin && (
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <Card title="Добавить инструмент" description="Инструмент — это один сервис (например, генератор описаний пинов).">
            <ActionForm action={createProject}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Название"><input name="name" className="input" required placeholder="Генератор описаний пинов" /></Field>
                <Field label="Раздел">
                  <select name="sectionId" className="input" defaultValue={current?.id}>
                    {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Статус">
                  <select name="status" className="input" defaultValue="PLANNED">
                    {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                <Field label="Ссылка (если инструмент уже где-то работает)"><input name="url" className="input" placeholder="https://…" /></Field>
              </div>
              <Field label="Описание"><textarea name="description" className="input" rows={2} placeholder="Что делает инструмент" /></Field>
              <SubmitButton pendingText="Создаю…"><Icon.plus width={16} height={16} /> Создать инструмент</SubmitButton>
            </ActionForm>
          </Card>

          <Card title="Разделы" description="Вкладки на главной. Порядок задаёт число «порядок».">
            <div className="space-y-3">
              {sections.map((s) => (
                <ActionForm key={s.id} action={updateSection} className="flex flex-wrap items-end gap-2" hidden={{ id: s.id }}>
                  <div className="flex-1 min-w-[140px]"><Field label="Название"><input name="name" className="input" defaultValue={s.name} /></Field></div>
                  <div className="w-28"><Field label="Иконка">
                    <select name="icon" className="input" defaultValue={s.icon}>
                      {["grid", "pin", "dice", "search", "compass", "layers", "chart", "cloud"].map((i) => <option key={i} value={i}>{i}</option>)}
                    </select>
                  </Field></div>
                  <div className="w-20"><Field label="Порядок"><input name="order" type="number" className="input" defaultValue={s.order} /></Field></div>
                  <SubmitButton className="btn-ghost btn-sm" pendingText="…">Сохранить</SubmitButton>
                  <DeleteSectionButton id={s.id} disabled={s.projects.length > 0} />
                </ActionForm>
              ))}
              <ActionForm action={createSection} className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
                <div className="flex-1 min-w-[140px]"><Field label="Новый раздел"><input name="name" className="input" placeholder="Например, Контент" required /></Field></div>
                <div className="w-28"><Field label="Иконка">
                  <select name="icon" className="input" defaultValue="grid">
                    {["grid", "pin", "dice", "search", "compass", "layers", "chart", "cloud"].map((i) => <option key={i} value={i}>{i}</option>)}
                  </select>
                </Field></div>
                <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
              </ActionForm>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

function DeleteSectionButton({ id, disabled }: { id: string; disabled: boolean }) {
  return (
    <ActionForm action={deleteSection} className="inline" hidden={{ id }}>
      <SubmitButton className={`btn-danger btn-sm ${disabled ? "opacity-40 pointer-events-none" : ""}`} confirm="Удалить раздел?" pendingText="…">Удалить</SubmitButton>
    </ActionForm>
  );
}
