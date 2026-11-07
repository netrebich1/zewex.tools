import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DeeplNav } from "@/components/deepl/DeeplNav";
import { addDeeplProxies, updateDeeplProxy } from "@/actions/deeplProxies";
import { keysPerProxy } from "@/lib/deepl/net";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** SOCKS5-прокси для запросов к API DeepL: у каждого ключа свой постоянный прокси. */
export default async function DeeplProxiesPage() {
  await requireUser();
  const [proxies, perProxy] = await Promise.all([prisma.deeplProxy.findMany({ orderBy: { createdAt: "asc" } }), keysPerProxy()]);
  const active = proxies.filter((p) => p.isActive).length;
  const dead = proxies.filter((p) => !p.isActive || p.lastCheckOk === false).length;

  return (
    <>
      <DeeplNav />
      <PageHeader
        back={{ href: "/discovery/deepl/keys", label: "Ключи DeepL" }}
        title="Прокси DeepL"
        subtitle="Если список не пуст, все запросы к DeepL — перевод, проверка ключей, расход — идут через SOCKS5-прокси, а не с IP сервера. Каждый ключ всегда ходит через один и тот же прокси: аккаунты DeepL не светятся с одного адреса. Если прокси заведены, но ни один не работает, запросы напрямую не уходят — перевод встанет с ошибкой «все прокси выключены»."
      />

      <div className="grid grid-cols-2 gap-3 mb-5 sm:grid-cols-4">
        {[
          { label: `Прокси в работе (из ${proxies.length})`, value: active },
          { label: "Выключены / не прошли проверку", value: dead },
          { label: "Ключей на прокси", value: [...perProxy.values()].reduce((a, n) => a + n, 0) },
          { label: "Режим", value: proxies.length ? "через прокси" : "напрямую" },
        ].map((s) => (
          <div key={s.label} className="kpi">
            <div className="kpi-value">{s.value}</div>
            <div className="help">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="space-y-5">
        <Card title="Добавить прокси" description="SOCKS5, по одному в строке: ip:port:логин:пароль. Подходят и user:pass@ip:port, socks5://user:pass@ip:port, ip:port без пароля. Повторы пропускаются, новые прокси сразу проверяются.">
          <ActionForm action={addDeeplProxies} className="space-y-3">
            <textarea name="proxies" className="input min-h-[160px] font-mono text-[13px]" autoComplete="off" spellCheck={false} placeholder={"177.202.205.99:63457:login:password\n172.120.163.17:64433:login:password"} />
            <SubmitButton className="btn-brand" pendingText="Добавляю и проверяю…">Добавить прокси</SubmitButton>
          </ActionForm>
        </Card>

        <Card
          title={`Список прокси (${proxies.length})`}
          description="«Проверить» узнаёт внешний IP прокси и доступен ли через него API DeepL. Прокси, который трижды подряд не ответил при работе, выключается сам."
          actions={proxies.length ? (
            <>
              <ActionForm action={updateDeeplProxy} className="inline" hidden={{ id: "", op: "check_all" }}>
                <SubmitButton className="btn-primary btn-sm" pendingText="Проверяю…">Проверить все</SubmitButton>
              </ActionForm>
              {dead > 0 && (
                <ActionForm action={updateDeeplProxy} className="inline" hidden={{ id: "", op: "delete_dead" }}>
                  <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить ${dead} выключенных и нерабочих прокси?`}>Удалить нерабочие ({dead})</SubmitButton>
                </ActionForm>
              )}
            </>
          ) : null}
        >
          {proxies.length === 0 ? <p className="help">Прокси нет — DeepL получает запросы прямо с IP сервера.</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>Прокси</th><th>Статус</th><th>Проверка</th><th>Ключей</th><th className="col-sm">Добавлен</th><th></th></tr></thead>
                <tbody>
                  {proxies.map((p, i) => (
                    <tr key={p.id}>
                      <td className="help">{i + 1}</td>
                      <td>
                        <div className="font-mono text-[13px]">{p.host}:{p.port}</div>
                        <div className="help">{p.username ? `логин ${p.username}` : "без логина"}{p.exitIp && p.exitIp !== p.host ? ` · выход ${p.exitIp}` : ""}</div>
                      </td>
                      <td className="max-w-[240px]">
                        <Badge tone={p.isActive ? "ok" : "neutral"}>{p.isActive ? "в работе" : "выключен"}</Badge>
                        {p.lastError && <div className="help text-danger line-clamp-2">{p.lastError}</div>}
                      </td>
                      <td className="max-w-[240px]">
                        {p.lastCheckedAt ? (
                          <>
                            <Badge tone={p.lastCheckOk ? "ok" : "danger"}>{p.lastCheckOk ? "работает" : "ошибка"}</Badge>
                            <div className="help">{fmtDate(p.lastCheckedAt)}</div>
                            {!p.lastCheckOk && p.lastCheckNote && <div className="help text-danger line-clamp-2">{p.lastCheckNote}</div>}
                          </>
                        ) : <span className="help">не проверялся</span>}
                      </td>
                      <td>{perProxy.get(p.id) ?? 0}</td>
                      <td className="col-sm whitespace-nowrap text-[13px]">{fmtDate(p.createdAt)}</td>
                      <td className="text-right whitespace-nowrap">
                        <ActionForm action={updateDeeplProxy} className="inline" hidden={{ id: p.id, op: "check" }}>
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…">Проверить</SubmitButton>
                        </ActionForm>
                        <ActionForm action={updateDeeplProxy} className="inline" hidden={{ id: p.id, op: "toggle" }}>
                          <SubmitButton className="btn-ghost btn-sm" pendingText="…" confirm={p.isActive && (perProxy.get(p.id) ?? 0) > 0 ? "Ключи этого прокси переедут на другие прокси (сменят IP). Выключить?" : undefined}>{p.isActive ? "Выключить" : "Включить"}</SubmitButton>
                        </ActionForm>
                        <ActionForm action={updateDeeplProxy} className="inline" hidden={{ id: p.id, op: "delete" }}>
                          <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить прокси ${p.host}:${p.port}?`}>Удалить</SubmitButton>
                        </ActionForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
