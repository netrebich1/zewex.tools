"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, hashPassword, requireAdmin, requireUser } from "@/lib/auth";
import { encryptSecret, decryptSecret, randomToken, secretHint } from "@/lib/crypto";
import { checkKey, fetchModels } from "@/lib/adapters";
import { parseNumber, slugify } from "@/lib/utils";
import {
  assignScope, canAssignGlobal, canAssignKey, canCreatePersonalKey, canCreateSharedKey, canCreateTeam, canDeleteBinding, canManageKey, canManageProviders,
  canManageTeam, inScope, keyFitsRule, keyTeamScope, permissionsFromForm, type Actor,
} from "@/lib/permissions";
import type { Capability, BindingScope } from "@prisma/client";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const CAPS: Capability[] = ["CHAT", "IMAGE", "EMBEDDING", "SERP", "SEO_DATA"];
const SCOPES: BindingScope[] = ["USER_PROJECT", "TEAM_PROJECT", "PROJECT", "TEAM", "GLOBAL"];

function fail(e: unknown): FormState {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Unique constraint/.test(msg)) return { error: "Такая запись уже существует (совпадает название или код)" };
  if (/Restrict|foreign key/i.test(msg)) return { error: "Нельзя удалить: на запись ссылаются другие объекты" };
  return { error: msg };
}

/** Provider base URLs must point at a public HTTPS host, never at the server itself or the local network. */
function validateBaseUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "Некорректный базовый адрес"; }
  if (u.protocol !== "https:") return "Базовый адрес должен начинаться с https://";
  const h = u.hostname.toLowerCase();
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(":");
  if (isIp || h === "localhost" || !h.includes(".") || /\.(local|internal|lan|localhost)$/.test(h)) return "Укажите публичный домен провайдера, а не локальный адрес";
  return null;
}

/** First enabled model of a provider: used to probe keys of providers that have no /models endpoint. */
async function probeModelFor(providerId: string): Promise<string | null> {
  const m = await prisma.model.findFirst({ where: { providerId, isEnabled: true }, orderBy: { createdAt: "asc" } });
  return m?.modelId ?? null;
}

async function uniqueSlug(table: "project" | "team" | "section", base: string): Promise<string> {
  let slug = slugify(base);
  for (let i = 2; i < 50; i++) {
    const exists =
      table === "project" ? await prisma.project.findUnique({ where: { slug } })
      : table === "team" ? await prisma.team.findUnique({ where: { slug } })
      : await prisma.section.findUnique({ where: { slug } });
    if (!exists) return slug;
    slug = `${slugify(base)}-${i}`;
  }
  return `${slugify(base)}-${Date.now()}`;
}

/* ---------- Sections ---------- */
export async function createSection(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const name = str(f, "name");
  if (!name) return { error: "Укажите название" };
  try {
    const count = await prisma.section.count();
    await prisma.section.create({ data: { name, slug: await uniqueSlug("section", name), icon: str(f, "icon") || "grid", order: count + 1 } });
  } catch (e) { return fail(e); }
  revalidatePath("/");
  return { ok: "Раздел добавлен" };
}

export async function updateSection(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const id = str(f, "id");
  try {
    await prisma.section.update({ where: { id }, data: { name: str(f, "name"), icon: str(f, "icon") || "grid", order: parseNumber(f.get("order")) ?? 0 } });
  } catch (e) { return fail(e); }
  revalidatePath("/");
  return { ok: "Сохранено" };
}

export async function deleteSection(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const id = str(f, "id");
  const n = await prisma.project.count({ where: { sectionId: id } });
  if (n) return { error: `В разделе ${n} инструмент(ов). Сначала перенесите или удалите их.` };
  await prisma.section.delete({ where: { id } });
  revalidatePath("/");
  return { ok: "Раздел удалён" };
}

/* ---------- Projects & slots ---------- */
export async function createProject(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const name = str(f, "name");
  const sectionId = str(f, "sectionId");
  if (!name || !sectionId) return { error: "Укажите название и раздел" };
  let slug = "";
  try {
    slug = await uniqueSlug("project", str(f, "slug") || name);
    await prisma.project.create({ data: { name, slug, sectionId, description: str(f, "description") || null, url: str(f, "url") || null, status: str(f, "status") || "PLANNED" } });
  } catch (e) { return fail(e); }
  revalidatePath("/");
  redirect(`/projects/${slug}`);
}

export async function updateProject(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const id = str(f, "id");
  try {
    await prisma.project.update({
      where: { id },
      data: { name: str(f, "name"), sectionId: str(f, "sectionId"), description: str(f, "description") || null, url: str(f, "url") || null, status: str(f, "status") || "PLANNED" },
    });
  } catch (e) { return fail(e); }
  revalidatePath("/");
  revalidatePath(`/projects/${str(f, "slug")}`);
  return { ok: "Сохранено" };
}

export async function deleteProject(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  await prisma.project.delete({ where: { id: str(f, "id") } });
  revalidatePath("/");
  redirect("/?ok=deleted");
}

export async function createSlot(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const projectId = str(f, "projectId");
  const name = str(f, "name");
  const key = slugify(str(f, "key") || name).replace(/-/g, "_");
  const capability = str(f, "capability") as Capability;
  if (!name || !key) return { error: "Укажите название слота" };
  if (!CAPS.includes(capability)) return { error: "Выберите тип слота" };
  try {
    await prisma.slot.create({ data: { projectId, key, name, capability, description: str(f, "description") || null } });
  } catch (e) { return fail(e); }
  revalidatePath(`/projects/${str(f, "slug")}`);
  return { ok: "Слот добавлен" };
}

export async function deleteSlot(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  await prisma.slot.delete({ where: { id: str(f, "id") } });
  revalidatePath(`/projects/${str(f, "slug")}`);
  return { ok: "Слот удалён" };
}

/* ---------- Bindings ---------- */
export async function createBinding(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const scope = str(f, "scope") as BindingScope;
  if (!SCOPES.includes(scope)) return { error: "Неизвестный уровень правила" };
  const providerId = str(f, "providerId");
  const apiKeyId = str(f, "apiKeyId");
  const modelId = str(f, "modelId") || null;
  const slotId = str(f, "slotId") || null;
  const teamId = str(f, "teamId") || null;
  const capability = (str(f, "capability") || null) as Capability | null;
  let userId = str(f, "userId") || null;

  // Кто какие правила задаёт: личные — каждый себе (за других — только «любые правила»),
  // командные — в пределах области назначения, сервиса и глобальные — только «любые правила».
  if (scope === "USER_PROJECT") {
    if (!canAssignGlobal(me)) userId = me.id;
  } else if (scope === "TEAM" || scope === "TEAM_PROJECT") {
    if (!inScope(assignScope(me), teamId)) return { error: "Нет прав задавать правила этой команды" };
  } else if (!canAssignGlobal(me)) return { error: "Правила сервиса и глобальные задаёт администратор или сотрудник с правом «любые правила»" };
  const key = await prisma.apiKey.findUnique({ where: { id: apiKeyId }, include: { provider: true } });
  if (!key) return { error: "Выберите ключ" };
  if (key.providerId !== providerId) return { error: "Ключ принадлежит другому провайдеру" };
  const ruleUserTeams = scope === "USER_PROJECT" && userId ? (await prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } })).map((m) => m.teamId) : [];
  const misfit = keyFitsRule(key, { scope, teamId, userId, userTeamIds: ruleUserTeams });
  if (misfit) return { error: misfit };
  const targetCap: Capability | null = capability ?? (slotId ? (await prisma.slot.findUnique({ where: { id: slotId } }))?.capability ?? null : null);
  if (targetCap) {
    const needData = targetCap === "SERP" || targetCap === "SEO_DATA";
    if (needData && key.provider.kind !== "DATA") return { error: "Для слота с данными нужен провайдер данных (SerpAPI, DataForSEO), а не LLM" };
    if (!needData && key.provider.kind !== "LLM") return { error: "Для текстового слота нужен LLM-провайдер" };
    if (targetCap === "SERP" && key.provider.adapter !== "SERPAPI") return { error: "Слот SERP работает только с SerpAPI" };
    if (targetCap === "SEO_DATA" && key.provider.adapter !== "DATAFORSEO") return { error: "Слот SEO-данных работает только с DataForSEO" };
  }
  if (key.provider.kind === "LLM") {
    if (!modelId) return { error: "Для LLM-провайдера нужно выбрать модель" };
    const model = await prisma.model.findUnique({ where: { id: modelId } });
    if (!model || model.providerId !== providerId) return { error: "Модель не принадлежит этому провайдеру" };
  }
  if ((scope === "USER_PROJECT" || scope === "TEAM_PROJECT" || scope === "PROJECT") && !slotId) return { error: "Не указан слот" };
  if ((scope === "TEAM" || scope === "GLOBAL") && !capability) return { error: "Для правила команды/глобального нужен тип слота" };
  if ((scope === "TEAM" || scope === "TEAM_PROJECT") && !teamId) return { error: "Выберите команду" };
  if (scope === "USER_PROJECT" && !userId) return { error: "Выберите пользователя" };

  const data = {
    scope,
    slotId: scope === "TEAM" || scope === "GLOBAL" ? null : slotId,
    teamId: scope === "TEAM" || scope === "TEAM_PROJECT" ? teamId : null,
    userId: scope === "USER_PROJECT" ? userId : null,
    capability: scope === "TEAM" || scope === "GLOBAL" ? capability : null,
    providerId,
    modelId: key.provider.kind === "LLM" ? modelId : null,
    apiKeyId,
  };
  // Replace an existing rule with the same scope/target atomically, so a failure never leaves the slot without a rule
  await prisma.$transaction([
    prisma.binding.deleteMany({ where: { scope, slotId: data.slotId, teamId: data.teamId, userId: data.userId, capability: data.capability } }),
    prisma.binding.create({ data }),
  ]);
  revalidatePath("/", "layout");
  return { ok: "Правило сохранено" };
}

export async function deleteBinding(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const b = await prisma.binding.findUnique({ where: { id: str(f, "id") } });
  if (!b) return { error: "Правило не найдено" };
  if (!canDeleteBinding(me, b)) return { error: "Нет прав" };
  await prisma.binding.delete({ where: { id: b.id } });
  revalidatePath("/", "layout");
  return { ok: "Правило удалено" };
}


/* ---------- Подключение ключа к сервисам и командам ---------- */
/**
 * Правила «от ключа»: отметили сервисы и команды — правила TEAM_PROJECT (или PROJECT без команд,
 * TEAM без сервисов) создаются сами, модель берётся из настроек провайдера по умолчанию.
 * Личные правила (USER_PROJECT) и глобальные этим способом не трогаются.
 */
export async function syncKeyUsage(keyId: string, projectIds: string[], teamIds: string[], me: Actor): Promise<{ created: number; skipped: string[] }> {
  const key = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId }, include: { provider: { include: { models: { where: { isEnabled: true } } } } } });
  if (key.ownerId) throw new Error("Личный ключ подключается только личным правилом");
  if (!canAssignKey(me, key)) throw new Error("Нет прав подключать этот ключ");
  // Командный ключ работает только в своей команде.
  if (key.teamId) teamIds = [key.teamId];
  const scope = assignScope(me);
  const manageable = scope === "all" ? null : new Set(scope);
  if (manageable) {
    if (!teamIds.length) throw new Error("Вы можете подключать ключ только к своим командам: отметьте хотя бы одну");
    for (const t of teamIds) if (!manageable.has(t)) throw new Error("Нет прав на одну из выбранных команд");
  }
  const p = key.provider;
  const modelFor = (cap: Capability): string | null | "none" => {
    if (p.kind === "DATA") return null;
    const wanted = cap === "IMAGE" ? p.defaultImageModel : cap === "CHAT" ? p.defaultChatModel : null;
    if (!wanted) return "none";
    const m = p.models.find((x) => x.modelId === wanted);
    return m ? m.id : "none";
  };
  const capOk = (cap: Capability) => (cap === "SERP" ? p.adapter === "SERPAPI" : cap === "SEO_DATA" ? p.adapter === "DATAFORSEO" : p.kind === "LLM" && cap !== "EMBEDDING");

  const projects = projectIds.length ? await prisma.project.findMany({ where: { id: { in: projectIds } }, include: { slots: true } }) : [];
  const skipped: string[] = [];
  const rows: Array<{ scope: BindingScope; slotId?: string; teamId?: string; capability?: Capability; modelId: string | null }> = [];
  for (const proj of projects) {
    for (const slot of proj.slots) {
      if (!capOk(slot.capability)) continue;
      const m = modelFor(slot.capability);
      if (m === "none") { skipped.push(`${proj.name} · ${slot.name}: у провайдера не задана модель по умолчанию`); continue; }
      if (teamIds.length) for (const teamId of teamIds) rows.push({ scope: "TEAM_PROJECT", slotId: slot.id, teamId, modelId: m });
      else rows.push({ scope: "PROJECT", slotId: slot.id, modelId: m });
    }
  }
  if (!projects.length && teamIds.length) {
    for (const cap of ["CHAT", "IMAGE", "SERP", "SEO_DATA"] as Capability[]) {
      if (!capOk(cap)) continue;
      const m = modelFor(cap);
      if (m === "none") continue;
      for (const teamId of teamIds) rows.push({ scope: "TEAM", teamId, capability: cap, modelId: m });
    }
  }
  await prisma.$transaction(async (tx) => {
    // Пересобираем только те правила «от ключа», которыми пользователь вправе управлять.
    const where = manageable
      ? { apiKeyId: keyId, scope: { in: ["TEAM_PROJECT", "TEAM"] as BindingScope[] }, teamId: { in: [...manageable] } }
      : { apiKeyId: keyId, scope: { in: ["TEAM_PROJECT", "PROJECT", "TEAM"] as BindingScope[] } };
    await tx.binding.deleteMany({ where });
    if (rows.length) await tx.binding.createMany({ data: rows.map((r) => ({ ...r, providerId: p.id, apiKeyId: keyId })) });
  });
  return { created: rows.length, skipped };
}

export async function assignKeyUsage(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const projectIds = f.getAll("projectIds").map(String);
  const teamIds = f.getAll("teamIds").map(String);
  try {
    const r = await syncKeyUsage(id, projectIds, teamIds, me);
    revalidatePath(`/keys/${id}`);
    revalidatePath("/", "layout");
    return { ok: `Подключено правил: ${r.created}${r.skipped.length ? ". Пропущено: " + r.skipped.join("; ") : ""}` };
  } catch (e) { return fail(e); }
}

/* ---------- Keys ---------- */
/**
 * Секрет из формы ключа. У DataForSEO (BASIC) это два поля — логин и пароль API,
 * храним их одной строкой «логин:пароль», как ждёт Basic-авторизация.
 */
function secretFromForm(f: FormData, authType: string): string {
  if (authType === "BASIC") {
    const login = str(f, "secretLogin");
    const password = str(f, "secretPassword");
    if (!login && !password) return str(f, "secret");
    return login && password ? `${login}:${password}` : "";
  }
  return str(f, "secret");
}

/**
 * Кому принадлежит ключ из поля `owner` формы: "personal" — личный, "shared" — общий, "team:<id>" — командный.
 * Проверяет права на выбранный вариант.
 */
function keyOwnerFromForm(me: Actor, raw: string): { ownerId: string | null; teamId: string | null } | { error: string } {
  if (raw === "shared") return canCreateSharedKey(me) ? { ownerId: null, teamId: null } : { error: "Общие ключи добавляет администратор или сотрудник с правом «любые ключи»" };
  if (raw.startsWith("team:")) {
    const teamId = raw.slice(5);
    return inScope(keyTeamScope(me), teamId) ? { ownerId: null, teamId } : { error: "Нет прав добавлять ключи этой команде" };
  }
  return canCreatePersonalKey(me) ? { ownerId: me.id, teamId: null } : { error: "Вам не разрешено добавлять ключи" };
}

export async function createKey(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const providerId = str(f, "providerId");
  const label = str(f, "label");
  const owner = keyOwnerFromForm(me, str(f, "owner"));
  if ("error" in owner) return owner;
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) return { error: "Провайдер не найден" };
  const secret = secretFromForm(f, provider.authType);
  if (!providerId || !label || !secret) return { error: provider.authType === "BASIC" ? "Заполните название, логин и пароль API" : "Заполните провайдера, название и сам ключ" };
  const key = await prisma.apiKey.create({
    data: {
      providerId, label,
      secretEnc: encryptSecret(secret),
      secretHint: secretHint(secret),
      ownerId: owner.ownerId,
      teamId: owner.teamId,
      monthlyLimitUsd: parseNumber(f.get("monthlyLimitUsd")),
      notes: str(f, "notes") || null,
    },
  });
  const check = await checkKey(provider, secret, await probeModelFor(provider.id));
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastCheckedAt: new Date(), lastCheckOk: check.ok, lastCheckNote: check.note } });
  const projectIds = f.getAll("projectIds").map(String);
  const teamIds = f.getAll("teamIds").map(String);
  if (!owner.ownerId && canAssignKey(me, owner) && (projectIds.length || teamIds.length || owner.teamId)) {
    try { await syncKeyUsage(key.id, projectIds, teamIds, me); } catch (e) { return { error: `Ключ сохранён, но не подключён: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  revalidatePath("/keys");
  revalidatePath("/", "layout");
  redirect(`/keys/${key.id}`);
}

export async function updateKey(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const key = await prisma.apiKey.findUnique({ where: { id }, include: { provider: { select: { authType: true } }, _count: { select: { bindings: true } } } });
  if (!key) return { error: "Ключ не найден" };
  if (!canManageKey(me, key)) return { error: "Нет прав" };
  const secret = secretFromForm(f, key.provider.authType);
  if (key.provider.authType === "BASIC" && (str(f, "secretLogin") || str(f, "secretPassword")) && !secret) return { error: "Чтобы заменить доступ DataForSEO, заполните и логин, и пароль API" };
  // Смена владельца: только если ключ нигде не используется (правила завязаны на то, чей это ключ) и есть права на новый вариант.
  let ownerPatch: { ownerId: string | null; teamId: string | null } | {} = {};
  const ownerRaw = str(f, "owner");
  const currentOwner = key.ownerId ? "personal" : key.teamId ? `team:${key.teamId}` : "shared";
  if (ownerRaw && ownerRaw !== currentOwner) {
    if (key._count.bindings) return { error: "Сначала уберите ключ из правил, затем меняйте, чей он" };
    const o = keyOwnerFromForm(me, ownerRaw);
    if ("error" in o) return o;
    ownerPatch = o.ownerId ? { ownerId: key.ownerId ?? me.id, teamId: null } : o;
  }
  await prisma.apiKey.update({
    where: { id },
    data: {
      label: str(f, "label") || key.label,
      notes: str(f, "notes") || null,
      monthlyLimitUsd: parseNumber(f.get("monthlyLimitUsd")),
      status: str(f, "status") === "DISABLED" ? "DISABLED" : "ACTIVE",
      ...(secret ? { secretEnc: encryptSecret(secret), secretHint: secretHint(secret), lastCheckOk: null, lastCheckNote: null } : {}),
      ...ownerPatch,
    },
  });
  revalidatePath(`/keys/${id}`);
  revalidatePath("/keys");
  return { ok: "Сохранено" };
}

export async function testKey(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const key = await prisma.apiKey.findUnique({ where: { id }, include: { provider: true } });
  if (!key) return { error: "Ключ не найден" };
  if (!canManageKey(me, key)) return { error: "Нет прав" };
  const check = await checkKey(key.provider, decryptSecret(key.secretEnc), await probeModelFor(key.providerId));
  await prisma.apiKey.update({ where: { id }, data: { lastCheckedAt: new Date(), lastCheckOk: check.ok, lastCheckNote: check.note } });
  revalidatePath(`/keys/${id}`);
  return check.ok ? { ok: check.note } : { error: check.note };
}

export async function deleteKey(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const key = await prisma.apiKey.findUnique({ where: { id }, include: { _count: { select: { bindings: true } } } });
  if (!key) return { error: "Ключ не найден" };
  if (!canManageKey(me, key)) return { error: "Нет прав" };
  if (key._count.bindings) return { error: `Ключ используется в ${key._count.bindings} правил(ах). Сначала уберите его оттуда.` };
  await prisma.apiKey.delete({ where: { id } });
  revalidatePath("/keys");
  redirect("/keys");
}

/* ---------- Providers & models ---------- */
async function requireProviderManager() {
  const me = await requireUser();
  if (!canManageProviders(me)) throw new Error("Провайдеров и модели меняет администратор или сотрудник с правом «менять настройки и модели»");
  return me;
}

export async function updateProvider(_p: FormState, f: FormData): Promise<FormState> {
  await requireProviderManager();
  const id = str(f, "id");
  const baseUrl = str(f, "baseUrl");
  const bad = validateBaseUrl(baseUrl);
  if (bad) return { error: bad };
  const balanceToken = str(f, "balanceToken");
  try {
    await prisma.provider.update({
      where: { id },
      data: {
        name: str(f, "name"), baseUrl, modelsEndpoint: str(f, "modelsEndpoint") || null, docsUrl: str(f, "docsUrl") || null, isActive: str(f, "isActive") === "1",
        defaultChatModel: str(f, "defaultChatModel") || null, defaultImageModel: str(f, "defaultImageModel") || null,
        ...(balanceToken ? { balanceTokenEnc: encryptSecret(balanceToken), balanceTokenHint: secretHint(balanceToken) } : {}),
      },
    });
  } catch (e) { return fail(e); }
  revalidatePath("/providers");
  revalidatePath("/", "layout");
  return { ok: "Сохранено" };
}

/** Убрать токен баланса провайдера (остаток в шапке перестанет запрашиваться). */
export async function clearBalanceToken(_p: FormState, f: FormData): Promise<FormState> {
  await requireProviderManager();
  const id = str(f, "id");
  await prisma.provider.update({ where: { id }, data: { balanceTokenEnc: null, balanceTokenHint: null } });
  revalidatePath("/providers");
  revalidatePath("/", "layout");
  return { ok: "Токен удалён" };
}

export async function createProvider(_p: FormState, f: FormData): Promise<FormState> {
  await requireProviderManager();
  const name = str(f, "name");
  const baseUrl = str(f, "baseUrl");
  if (!name || !baseUrl) return { error: "Укажите название и базовый адрес" };
  const bad = validateBaseUrl(baseUrl);
  if (bad) return { error: bad };
  try {
    const count = await prisma.provider.count();
    await prisma.provider.create({
      data: {
        slug: slugify(str(f, "slug") || name), name, baseUrl,
        kind: str(f, "kind") === "DATA" ? "DATA" : "LLM",
        adapter: "OPENAI_COMPAT", authType: "BEARER",
        modelsEndpoint: str(f, "modelsEndpoint") || "models", docsUrl: str(f, "docsUrl") || null, order: count + 1,
      },
    });
  } catch (e) { return fail(e); }
  revalidatePath("/providers");
  return { ok: "Провайдер добавлен. Это OpenAI-совместимый шлюз с Bearer-ключом." };
}

export async function syncModels(_p: FormState, f: FormData): Promise<FormState> {
  await requireProviderManager();
  const providerId = str(f, "providerId");
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) return { error: "Провайдер не найден" };
  const key = await prisma.apiKey.findFirst({ where: { providerId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!key) return { error: "Добавьте хотя бы один рабочий ключ этого провайдера, чтобы получить список моделей" };
  let list;
  try {
    list = await fetchModels(provider, decryptSecret(key.secretEnc));
  } catch (e) { return fail(e); }
  let added = 0;
  for (const m of list) {
    const existing = await prisma.model.findUnique({ where: { providerId_modelId: { providerId, modelId: m.modelId } } });
    if (existing) {
      await prisma.model.update({ where: { id: existing.id }, data: { inputPrice: m.inputPrice ?? existing.inputPrice, outputPrice: m.outputPrice ?? existing.outputPrice, contextLength: m.contextLength ?? existing.contextLength } });
    } else {
      await prisma.model.create({ data: { providerId, modelId: m.modelId, name: m.name, capabilities: m.capabilities, inputPrice: m.inputPrice, outputPrice: m.outputPrice, contextLength: m.contextLength, source: "SYNCED", isEnabled: false } });
      added++;
    }
  }
  revalidatePath(`/providers/${provider.slug}`);
  return { ok: `Получено ${list.length} моделей, новых: ${added}. Включите нужные в списке.` };
}

export async function addModel(_p: FormState, f: FormData): Promise<FormState> {
  await requireProviderManager();
  const providerId = str(f, "providerId");
  const modelId = str(f, "modelId");
  if (!modelId) return { error: "Укажите идентификатор модели как в API" };
  const caps = CAPS.filter((c) => f.getAll("caps").includes(c));
  try {
    await prisma.model.create({
      data: {
        providerId, modelId, name: str(f, "name") || modelId,
        capabilities: (caps.length ? caps : ["CHAT"]).join(","),
        inputPrice: parseNumber(f.get("inputPrice")), outputPrice: parseNumber(f.get("outputPrice")), contextLength: parseNumber(f.get("contextLength")),
        source: "MANUAL", isEnabled: true,
      },
    });
  } catch (e) { return fail(e); }
  revalidatePath(`/providers/${str(f, "slug")}`);
  return { ok: "Модель добавлена" };
}

export async function toggleModel(_p: FormState, f: FormData): Promise<FormState> {
  await requireProviderManager();
  const id = str(f, "id");
  const m = await prisma.model.findUnique({ where: { id } });
  if (!m) return { error: "Модель не найдена" };
  await prisma.model.update({ where: { id }, data: { isEnabled: !m.isEnabled } });
  revalidatePath(`/providers/${str(f, "slug")}`);
  return {};
}

export async function updateModel(_p: FormState, f: FormData): Promise<FormState> {
  await requireProviderManager();
  const id = str(f, "id");
  const caps = CAPS.filter((c) => f.getAll("caps").includes(c));
  await prisma.model.update({
    where: { id },
    data: { name: str(f, "name") || undefined, capabilities: (caps.length ? caps : ["CHAT"]).join(","), inputPrice: parseNumber(f.get("inputPrice")), outputPrice: parseNumber(f.get("outputPrice")), contextLength: parseNumber(f.get("contextLength")) },
  });
  revalidatePath(`/providers/${str(f, "slug")}`);
  return { ok: "Сохранено" };
}

export async function deleteModel(_p: FormState, f: FormData): Promise<FormState> {
  await requireProviderManager();
  const id = str(f, "id");
  const n = await prisma.binding.count({ where: { modelId: id } });
  if (n) return { error: `Модель используется в ${n} правил(ах)` };
  await prisma.model.delete({ where: { id } });
  revalidatePath(`/providers/${str(f, "slug")}`);
  return { ok: "Модель удалена" };
}

/* ---------- Teams ---------- */
export async function createTeam(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (!canCreateTeam(me)) return { error: "Нет прав создавать команды" };
  const name = str(f, "name");
  if (!name) return { error: "Укажите название" };
  let slug = "";
  try {
    slug = await uniqueSlug("team", name);
    await prisma.team.create({ data: { name, slug, description: str(f, "description") || null } });
  } catch (e) { return fail(e); }
  revalidatePath("/teams");
  redirect(`/teams/${slug}`);
}

export async function updateTeam(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (!canManageTeam(me, str(f, "id"))) return { error: "Нет прав" };
  await prisma.team.update({ where: { id: str(f, "id") }, data: { name: str(f, "name"), description: str(f, "description") || null } });
  revalidatePath("/teams");
  return { ok: "Сохранено" };
}

export async function deleteTeam(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (!canCreateTeam(me)) return { error: "Удалять команды может администратор или сотрудник с правом «все команды»" };
  const keys = await prisma.apiKey.count({ where: { teamId: str(f, "id") } });
  if (keys) return { error: `У команды ${keys} ключ(ей). Сначала удалите их или передайте другой команде.` };
  await prisma.team.delete({ where: { id: str(f, "id") } });
  revalidatePath("/teams");
  redirect("/teams");
}

export async function addTeamMember(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const teamId = str(f, "teamId");
  const userId = str(f, "userId");
  if (!canManageTeam(me, teamId)) return { error: "Нет прав менять состав этой команды" };
  if (!userId) return { error: "Выберите пользователя" };
  const role = str(f, "role") === "LEAD" ? "LEAD" : "MEMBER";
  try {
    await prisma.teamMember.upsert({ where: { teamId_userId: { teamId, userId } }, create: { teamId, userId, role }, update: { role } });
  } catch (e) { return fail(e); }
  revalidatePath(`/teams/${str(f, "slug")}`);
  revalidatePath(`/users/${userId}`);
  return { ok: "Участник добавлен" };
}

export async function removeTeamMember(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const teamId = str(f, "teamId");
  const userId = str(f, "userId");
  if (!canManageTeam(me, teamId)) return { error: "Нет прав менять состав этой команды" };
  await prisma.teamMember.delete({ where: { teamId_userId: { teamId, userId } } });
  revalidatePath(`/teams/${str(f, "slug")}`);
  revalidatePath(`/users/${userId}`);
  return { ok: "Участник убран" };
}

/* ---------- Users ---------- */
export async function inviteUser(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const email = str(f, "email").toLowerCase();
  const name = str(f, "name") || email.split("@")[0];
  const role = str(f, "role") === "ADMIN" ? "ADMIN" : "MEMBER";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Некорректная почта" };
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing?.passwordHash) return { error: "Пользователь уже зарегистрирован" };
  const inviteToken = randomToken(24);
  const inviteExpires = new Date(Date.now() + 7 * 86400 * 1000);
  // Права из формы приглашения (если поля присланы); иначе у существующего остаются свои, у нового — по умолчанию.
  const permissions = f.has("usage") ? permissionsFromForm(f) : undefined;
  const teamIds = f.getAll("teamIds").map(String).filter(Boolean);
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { inviteToken, inviteExpires, role, name, ...(permissions ? { permissions } : {}) } })
    : await prisma.user.create({ data: { email, name, role, inviteToken, inviteExpires, ...(permissions ? { permissions } : {}) } });
  if (teamIds.length) await prisma.teamMember.createMany({ data: teamIds.map((teamId) => ({ teamId, userId: user.id })), skipDuplicates: true });
  revalidatePath("/users");
  return { ok: `Приглашение создано, ссылка действует 7 дней: ${process.env.APP_URL ?? ""}/invite/${inviteToken}` };
}

export async function updateUser(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireAdmin();
  const id = str(f, "id");
  const role = str(f, "role") === "ADMIN" ? "ADMIN" : "MEMBER";
  const isActive = str(f, "isActive") === "1";
  if (id === me.id && (role !== "ADMIN" || !isActive)) return { error: "Нельзя понизить или отключить самого себя" };
  await prisma.user.update({ where: { id }, data: { role, isActive, name: str(f, "name") || undefined } });
  if (!isActive) await prisma.session.deleteMany({ where: { userId: id } });
  revalidatePath("/users");
  revalidatePath(`/users/${id}`);
  return { ok: "Сохранено" };
}

/** Права участника (для админа поле игнорируется: у него всё разрешено). Вступают в силу при следующем запросе пользователя. */
export async function updateUserPermissions(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const id = str(f, "id");
  const user = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (!user) return { error: "Пользователь не найден" };
  await prisma.user.update({ where: { id }, data: { permissions: permissionsFromForm(f) } });
  revalidatePath("/users");
  revalidatePath(`/users/${id}`);
  return { ok: user.role === "ADMIN" ? "Сохранено. Пока пользователь админ, права не ограничивают его." : "Права сохранены" };
}

export async function resetUserPassword(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireAdmin();
  const id = str(f, "id");
  const password = str(f, "password");
  if (password.length < 8) return { error: "Пароль не короче 8 символов" };
  if (id === me.id) return { error: "Свой пароль меняйте в разделе «Аккаунт»" };
  await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
  await prisma.session.deleteMany({ where: { userId: id } });
  return { ok: "Пароль задан, сессии пользователя сброшены" };
}

export async function deleteUser(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireAdmin();
  const id = str(f, "id");
  if (id === me.id) return { error: "Нельзя удалить самого себя" };
  const keys = await prisma.apiKey.count({ where: { ownerId: id } });
  if (keys) return { error: `У пользователя ${keys} личных ключ(ей). Сначала удалите их или передайте.` };
  await prisma.user.delete({ where: { id } });
  revalidatePath("/users");
  redirect("/users");
}

export async function whoami() {
  return getCurrentUser();
}
