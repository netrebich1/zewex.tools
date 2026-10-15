import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { OpFormRefs } from "@/components/finance/OpForm";
import { asDisplay, DISPLAY_COOKIE } from "./currency";
import { displayFactor } from "./rates";
import { loadRefs } from "./report";

/** Общее для страниц финансов: справочники, данные формы, валюта показа и множитель из EUR. */
export async function financeContext(me: CurrentUser) {
  const [refs, jar, accountRows] = await Promise.all([
    loadRefs(),
    cookies(),
    prisma.finOp.findMany({ where: { account: { not: null }, deletedAt: null }, select: { account: true }, distinct: ["account"], orderBy: { createdAt: "desc" }, take: 40 }),
  ]);
  const cur = asDisplay(jar.get(DISPLAY_COOKIE)?.value);
  const factor = await displayFactor(cur);
  const form: OpFormRefs = {
    dirs: refs.dirOptions.filter((d) => !d.archived).map((d) => ({ id: d.id, name: d.name, label: d.label, parentId: d.parentId })),
    cats: refs.cats.filter((c) => !c.archived).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    partners: refs.partners.map((p) => ({ id: p.id, label: p.name })),
    accounts: accountRows.map((a) => a.account!).filter(Boolean),
    counterparties: refs.counterparties.filter((c) => !c.archived).map((c) => ({ id: c.id, name: c.name, categoryIds: c.categoryIds })),
  };
  const myPartnerId = refs.partners.find((p) => p.userId === me.id)?.id;
  return { refs, form, cur, factor, myPartnerId, money: (eur: number) => eur * factor };
}
