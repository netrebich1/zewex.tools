import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, PageHeader } from "@/components/ui";
import { AutoForm } from "@/components/projects/AutoForm";
import { requireUploader, visiblePinSites } from "@/lib/uploader/access";
import { setAccountStatusAction, setProfileAction } from "@/actions/uploader";
import { AccountBadge, dt } from "@/components/uploader/ui";
import { ProfileSelect } from "@/components/uploader/ProfileSelect";

export const dynamic = "force-dynamic";

/** Сопоставление: сайт ↔ профиль Dolphin (1:1), состояние аккаунта Pinterest, журнал по аккаунту. */
export default async function UploaderMappingPage() {
  const me = await requireUploader();
  const sites = await visiblePinSites(me);
  const [accounts, profiles, lastEvents] = await Promise.all([
    prisma.uplAccount.findMany({ where: { pinSiteId: { in: sites.map((s) => s.id) } } }),
    prisma.uplProfile.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, seenAt: true } }),
    prisma.uplEvent.findMany({ where: { pinSiteId: { in: sites.map((s) => s.id) }, result: { not: "ok" } }, orderBy: { at: "desc" }, take: 30 }),
  ]);
  const accBy = new Map(accounts.map((a) => [a.pinSiteId, a]));
  const takenBy = new Map<string, string>();
  for (const a of accounts) if (a.profileId) takenBy.set(a.profileId, a.pinSiteId);
  const nameBy = new Map(sites.map((s) => [s.id, s.name]));
  const now = new Date();
  const unmapped = sites.filter((s) => !accBy.get(s.id)?.profileId).length;

  return (
    <>
      <PageHeader title="Сопоставление сайтов и профилей" subtitle="Один сайт = один аккаунт Pinterest = один профиль Dolphin Anty. Список профилей присылает агент, когда выходит на связь (раз в час)." />
      <div className="space-y-4">
        {!profiles.length && <Card><p className="help">Профилей пока нет: запустите агент на ПК с открытым Dolphin Anty — он пришлёт список. <Link href="/pinterest/uploader/agents" className="underline">Агенты</Link>.</p></Card>}
        <Card title={`Сайты · ${sites.length}`} description={unmapped ? `Без профиля: ${unmapped}. Выберите профиль в строке — сохраняется сразу.` : "Все сайты сопоставлены."}>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Сайт</th><th>Профиль Dolphin</th><th>Аккаунт Pinterest</th><th>Последняя заливка</th><th>Состояние</th><th></th></tr></thead>
            <tbody>{sites.map((s) => {
              const a = accBy.get(s.id);
              const options = profiles.filter((p) => !takenBy.has(p.id) || takenBy.get(p.id) === s.id);
              return (
                <tr key={s.id} className={a?.profileId ? "" : "bg-warn-soft/40"}>
                  <td className="font-medium">{s.wpConnectionId ? <Link href={`/pinterest/projects/${s.wpConnectionId}`} className="hover:underline">{s.name}</Link> : s.name}</td>
                  <td className="min-w-[260px]">
                    <AutoForm action={setProfileAction} hidden={{ pinSiteId: s.id }} showOk>
                      <ProfileSelect name="profileId" value={a?.profileId ?? ""} options={options.map((p) => ({ id: p.id, name: p.name }))} />
                    </AutoForm>
                  </td>
                  <td className="help">{a?.pinUsername ? `@${a.pinUsername}` : "—"}</td>
                  <td className="help whitespace-nowrap">{a?.lastUploadAt ? dt(a.lastUploadAt) : "—"}</td>
                  <td>{a ? <><AccountBadge status={a.status} />{a.pausedUntil && a.pausedUntil > now ? <span className="help ml-1">до {dt(a.pausedUntil)}</span> : null}{a.lastError ? <div className="text-[12px] text-danger">{a.lastError}</div> : null}</> : <span className="help">—</span>}</td>
                  <td>
                    <AutoForm action={setAccountStatusAction} hidden={{ pinSiteId: s.id }} className="inline">
                      <select name="status" className="input py-1 text-[12.5px]" defaultValue={a?.status ?? "ok"} key={`${s.id}-${a?.status ?? "ok"}`}>
                        <option value="ok">Работает</option><option value="needs_login">Нужен вход</option><option value="paused">Пауза</option><option value="off">Выключен</option><option value="banned">Заблокирован</option>
                      </select>
                    </AutoForm>
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </Card>
        {lastEvents.length > 0 && (
          <Card title="Последние проблемы по аккаунтам">
            <ul className="space-y-1 text-[13px]">{lastEvents.map((e) => <li key={e.id}><span className="help">{dt(e.at)}</span> · <b>{nameBy.get(e.pinSiteId) ?? "сайт"}</b> · {e.kind}: {e.summary}</li>)}</ul>
          </Card>
        )}
      </div>
    </>
  );
}
