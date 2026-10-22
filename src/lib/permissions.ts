/**
 * Права сотрудников. Админ (User.role = ADMIN) может всё, его права не настраиваются.
 * У участника (MEMBER) набор `Permissions` хранится в `User.permissions` (JSON); пустое поле — права по умолчанию.
 *
 * Уровни «своя команда» считаются по командам, в которых состоит сотрудник. Лидер команды (TeamMember.role = LEAD)
 * дополнительно получает уровень «команда» в своей команде по ключам, правилам, расходу и составу — независимо
 * от личных прав. Все проверки — чистые функции от `CurrentUser`, чтобы работать и на сервере, и в клиентских формах.
 */

export type Permissions = {
  /** Расход: раздел скрыт / только свой / своих команд / всех. */
  usage: "none" | "own" | "team" | "all";
  /** Ключи ИИ: раздел скрыт / только личные / личные + командные + общие / все, включая чужие личные. */
  keysView: "none" | "own" | "team" | "all";
  /** Добавлять и редактировать ключи: нельзя / только личные / личные и командные / любые, включая общие. */
  keysCreate: "none" | "personal" | "team" | "all";
  /** Назначать и переназначать ключи (правила): нельзя / правила своих команд / любые правила, включая сервисы и глобальные. */
  keysAssign: "none" | "team" | "all";
  /** Команды: раздел скрыт / смотреть / управлять составом своих команд / создавать и управлять всеми командами. */
  teams: "none" | "view" | "manage" | "all";
  /** Провайдеры и модели: раздел скрыт / смотреть / менять настройки, модели и цены. */
  providers: "none" | "view" | "manage";
  /**
   * Сайты: только свои (где отмечен) / все сайты, но только на вкладке «Сайты» / все сайты везде.
   * «system» — сотрудник видит и правит любой сайт в разделе «Сайты» (REST API, команды, видимость, подключение инструментов),
   * а в самих инструментах (пины, статьи, DeepL) видит только свои сайты, как при «team».
   */
  sites: "team" | "system" | "all";
  /** Балансы в шапке: скрыты / только ключи своей команды в открытых сотруднику инструментах / все провайдеры. */
  balances: "none" | "own" | "all";
  /** Список пользователей: скрыт / только смотреть. Добавлять людей и менять права может только админ. */
  users: "none" | "view";
  /**
   * Какие инструменты видит сотрудник: "all" — все, включая будущие; иначе список slug проектов (пустой — ни одного).
   * Задаётся галочками (`ToolsAccessFields`), в готовые профили не входит.
   */
  tools: "all" | string[];
};

/** Поля-переключатели формы прав; список инструментов настраивается отдельно. */
export type PermissionKey = Exclude<keyof Permissions, "tools">;

export const DEFAULT_PERMISSIONS: Permissions = {
  usage: "none",
  keysView: "team",
  keysCreate: "personal",
  keysAssign: "none",
  teams: "none",
  providers: "view",
  sites: "team",
  balances: "own",
  users: "none",
  tools: [],
};

export const ADMIN_PERMISSIONS: Permissions = {
  usage: "all",
  keysView: "all",
  keysCreate: "all",
  keysAssign: "all",
  teams: "all",
  providers: "manage",
  sites: "all",
  balances: "all",
  users: "view",
  tools: "all",
};

/** Готовые профили: подставляются в форму, дальше можно подправить любое поле. */
export const PERMISSION_PRESETS: Record<string, { label: string; hint: string; value: Permissions }> = {
  member: {
    label: "Сотрудник",
    hint: "Работает в отмеченных инструментах. Расход и команды скрыты, добавляет только личные ключи.",
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
    value: { usage: "all", keysView: "all", keysCreate: "all", keysAssign: "all", teams: "all", providers: "manage", sites: "all", balances: "all", users: "view", tools: [] },
  },
};

type FieldMeta<K extends PermissionKey> = { key: K; label: string; hint?: string; options: Array<{ value: Permissions[K]; label: string }> };

/** Описание полей для формы прав (порядок — порядок в форме). */
export const PERMISSION_FIELDS: Array<FieldMeta<PermissionKey>> = [
  { key: "usage", label: "Расход", options: [{ value: "none", label: "Раздел скрыт" }, { value: "own", label: "Только свой" }, { value: "team", label: "Свой и своих команд" }, { value: "all", label: "Всех" }] },
  { key: "keysView", label: "Видит ключи ИИ", hint: "Секрет ключа никогда не показывается, только название и хвост.", options: [{ value: "none", label: "Раздел скрыт" }, { value: "own", label: "Только личные" }, { value: "team", label: "Личные, командные и общие" }, { value: "all", label: "Все, включая чужие личные" }] },
  { key: "keysCreate", label: "Добавляет и меняет ключи", options: [{ value: "none", label: "Нельзя" }, { value: "personal", label: "Только личные" }, { value: "team", label: "Личные и своих команд" }, { value: "all", label: "Любые, включая общие" }] },
  { key: "keysAssign", label: "Назначает ключи (правила)", hint: "Подключение ключей к сервисам и командам, правила на страницах инструментов.", options: [{ value: "none", label: "Только личные правила" }, { value: "team", label: "Правила своих команд" }, { value: "all", label: "Любые: сервисы, команды, глобальные" }] },
  { key: "teams", label: "Команды", options: [{ value: "none", label: "Раздел скрыт" }, { value: "view", label: "Только смотреть" }, { value: "manage", label: "Состав своих команд" }, { value: "all", label: "Создавать и управлять всеми" }] },
  { key: "sites", label: "Сайты", hint: "«Только на вкладке „Сайты“» — заводит доступы и подключает любые сайты к инструментам, а внутри инструментов видит только свои.", options: [{ value: "team", label: "Только свои сайты (где отмечен)" }, { value: "system", label: "Все сайты — только на вкладке «Сайты»" }, { value: "all", label: "Все сайты" }] },
  { key: "providers", label: "Провайдеры и модели", options: [{ value: "none", label: "Раздел скрыт" }, { value: "view", label: "Только смотреть" }, { value: "manage", label: "Менять настройки и модели" }] },
  { key: "balances", label: "Балансы в шапке", hint: "«Свои» — ключи команды сотрудника в открытых ему инструментах.", options: [{ value: "none", label: "Не показывать" }, { value: "own", label: "Только свои ключи" }, { value: "all", label: "Все провайдеры" }] },
  { key: "users", label: "Пользователи", hint: "Добавлять людей и менять их права может только админ.", options: [{ value: "none", label: "Раздел скрыт" }, { value: "view", label: "Только смотреть" }] },
] as Array<FieldMeta<PermissionKey>>;

/** Разбирает JSON из базы или данные формы; неизвестные значения заменяются значениями по умолчанию. */
export function parsePermissions(raw: unknown): Permissions {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_PERMISSIONS } as Record<string, unknown>;
  for (const f of PERMISSION_FIELDS) {
    const v = src[f.key];
    // Раньше «балансы» были флажком: true — все провайдеры, false — без общей плашки.
    const norm = f.key === "balances" && typeof v === "boolean" ? (v ? "all" : "own") : v;
    if (f.options.some((o) => o.value === norm)) out[f.key] = norm;
  }
  out.tools = src.tools === "all" ? "all" : Array.isArray(src.tools) ? [...new Set(src.tools.filter((x): x is string => typeof x === "string" && !!x))] : DEFAULT_PERMISSIONS.tools;
  return out as Permissions;
}

/**
 * Права из формы. Список инструментов берётся из полей `ToolsAccessFields` (маркер `toolsPresent`);
 * если форма их не прислала, остаётся прежний список `keepTools`.
 */
export function permissionsFromForm(f: FormData, keepTools?: Permissions["tools"]): Permissions {
  const o: Record<string, unknown> = {};
  for (const k of PERMISSION_FIELDS) o[k.key] = f.get(k.key);
  o.tools = f.has("toolsPresent") ? (f.get("toolsAll") ? "all" : f.getAll("tools").map(String)) : keepTools;
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

/** Подпись к списку инструментов сотрудника: «все инструменты», «инструментов: 2», «нет инструментов». */
export function describeTools(p: Permissions): string {
  if (p.tools === "all") return "все инструменты";
  return p.tools.length ? `инструментов: ${p.tools.length}` : "нет инструментов";
}

/** Права действующего пользователя; админу — всё. */
export function resolvePermissions(role: string, raw: unknown): Permissions {
  return role === "ADMIN" ? ADMIN_PERMISSIONS : parsePermissions(raw);
}

/* ---------- Проверки. `Actor` — минимум из CurrentUser, чтобы не тянуть auth.ts на клиент. ---------- */

export type Actor = { id: string; role: string; teamIds: string[]; leadTeamIds: string[]; perms: Permissions; privateTools?: string[] };

/** Команды уровня «своя команда»: все команды пользователя плюс те, где он лидер. */
function ownTeams(u: Actor): string[] {
  return [...new Set([...u.teamIds, ...u.leadTeamIds])];
}

/** "all" — любые команды; иначе список id. */
export type TeamScope = "all" | string[];
export const inScope = (scope: TeamScope, teamId: string | null | undefined) => scope === "all" || (!!teamId && scope.includes(teamId));

/* Инструменты */
/**
 * Закрытые инструменты: роль и `perms.tools` их не открывают, даже админу. Доступ — запись `ToolAccess`
 * (выдаёт владелец портала на странице пользователя), владелец видит их всегда. Список — в `CurrentUser.privateTools`.
 */
export const PRIVATE_TOOLS = ["finance"] as const;
export const isPrivateTool = (slug: string) => (PRIVATE_TOOLS as readonly string[]).includes(slug);

export function canUseTool(u: Actor, slug: string): boolean {
  if (isPrivateTool(slug)) return !!u.privateTools?.includes(slug);
  return u.role === "ADMIN" || u.perms.tools === "all" || u.perms.tools.includes(slug);
}
/** Условие для Project.findMany: только инструменты, открытые сотруднику (закрытые — только выданные). */
export function toolWhere(u: Actor): Record<string, unknown> {
  const hidden = PRIVATE_TOOLS.filter((s) => !u.privateTools?.includes(s));
  const base = u.role === "ADMIN" || u.perms.tools === "all" ? {} : { slug: { in: [...u.perms.tools, ...(u.privateTools ?? [])] } };
  return hidden.length ? { AND: [base, { slug: { notIn: hidden } }] } : base;
}
/** Условие для списков инструментов в настройках (ключи, сайты, галочки прав): без закрытых. */
export const publicToolWhere = { slug: { notIn: [...PRIVATE_TOOLS] } };

/* Расход */
/** Раздел «Расход» в меню; лидер команды всегда видит расход своей команды. */
export function canViewUsage(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.usage !== "none" || u.leadTeamIds.length > 0;
}
/** Суммы расхода других людей внутри инструментов (журналы, сводки): уровень «команда» и выше, а также лидер команды. */
export function seesTeamCosts(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.usage === "team" || u.perms.usage === "all" || u.leadTeamIds.length > 0;
}
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
/** Раздел «Команды» в меню; лидер всегда видит свою команду. */
export function canViewTeams(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.teams !== "none" || u.leadTeamIds.length > 0;
}
export function canViewTeam(u: Actor, teamId: string): boolean {
  return u.role === "ADMIN" || u.perms.teams !== "none" || u.leadTeamIds.includes(teamId);
}
/** Условие для Team.findMany; null — раздел недоступен. */
export function teamWhere(u: Actor): Record<string, unknown> | null {
  if (u.role === "ADMIN" || u.perms.teams !== "none") return {};
  return u.leadTeamIds.length ? { id: { in: u.leadTeamIds } } : null;
}
export function canManageTeam(u: Actor, teamId: string): boolean {
  if (u.role === "ADMIN" || u.perms.teams === "all") return true;
  if (u.perms.teams === "manage" && u.teamIds.includes(teamId)) return true;
  return u.leadTeamIds.includes(teamId);
}
export function canCreateTeam(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.teams === "all";
}

/* Прочее */
/** Все сайты везде: в разделе «Сайты» и во всех инструментах. */
export function seesAllSites(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.sites === "all";
}
/**
 * Пользователь для страниц и действий раздела «Сайты»: право «system» там действует как «all».
 * Применять только в `/sites/*` и в действиях, которые вызываются с этих страниц (сохранить доступ,
 * проверить подключение, подключить/отключить инструмент). В инструментах — обычный `me`.
 */
export function forSitesTab<T extends Actor>(u: T): T {
  return u.perms.sites === "system" ? { ...u, perms: { ...u.perms, sites: "all" } } : u;
}
export function canViewProviders(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.providers !== "none";
}
export function canManageProviders(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.providers === "manage";
}
/** Балансы всех провайдеров (плашка админа). */
export function canSeeBalances(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.balances === "all";
}
/** Плашка балансов в шапке вообще: у сотрудника — только ключи его команды в его инструментах. */
export function showsBalances(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.balances !== "none";
}
export function canViewUsers(u: Actor): boolean {
  return u.role === "ADMIN" || u.perms.users === "view";
}
/** Проверка маршрута за другого человека: админ и «любые правила» — за кого угодно, уровень команды — за участников своих команд. */
export function routeCheckScope(u: Actor): TeamScope {
  return assignScope(u);
}
