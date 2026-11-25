import { asPeriod, dateWhere, periodRange } from "./report";

/** Фильтры журнала из адреса: p (период) или from/to, dir, who, type, cat, cp (контрагент), q. Общие для страницы и CSV. Удалённые не показываются. */
export type OpsFilter = { p?: string; from?: string; to?: string; dir?: string; who?: string; type?: string; cat?: string; cp?: string; q?: string };

export function opsWhere(f: OpsFilter): Record<string, unknown> {
  const and: Record<string, unknown>[] = [{ deletedAt: null }];
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (f.from && re.test(f.from) || f.to && re.test(f.to)) {
    and.push({ date: { ...(f.from && re.test(f.from) ? { gte: new Date(`${f.from}T00:00:00Z`) } : {}), ...(f.to && re.test(f.to) ? { lte: new Date(`${f.to}T00:00:00Z`) } : {}) } });
  } else and.push(dateWhere(periodRange(asPeriod(f.p, "all"))));
  if (f.dir === "none") and.push({ directionId: null });
  else if (f.dir) and.push({ OR: [{ directionId: f.dir }, { direction: { parentId: f.dir } }] });
  if (f.who) and.push({ OR: [{ partnerId: f.who }, { toPartnerId: f.who }] });
  if (f.type && ["EXPENSE", "INCOME", "SETTLEMENT"].includes(f.type)) and.push({ type: f.type });
  if (f.cat === "none") and.push({ categoryId: null });
  else if (f.cat) and.push({ categoryId: f.cat });
  if (f.cp) and.push({ counterpartyId: f.cp });
  if (f.q) and.push({ OR: [{ note: { contains: f.q } }, { account: { contains: f.q } }, { currency: { contains: f.q } }, { counterparty: { name: { contains: f.q } } }] });
  return { AND: and };
}
