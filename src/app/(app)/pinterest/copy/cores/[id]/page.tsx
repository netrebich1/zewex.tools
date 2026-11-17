import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import { coreData } from "@/lib/copy/queries";
import { FORMULATIONS, VOL_LABEL, fmtVolume, modifierLabel, nicheLabel } from "@/lib/copy/keys";

export const dynamic = "force-dynamic";

/** Карточка ядра: какие формулировки и на каких сайтах уже написаны, сколько кадров и куда можно поставить новую статью. */
export default async function CopyCorePage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const { id } = await params;
  const d = await coreData(me, id);
  if (!d) notFound();
  const c = d.core;
  const freeMods = FORMULATIONS.filter((m) => !d.usedModifiers.includes(m));

  return (
    <>
      <PageHeader title={c.core} subtitle={`${d.team} · ${nicheLabel(c.niche)} · частотность ${fmtVolume(c.volume)}${c.volClass ? ` (${VOL_LABEL[c.volClass]})` : ""} · опубликованных статей по ядру: ${c.articles}`} back={{ href: "/pinterest/copy", label: "Запас" }} />
      <div className="space-y-5">
        <Card title="Что можно собрать">
          <div className="flex flex-wrap gap-2 text-[13px]">
            <span className="rounded-full bg-ink/5 px-3 py-1.5">Фото в статьях: <b className="tabular-nums">{c.photosPublished}</b></span>
            <span className="rounded-full bg-ink/5 px-3 py-1.5">Резерв, нигде не опубликован: <b className="tabular-nums">{c.photosReserve}</b></span>
            <span className="rounded-full bg-ink/5 px-3 py-1.5">Статей по кадрам: <b className="tabular-nums">{c.byPhotos}</b></span>
            <span className={`rounded-full px-3 py-1.5 ${c.capacity ? "bg-ok-soft text-ok" : "bg-brand-soft text-warn"}`}>Можно собрать: <b className="tabular-nums">{c.capacity}</b></span>
          </div>
          <p className="mt-3 text-[14px]"><span className="text-muted">Свободные сайты ({d.freeSiteNames.length}):</span> {d.freeSiteNames.join(", ") || "нет — тема стоит на всех привязанных сайтах или сайты не привязаны"}</p>
          <p className="mt-1 text-[14px]"><span className="text-muted">Свободные формулировки ({freeMods.length}):</span> {freeMods.map(modifierLabel).join(", ") || "стандартный набор занят"}</p>
        </Card>

        <Card title="Уже написано" description="Все статьи команды по этому ядру, включая те, что ещё в работе.">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Ключ</th><th>Формулировка</th><th>Сайт</th><th></th></tr></thead>
              <tbody>
                {d.forms.map((f) => (
                  <tr key={f.a}>
                    <td><Link href={`/pinterest/articles/articles/${f.a}`} className="hover:underline">{f.k}</Link></td>
                    <td className="text-muted">{modifierLabel(f.m)}</td>
                    <td>{f.site}</td>
                    <td className="text-right">{f.u ? <a href={f.u} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">На сайте</a> : <span className="help">не опубликована</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
