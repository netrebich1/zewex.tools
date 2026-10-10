/**
 * Права сотрудников. Админ (User.role = ADMIN) может всё, его права не настраиваются.
 * У участника (MEMBER) набор `Permissions` хранится в `User.permissions` (JSON); пустое поле — права по умолчанию.
 *
 * Уровни «своя команда» считаются по командам, в которых состоит сотрудник. Лидер команды (TeamMember.role = LEAD)
 * дополнительно получает уровень «команда» в своей команде по ключам, правилам, расходу и составу — независимо
 * от личных прав. Все проверки — чистые функции от `CurrentUser`, чтобы работать и на сервере, и в клиентских формах.
 */

export type Permissions = {
  /** Расход: только свой / своих команд / всех. */
  usage: "own" | "team" | "all";
  /** Ключи ИИ: раздел скрыт / только личные / личные + командные + общие / все, включая чужие личные. */
  keysView: "none" | "own" | "team" | "all";
  /** Добавлять и редактировать ключи: нельзя / только личные / личные и командные / любые, включая общие. */
  keysCreate: "none" | "personal" | "team" | "all";
  /** Назначать и переназначать ключи (правила): нельзя / правила своих команд / любые правила, включая сервисы и глобальные. */
  keysAssign: "none" | "team" | "all";
  /** Команды: смотреть / управлять составом своих команд / создавать и управлять всеми командами. */
  teams: "view" | "manage" | "all";
  /** Провайдеры и модели: раздел скрыт / смотреть / менять настройки, модели и цены. */
  providers: "none" | "view" | "manage";
  /** Сайты: только сайты своих команд / все сайты. */
  sites: "team" | "all";
  /** Остатки на балансах провайдеров в шапке. */
  balances: boolean;
  /** Список пользователей: скрыт / только смотреть. Приглашать и менять права может только админ. */
  users: "none" | "view";
};

export type PermissionKey = keyof Permissions;

export const DEFAULT_PERMISSIONS: Permissions = {
  usage: "own",
  keysView: "team",
  keysCreate: "personal",
  keysAssign: "none",
  teams: "view",
  providers: "view",
  sites: "team",
  balances: false,
  users: "none",
};

export const ADMIN_PERMISSIONS: Permissions = {
  usage: "all",
  keysView: "all",
  keysCreate: "all",
  keysAssign: "all",
  teams: "all",
  providers: "manage",
  sites: "all",
  balances: true,
  users: "view",
};

/** Готовые профили: подставляются в форму, дальше можно подправить любое поле. */
export const PERMISSION_PRESETS: Record<string, { label: string; hint: string; value: Permissions }> = {
  member: {
    label: "Сотрудник",
    hint: "Работает в инструментах, видит свой расход, добавляет только личные ключи.",
    value: DEFAULT_PERMISSIONS,
  },
  lead: {
    label: "Лидер команды",
    hint: "Плюс расход, ключи, правила и состав своих команд.",
    value: { ...DEFAULT_PERMISSIONS, usage: "team", keysView: "team", keysCreate: "team", keysAssign: "team", teams: "manage" },
  },
  manager: {
    label: "Менеджер",
    hint: "Видит всё, управляет ключами, правилами, командами и провайдерами. Без управления пользователями.",
    value: { usage: "all", keysView: "all", keysCreate: "all", keysAssign: "all", teams: "all", providers: "manage", sites: "all", balances: true, users: "view" },
  },
};

type FieldMeta<K extends PermissionKey> = { key: K; label: string; hint?: string; options: Array<{ value: Permissions[K]; label: string }> };

/** Описание полей для формы прав (порядок — порядок в форме). */
export const PERMISSION_FIELDS: Array<FieldMeta<PermissionKey>> = [
  { key: "usage", label: "Расход", options: [{ value: "own", label: "Только свой" }, { value: "team", label: "Свой и своих команд" }, { value: "all", label: "Всех" }] },
  { key: "keysView", label: "Видит ключи ИИ", hint: "Секрет ключа никогда не показывается, только название и хвост.", options: [{ value: "none", label: "Раздел скрыт" }, { value: "own", label: "Только личные" }, { value: "team", label: "Личные, командные и общие" }, { value: "all", label: "Все, включая чужие личные" }] },
  { key: "keysCreate", label: "Добавляет и меняет ключи", options: [{ value: "none", label: "Нельзя" }, { value: "personal", label: "Только личные" }, { value: "team", label: "Личные и своих команд" }, { value: "all", label: "Любые, включая общие" }] },
  { key: "keysAssign", label: "Назначает ключи (правила)", hint: "Подключение ключей к сервисам и командам, правила на страницах инструментов.", options: [{ value: "none", label: "Только личные правила" }, { value: "team", label: "Правила своих команд" }, { value: "all", label: "Любые: сервисы, команды, глобальные" }] },
  { key: "teams", label: "Команды", options: [{ value: "view", label: "Только смотреть" }, { value: "manage", label: "Состав своих команд" }, { value: "all", label: "Создавать и управлять всеми" }] },
  { key: "sites", label: "Сайты", options: [{ value: "team", label: "Сайты своих команд" }, { value: "all", label: "Все сайты" }] },
  { key: "providers", label: "Провайдеры и модели", options: [{ value: "none", label: "Раздел скрыт" }, { value: "view", label: "Только смотреть" }, { value: "manage", label: "Менять настройки и модели" }] },
  { key: "balances", label: "Балансы провайдеров в шапке", options: [{ value: false, label: "Не показывать" }, { value: true, label: "Показывать" }] },
  { key: "users", label: "Пользователи", hint: "Приглашать людей и менять их права может только админ.", options: [{ value: "none", label: "Раздел скрыт" }, { value: "view", label: "Только смотреть" }] },
] as Array<FieldMeta<PermissionKey>>;

/** Разбирает JSON из базы или данные формы; неизвестные значения заменяются значениями по умолчанию. */
export function parsePermissions(raw: unknown): Permissions {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_PERMISSIONS } as Record<string, unknown>;
  for (const f of PERMISSION_FIELDS) {
    const v = src[f.key];
    const norm = typeof v === "string" && (v === "true" || v === "false") ? v === "true" : v;
    if (f.options.some((o) => o.value === norm)) out[f.key] = norm;
  }
  return out as Permissions;
}

export function permissionsFromForm(f: FormData): Permissions {
  const o: Record<string, unknown> = {};
  for (const k of PERMISSION_FIELDS) o[k.key] = f.get(k.key);
  return parsePermissions(o);
}

/** Какому готовому профилю соответствует набор; null — свои настройки. */
export function presetOf(p: Permissions): string | null {
  for (const [k, v] of Object.entries(PERMISSION_PRESETS)) if (PERMISSION_FIELDS.every((f) => v.value[f.key] === p[f.key])) return k;
  return null;
}

export function describePermissions(p: Permissions): string {
  const k = presetOf(p);
  return k ? PERMISSION_PRESETS[k].label : "Свои настройки";
}

/** Права действующего пользователя; админу — всё. */
export function resolvePermissions(role: string, raw: unknown): Permissions {
  return role === "ADMIN" ? ADMIN_PERMISSIONS : parsePermissions(raw);
}

/* ---------- Проверки. `Actor` — минимум из CurrentUser, чтобы не тянуть auth.ts на клиент. ---------- */

export type Actor = { id: string; role: string; teamIds: string[]; leadTeamIds: string[]; perms: Permissions };

/** Команды уровня «своя команда»: все команды пользователя плюс те, где он лидер. */
function ownTeams(u: Actor): string[] {
  return [...new Set([...u.teamIds, ...u.leadTeamIds])];
}

/** "all" — любые команды; иначе список id. */
export type TeamScope = "all" | string[];
export const inScope = (scope: TeamScope, teamId: string | null | undefined) => scope === "all" || (!!teamId && scope.includes(teamId));

/* Расход */
export function usageScope(u: Actor): TeamScope {
  if (u.role === "ADMIN" || u.perms.usage === "all") return "all";
  return u.perms.usage === "team" ? ownTeams(u) : u.leadTeamIds;
}
/** Условие для UsageLog.findMany / groupBy: свои вызовы + вызовы по командам из области. */
export function usageWhere(u: Actor): Record<string, unknown> {
  const s = usageScope(u);
  if (s === "all") return {};
  if (!s.length) return { userId: u.id };
  return { OR: [{ userId: u.id }, { teamId: { in: s } }, { user: { memberships: { some: { teamId: { in: s } } } } }] };
}

/* Ключи */
export function canViewKeys(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.keysView !== "none" || u.leadTeamIds.length > 0;
}
/** Условие для ApiKey.findMany; null — раздел недоступен. */
export function keyWhere(u: Actor): Record<string, unknown> | null {
  if (u.role === "ADMIN" || u.perms.keysView === "all") return {};
  const or: Record<string, unknown>[] = [{ ownerId: u.id }];
  if (u.perms.keysView === "team") or.push({ ownerId: null, teamId: null }, { teamId: { in: ownTeams(u) } });
  else if (u.leadTeamIds.length) or.push({ teamId: { in: u.leadTeamIds } });
  if (u.perms.keysView === "none" && !u.leadTeamIds.length) return null;
  return { OR: or };
}
export type KeyRef = { ownerId: string | null; teamId: string | null };
export function canViewKey(u: Actor, k: KeyRef): boolean {
  if (u.role === "ADMIN" || u.perms.keysView === "all") return true;
  if (k.ownerId) return k.ownerId === u.id;
  if (k.teamId) return (u.perms.keysView === "team" && ownTeams(u).includes(k.teamId)) || u.leadTeamIds.includes(k.teamId);
  return u.perms.keysView === "team";
}
/** Команды, для которых пользователь может заводить и править командные ключи. */
export function keyTeamScope(u: Actor): TeamScope {
  if (u.role === "ADMIN" || u.perms.keysCreate === "all") return "all";
  return u.perms.keysCreate === "team" ? ownTeams(u) : u.leadTeamIds;
}
export function canCreateSharedKey(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.keysCreate === "all";
}
export function canCreatePersonalKey(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.keysCreate !== "none";
}
export function canCreateKey(u: Actor): boolean {
  const s = keyTeamScope(u);
  return canCreatePersonalKey(u) || s === "all" || s.length > 0;
}
/** Редактировать, проверять, удалять ключ. */
export function canManageKey(u: Actor, k: KeyRef): boolean {
  if (u.role === "ADMIN") return true;
  if (k.ownerId) return k.ownerId === u.id && canCreatePersonalKey(u);
  if (k.teamId) return inScope(keyTeamScope(u), k.teamId);
  return canCreateSharedKey(u);
}

/* Правила (назначение ключей) */
export function assignScope(u: Actor): TeamScope {
  if (u.role === "ADMIN" || u.perms.keysAssign === "all") return "all";
  return u.perms.keysAssign === "team" ? ownTeams(u) : u.leadTeamIds;
}
export function canAssignGlobal(u: Actor): boolean {
  return assignScope(u) === "all";
}
export function canAssignAny(u: Actor): boolean {
  const s = assignScope(u);
  return s === "all" || s.length > 0;
}
/** Подключать ключ к сервисам и командам со страницы ключа (личные ключи — только личным правилом). */
export function canAssignKey(u: Actor, k: KeyRef): boolean {
  if (k.ownerId) return false;
  if (k.teamId) return inScope(assignScope(u), k.teamId);
  return canAssignAny(u);
}
/** Может ли ключ стоять в правиле: личный — только у владельца, командный — только в его команде (или у участника этой команды). */
export function keyFitsRule(k: KeyRef, rule: { scope: string; teamId: string | null; userId: string | null; userTeamIds?: string[] }): string | null {
  if (k.ownerId) return rule.scope === "USER_PROJECT" && rule.userId === k.ownerId ? null : "Личный ключ можно назначить только в личное правило его владельца";
  if (k.teamId) {
    if (rule.scope === "TEAM" || rule.scope === "TEAM_PROJECT") return rule.teamId === k.teamId ? null : "Командный ключ можно назначить только правилам его команды";
    if (rule.scope === "USER_PROJECT") return rule.userTeamIds?.includes(k.teamId) ? null : "Командный ключ доступен только участникам этой команды";
    return "Командный ключ нельзя сделать ключом сервиса по умолчанию или глобальным";
  }
  return null;
}

/** Удалить правило: своё личное — каждый; командное — в области назначения; сервиса/глобальное — «любые правила». */
export function canDeleteBinding(u: Actor, b: { scope: string; userId: string | null; teamId: string | null }): boolean {
  if (b.scope === "USER_PROJECT") return b.userId === u.id || canAssignGlobal(u);
  if (b.teamId) return inScope(assignScope(u), b.teamId);
  return canAssignGlobal(u);
}

/* Команды */
export function canManageTeam(u: Actor, teamId: string): boolean {
  if (u.role === "ADMIN" || u.perms.teams === "all") return true;
  if (u.perms.teams === "manage" && u.teamIds.includes(teamId)) return true;
  return u.leadTeamIds.includes(teamId);
}
export function canCreateTeam(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.teams === "all";
}

/* Прочее */
export function seesAllSites(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.sites === "all";
}
export function canViewProviders(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.providers !== "none";
}
export function canManageProviders(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.providers === "manage";
}
export function canSeeBalances(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.balances;
}
export function canViewUsers(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.users === "view";
}
/** Проверка маршрута за другого человека: админ и «любые правила» — за кого угодно, уровень команды — за участников своих команд. */
export function routeCheckScope(u: Actor): TeamScope {
  return assignScope(u);
}
