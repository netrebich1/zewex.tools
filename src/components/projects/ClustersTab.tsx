import { prisma } from "@/lib/db";
import { Badge, Card } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { addProjectClustersBulk, deleteProjectCluster, saveProjectCluster } from "@/actions/projects";
import { CLUSTER_STATUSES } from "@/lib/projects/steps";
import { AutoForm } from "./AutoForm";

/** Вкладка «Кластеры»: что прописано по сайту, по чему уже есть статья и пины. Подсказка — сколько статей сайта идут из «Подбора ключей». */
export async function ClustersTab({ accessId, cardId }: { accessId: string; cardId: string }) {
  const [clusters, artSites] = await Promise.all([
    prisma.prjCluster.findMany({ where: { cardId }, orderBy: [{ status: "asc" }, { createdAt: "asc" }] }),
    prisma.artSite.findMany({ where: { accessId }, select: { id: true } }),
  ]);
  // Производная связь с «Подбором ключей»: ключ статьи совпадает с нормализованным ключом из базы ключей.
  let kwHint: { total: number; fromKeywords: number } | null = null;
  if (artSites.length) {
    const arts = await prisma.article.findMany({ where: { siteId: { in: artSites.map((s) => s.id) } }, select: { keyword: true } });
    const norms = [...new Set(arts.map((a) => a.keyword.toLowerCase().replace(/\s+/g, " ").trim()))];
    const found = norms.length ? await prisma.kwKeyword.count({ where: { norm: { in: norms } } }).catch(() => 0) : 0;
    kwHint = { total: arts.length, fromKeywords: found };
  }
  const totals = { planned: clusters.filter((c) => c.status === "planned").length, written: clusters.filter((c) => c.status === "written").length, pinned: clusters.filter((c) => c.status === "pinned").length, keys: clusters.reduce((a, c) => a + c.keywordsCount, 0) };

  return (
    <div className="space-y-4">
      <Card title="Кластеры и темы" description={`Прописано ${clusters.length} (${totals.keys} ключей): статья есть у ${totals.written + totals.pinned}, пины — у ${totals.pinned}.${kwHint ? ` Статей по сайту ${kwHint.total}, из них по ключам из «Подбора ключей» — ${kwHint.fromKeywords}.` : ""}`}>
        {clusters.length === 0 ? <p className="help mb-3">Кластеров ещё нет. Добавьте списком ниже — по одному на строку.</p> : (
          <div className="table-wrap mb-3">
            <table className="table">
              <thead><tr><th>Кластер</th><th>Ключей</th><th>Состояние</th><th>Статья</th><th>Заметка</th><th></th></tr></thead>
              <tbody>{clusters.map((c) => (
                <tr key={c.id}>
                  <td className="font-medium">{c.name}{c.keywords && <details className="help"><summary className="cursor-pointer">ключи</summary><pre className="whitespace-pre-wrap text-[12.5px]">{c.keywords}</pre></details>}</td>
                  <td className="tabular-nums">{c.keywordsCount || "—"}</td>
                  <td>
                    <AutoForm action={saveProjectCluster} hidden={{ accessId, id: c.id, name: c.name, keywords: c.keywords ?? "", keywordsCount: String(c.keywordsCount), articleUrl: c.articleUrl ?? "", note: c.note ?? "" }} className="inline">
                      <select name="status" defaultValue={c.status} className="input py-1 pr-7 text-[13px]">{CLUSTER_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
                    </AutoForm>
                  </td>
                  <td>{c.articleUrl ? <a href={c.articleUrl} target="_blank" rel="noreferrer" className="text-[13px] hover:underline break-all">{c.articleUrl.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)}</a> : <span className="text-muted">—</span>}</td>
                  <td className="text-muted text-[13px]">{c.note ?? ""}</td>
                  <td className="text-right whitespace-nowrap">
                    <details className="inline-block text-left">
                      <summary className="cursor-pointer text-[12.5px] text-muted hover:text-ink">править</summary>
                      <ActionForm action={saveProjectCluster} hidden={{ accessId, id: c.id }} className="fixed inset-x-4 top-20 z-50 max-h-[80dvh] overflow-y-auto sm:absolute sm:inset-x-auto sm:top-auto sm:z-10 sm:mt-1 sm:w-[360px] sm:right-4 sm:max-h-none sm:overflow-visible card p-3 space-y-2">
                        <input name="name" className="input py-1.5" defaultValue={c.name} placeholder="Название" />
                        <textarea name="keywords" className="input py-1.5 min-h-[80px]" defaultValue={c.keywords ?? ""} placeholder="Ключи — по одному на строку (число посчитается само)" />
                        <input name="articleUrl" className="input py-1.5" defaultValue={c.articleUrl ?? ""} placeholder="Ссылка на статью" />
                        <input name="note" className="input py-1.5" defaultValue={c.note ?? ""} placeholder="Заметка" />
                        <input type="hidden" name="status" value={c.status} />
                        <div className="flex gap-2"><SubmitButton className="btn-primary btn-sm" pendingText="…">Сохранить</SubmitButton></div>
                      </ActionForm>
                    </details>
                    <ActionForm action={deleteProjectCluster} hidden={{ accessId, id: c.id }} className="inline ml-2"><SubmitButton className="text-[12.5px] text-muted hover:text-danger" pendingText="…" confirm="Удалить кластер?">×</SubmitButton></ActionForm>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          <ActionForm action={addProjectClustersBulk} hidden={{ accessId }} className="space-y-2">
            <div className="label">Добавить списком</div>
            <textarea name="lines" className="input min-h-[90px]" placeholder={"По одному на строку: название | сколько ключей\nnail designs 2027 | 40\nshort hairstyles | 25"} />
            <SubmitButton className="btn-primary btn-sm" pendingText="…">Добавить</SubmitButton>
          </ActionForm>
          <ActionForm action={saveProjectCluster} hidden={{ accessId }} className="space-y-2">
            <div className="label">Добавить один с ключами</div>
            <input name="name" className="input py-1.5" placeholder="Название кластера" />
            <textarea name="keywords" className="input py-1.5 min-h-[50px]" placeholder="Ключи — по одному на строку" />
            <div className="flex gap-2"><input name="articleUrl" className="input py-1.5" placeholder="Ссылка на статью (если есть)" /><SubmitButton className="btn-ghost btn-sm" pendingText="…">Добавить</SubmitButton></div>
          </ActionForm>
        </div>
      </Card>
    </div>
  );
}
