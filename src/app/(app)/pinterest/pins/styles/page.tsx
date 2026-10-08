import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, Empty, PageHeader, type SearchParams, sp } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { deleteSet } from "@/actions/pins";
import { listAiStyles, styleCategories, styleTypes } from "@/lib/pins/prompts/aiStyles";
import { PINORA_TYPES } from "@/lib/pins/prompts/pinora";
import { publicUrl } from "@/lib/pins/storage";
import { AiStylePicker } from "@/components/pins/AiStylePicker";
import { CanvasCatalog } from "@/components/pins/CanvasCatalog";
import { CATALOG_LIB } from "@/lib/pins/canvas/catalog";

export const dynamic = "force-dynamic";

export default async function StylesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const me = await requireUser();
  const p = await searchParams;
  const tab = sp(p, "tab") ?? "ai";
  const sites = await prisma.pinSite.findMany({ where: { ...(me.role === "ADMIN" ? {} : { teamId: { in: me.teamIds } }), isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, teamId: true, niche: true } });
  const siteId = sp(p, "site") ?? sites[0]?.id ?? "";
  const site = sites.find((s) => s.id === siteId) ?? sites[0];
  const tabs = [["ai", "ИИ-стили и наборы"], ["canvas", "Canvas-стили"], ["pinora", "Pinora"]];
  const qs = (t: string) => `/pinterest/pins/styles?tab=${t}&site=${site?.id ?? ""}`;

  return (
    <>
      <PageHeader title="Стили" subtitle="Как выглядят пины: наборы ИИ-стилей с примерами, каталог Canvas и типы Pinora. Наборы и скрытия — отдельно для каждого сайта." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {tabs.map(([k, l]) => <Link key={k} href={qs(k)} className={`badge px-3 py-1 ${tab === k ? "bg-ink text-bg" : "bg-ink/5 hover:bg-ink/10"}`}>{l}</Link>)}
        <form method="get" className="ml-auto flex items-center gap-2">
          <input type="hidden" name="tab" value={tab} />
          <select name="site" className="input py-1.5" defaultValue={site?.id ?? ""}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <button className="btn-ghost btn-sm">Сайт</button>
        </form>
      </div>
      {!site ? <Empty title="Сайтов нет" /> : tab === "ai" ? <AiTab siteId={site.id} teamId={site.teamId} /> : tab === "canvas" ? <CanvasTab siteId={site.id} teamId={site.teamId} canDecide={me.role === "ADMIN" || me.leadTeamIds.includes(site.teamId)} /> : <PinoraTab />}
    </>
  );
}

async function AiTab({ siteId, teamId }: { siteId: string; teamId: string }) {
  const [sets, hidden, examples, notes] = await Promise.all([
    prisma.pinSet.findMany({ where: { siteId, setKind: "ai" }, orderBy: { name: "asc" } }),
    prisma.pinStyleExclusion.findMany({ where: { siteId, topic: "", kind: "ai" }, select: { styleId: true } }),
    prisma.pinExample.findMany({ where: { styleId: { not: null }, imagePath: { not: "" } }, select: { styleId: true, imagePath: true }, orderBy: { sortOrder: "asc" } }),
    prisma.pinStyleOverride.findMany({ where: { teamId, siteId: null, isActive: true }, select: { styleId: true, instruction: true } }),
  ]);
  const hiddenSet = new Set(hidden.map((h) => h.styleId));
  const exampleOf = new Map<string, string[]>();
  for (const e of examples) {
    if (!e.styleId) continue;
    const arr = exampleOf.get(e.styleId) ?? [];
    if (arr.length < 3) arr.push(publicUrl(e.imagePath));
    exampleOf.set(e.styleId, arr);
  }
  const styles = listAiStyles().map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    type: s.type ?? "",
    group: s.variantOf ?? s.id,
    groupName: s.baseName ?? s.name.replace(/\s*\/\d+$/, ""),
    variantLabel: s.variantLabel ?? "",
    concept: s.concept.slice(0, 200),
    examples: exampleOf.get(s.id) ?? (s.baseName ? exampleOf.get(s.baseName) : undefined) ?? [],
    hidden: hiddenSet.has(s.id),
    note: notes.find((n) => n.styleId === s.id)?.instruction ?? "",
  }));
  const cats = styleCategories.map((c) => ({ id: c.id, label: c.label, note: c.note }));

  return (
    <div className="space-y-4">
      <Card title={`Наборы сайта: ${sets.length}`} description="Набор — список ИИ-стилей с темой. Автопилот берёт набор, подходящий к теме страницы, и распределяет стили поровну.">
        {sets.length === 0 ? <p className="help">Наборов нет. Создайте первый ниже: отметьте стили и нажмите «Создать набор».</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Набор</th><th>Тема</th><th>Стилей</th><th></th></tr></thead>
            <tbody>{sets.map((s) => (
              <tr key={s.id}><td className="font-medium">{s.name}</td><td className="text-muted">{s.topic || "любая"}</td><td>{(s.styleIds as string[]).length}</td>
                <td className="text-right"><ActionForm action={deleteSet} className="inline" hidden={{ id: s.id }}><SubmitButton className="btn-ghost btn-sm" confirm="Удалить набор?" pendingText="…">Удалить</SubmitButton></ActionForm></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <AiStylePicker siteId={siteId} teamId={teamId} styles={styles} categories={cats} types={styleTypes} sets={sets.map((s) => ({ id: s.id, name: s.name, topic: s.topic, styleIds: s.styleIds as string[] }))} />
    </div>
  );
}

async function CanvasTab({ siteId, teamId, canDecide }: { siteId: string; teamId: string; canDecide: boolean }) {
  const [rows, hidden, sets, job] = await Promise.all([
    prisma.pinCanvasStyle.findMany({ where: { libraryId: CATALOG_LIB }, orderBy: [{ isApproved: "desc" }, { sortOrder: "asc" }] }),
    prisma.pinStyleExclusion.findMany({ where: { siteId, topic: "", kind: "canvas" }, select: { styleId: true } }),
    prisma.pinSet.findMany({ where: { siteId, setKind: "canvas" }, orderBy: { name: "asc" } }),
    prisma.pinJob.findFirst({ where: { teamId, stage: "previews", status: { in: ["PENDING", "RUNNING"] } }, orderBy: { createdAt: "desc" } }),
  ]);
  const hiddenSet = new Set(hidden.map((h) => h.styleId));
  const catalog = rows.map((r) => {
    const spec = r.data as { tags?: string[]; counts?: number[]; sourceIds?: string[] };
    return {
      id: r.id, name: r.name, tags: spec.tags ?? [], counts: spec.counts ?? [], previewUrl: r.previewPath ? publicUrl(r.previewPath) : null,
      status: (r.isApproved ? "approved" : r.isActive ? "pending" : "rejected") as "pending" | "approved" | "rejected",
      hidden: hiddenSet.has(r.id), sourceCount: spec.sourceIds?.length ?? 0,
    };
  });
  return <CanvasCatalog siteId={siteId} teamId={teamId} rows={catalog} sets={sets.map((s) => ({ id: s.id, name: s.name, styleIds: s.styleIds as string[] }))} jobLabel={job ? `${job.label || job.stage} ${job.done}/${job.total}` : null} canDecide={canDecide} />;
}

function PinoraTab() {
  return (
    <Card title="Типы Pinora" description="Pinora — второй способ делать ИИ-пины: промт собирается конструктором из 226 параметров. Какие типы использовать, задаётся в рецепте сайта.">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PINORA_TYPES.map((t) => (
          <div key={t.id} className="rounded-xl border border-line p-3"><div className="font-medium">{t.ru}</div><div className="help">{t.id}{t.only ? ` · только для: ${t.only}` : ""}</div></div>
        ))}
      </div>
      <p className="help mt-3">Включение типов: Сайт → Рецепт → «Типы Pinora». Интенсивность параметров фиксирована (auto 40/40/20), формат 2:3.</p>
    </Card>
  );
}
