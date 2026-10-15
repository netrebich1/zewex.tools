import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/ActionForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DeeplNav } from "@/components/deepl/DeeplNav";
import { addDeeplKeys, refreshDeeplKeys, updateDeeplKey } from "@/actions/deepl";
import { fmtChars, keysSummary } from "@/lib/deepl/keys";
import { fmtDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const fmt = (n: number) => Math.round(n).toLocaleString("ru-RU");

/**
 * Ключи DeepL живут только в этом инструменте (не в общем разделе «Ключи» портала).
 * Как в исходном сервисе: у ключа название, лимит символов (свой или из DeepL), расход, порядок, «активен».
 */
export default async function DeeplKeysPage() {
  await requireUser();
  const [keys, sum] = await Promise.all([prisma.deeplKey.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }), keysSummary()]);

  return (
    <>
      <DeeplNav />
      <PageHeader
        back={{ href: "/discovery/deepl", label: "Прогоны" }}
        title="Ключи DeepL"
        subtitle="Ключи DeepL задаются только здесь, для этого инструмента. Ключей может быть сколько угодно: они работают параллельно — фрагменты статей раскладываются по всем рабочим ключам, а ключ, у которого не хватает лимита на фрагмент, пропускается до платного запроса."
      />

      <div className="grid grid-cols-2 gap-3 mb-5 sm:grid-cols-4">
        {[
          { label: `Ключей в работе (из ${sum.total})`, value: fmt(sum.working) },
          { label: "Осталось символов", value: sum.working === 0 ? "0" : sum.remaining == null ? "без лимита" : fmtChars(sum.remaining) },
          { label: sum.perArticle ? `Хватит примерно на статей (≈ ${fmtChars(sum.perArticle)} на статью)` : "Хватит на статей — появится после первого прогона", value: sum.remaining != null && sum.perArticle ? fmt(Math.floor(sum.remaining / sum.perArticle)) : "—" },
          { label: "Исчерпано / выключено", value: `${sum.exhausted} / ${sum.off}` },
        ].map((s) => (
          <div key={s.label} className="kpi">
            <div className="kpi-value">{s.value}</div>
            <div className="help">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="space-y-5">
        <Card title="Добавить ключи" description="Вставьте один или много ключей — каждый с новой строки. Можно с названием перед ключом: «Аккаунт 7 ключ». Каждый ключ проверяется в DeepL, повторы пропускаются.">
          <ActionForm action={addDeeplKeys} className="space-y-3">
            <textarea name="keys" className="input min-h-[160px] font-mono text-[13px]" autoComplete="off" spellCheck={false} placeholder={"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx\nАккаунт 2 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx\n…"} />
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="label">Лимит символов на ключ</span>
                <input name="limit" className="input w-48" placeholder="пусто — из DeepL" />
              </label>
              <p className="help max-w-md pb-2">Пусто — лимит возьмётся из DeepL (у бесплатного ключа 500 000 в месяц). Число — свой лимит, например 450000, чтобы оставить запас.</p>
              <SubmitButton className="btn-brand ml-auto" pendingText="Проверяю ключи в DeepL…">Добавить ключи</SubmitButton>
            </div>
          </ActionForm>
        </Card>

        <Card
          title={`Список ключей (${keys.length})`}
          description={`Ключ, на который DeepL ответил «лимит исчерпан» или «доступ запрещён», выключается сам. «Обновить расход» подтягивает потраченные символы из DeepL; в новом месяце исчерпанные ключи включаются сами. Последнее обновление: ${fmtDate(sum.lastUsageAt)}.`}
          actions={keys.length ? (
            <>
              <ActionForm action={refreshDeeplKeys} className="inline">
                <SubmitButton className="btn-primary btn-sm" pendingText="Обновляю…">Обновить расход из DeepL</SubmitButton>
              </ActionForm>
              {sum.exhausted + sum.off > 0 && (
                <ActionForm action={updateDeeplKey} className="inline" hidden={{ id: "", op: "delete_dead" }}>
                  <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить ${sum.exhausted + sum.off} исчерпанных и выключенных ключей?`}>Удалить исчерпанные ({sum.exhausted + sum.off})</SubmitButton>
                </ActionForm>
              )}
            </>
          ) : null}
        >
          {keys.length === 0 ? <p className="help">Ключей пока нет — без них перевод не запустится.</p> : (
            <>
              <ActionForm action={updateDeeplKey} className="mb-3 flex flex-wrap items-center gap-2" hidden={{ id: "", op: "limit_all" }}>
                <span className="text-[14px]">Задать лимит всем ключам:</span>
                <input name="limit" className="input w-40" placeholder="500000" />
                <SubmitButton className="btn-ghost btn-sm" pendingText="…" confirm="Поставить этот лимит всем ключам?">Применить</SubmitButton>
              </ActionForm>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>#</th><th>Ключ</th><th>Расход</th><th>Осталось</th><th>Лимит</th><th>Статус</th><th></th></tr></thead>
                  <tbody>
                    {keys.map((k, i) => {
                      const pct = k.charLimit ? Math.min(100, Math.round((k.charUsed / k.charLimit) * 100)) : 0;
                      const exhausted = k.charLimit != null && k.charUsed >= k.charLimit;
                      return (
                        <tr key={k.id}>
                          <td className="help">{i + 1}</td>
                          <td>
                            <div className="font-medium">{k.label}</div>
                            <div className="help font-mono">{k.hint}</div>
                          </td>
                          <td className="min-w-[170px]">
                            <div className="text-[13px]">{fmt(k.charUsed)} {k.charLimit ? `/ ${fmt(k.charLimit)} (${pct}%)` : ""}</div>
                            {k.charLimit ? <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink/10"><div className={`h-full ${pct >= 95 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-ok"}`} style={{ width: `${pct}%` }} /></div> : null}
                          </td>
                          <td className="whitespace-nowrap font-medium">{k.charLimit == null ? "без лимита" : fmt(Math.max(0, k.charLimit - k.charUsed))}</td>
                          <td>
                            <ActionForm action={updateDeeplKey} className="flex items-center gap-1" hidden={{ id: k.id, op: "limit" }}>
                              <input name="limit" className="input w-28 !py-1 text-[13px]" defaultValue={k.charLimit ?? ""} />
                              <SubmitButton className="btn-ghost btn-sm" pendingText="…">OK</SubmitButton>
                            </ActionForm>
                            <div className="help">
                              {k.limitManual ? "свой лимит" : "из DeepL"}
                              {k.limitManual && (
                                <ActionForm action={updateDeeplKey} className="inline" hidden={{ id: k.id, op: "limit_auto" }}>
                                  {" · "}<button type="submit" className="underline">брать из DeepL</button>
                                </ActionForm>
                              )}
                            </div>
                          </td>
                          <td>
                            <Badge tone={!k.isActive ? "neutral" : exhausted ? "warn" : "ok"}>{!k.isActive ? "выключен" : exhausted ? "исчерпан" : "в работе"}</Badge>
                            {k.lastError && <div className="help text-danger line-clamp-2 max-w-[220px]">{k.lastError}</div>}
                          </td>
                          <td className="text-right whitespace-nowrap">
                            {(["up", "down"] as const).map((op) => (
                              <ActionForm key={op} action={updateDeeplKey} className="inline" hidden={{ id: k.id, op }}>
                                <SubmitButton className="btn-ghost btn-sm" pendingText="…">{op === "up" ? "↑" : "↓"}</SubmitButton>
                              </ActionForm>
                            ))}
                            <ActionForm action={updateDeeplKey} className="inline" hidden={{ id: k.id, op: "toggle" }}>
                              <SubmitButton className="btn-ghost btn-sm" pendingText="…">{k.isActive ? "Выключить" : "Включить"}</SubmitButton>
                            </ActionForm>
                            <ActionForm action={updateDeeplKey} className="inline" hidden={{ id: k.id, op: "delete" }}>
                              <SubmitButton className="btn-ghost btn-sm text-danger" pendingText="…" confirm={`Удалить ключ «${k.label}»?`}>Удалить</SubmitButton>
                            </ActionForm>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
