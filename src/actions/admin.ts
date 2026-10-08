"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentUser, hashPassword, requireAdmin, requireUser } from "@/lib/auth";
import { encryptSecret, decryptSecret, randomToken, secretHint } from "@/lib/crypto";
import { checkKey, fetchModels } from "@/lib/adapters";
import { parseNumber, slugify } from "@/lib/utils";
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

  if (me.role !== "ADMIN") {
    if (scope !== "USER_PROJECT") return { error: "Участник может задавать только личные правила" };
    userId = me.id;
  }
  const key = await prisma.apiKey.findUnique({ where: { id: apiKeyId }, include: { provider: true } });
  if (!key) return { error: "Выберите ключ" };
  if (key.providerId !== providerId) return { error: "Ключ принадлежит другому провайдеру" };
  if (me.role !== "ADMIN" && key.ownerId && key.ownerId !== me.id) return { error: "Это чужой личный ключ" };
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
  // Replace an existing rule with the same scope/target to avoid duplicates
  await prisma.binding.deleteMany({ where: { scope, slotId: data.slotId, teamId: data.teamId, userId: data.userId, capability: data.capability } });
  await prisma.binding.create({ data });
  revalidatePath("/", "layout");
  return { ok: "Правило сохранено" };
}

export async function deleteBinding(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const b = await prisma.binding.findUnique({ where: { id: str(f, "id") } });
  if (!b) return { error: "Правило не найдено" };
  if (me.role !== "ADMIN" && !(b.scope === "USER_PROJECT" && b.userId === me.id)) return { error: "Нет прав" };
  await prisma.binding.delete({ where: { id: b.id } });
  revalidatePath("/", "layout");
  return { ok: "Правило удалено" };
}

/* ---------- Keys ---------- */
export async function createKey(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const providerId = str(f, "providerId");
  const label = str(f, "label");
  const secret = str(f, "secret");
  const personal = str(f, "personal") === "1" || me.role !== "ADMIN";
  if (!providerId || !label || !secret) return { error: "Заполните провайдера, название и сам ключ" };
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) return { error: "Провайдер не найден" };
  if (provider.authType === "BASIC" && !secret.includes(":")) return { error: "Для DataForSEO укажите «логин:пароль» одной строкой" };
  const key = await prisma.apiKey.create({
    data: {
      providerId, label,
      secretEnc: encryptSecret(secret),
      secretHint: secretHint(secret),
      ownerId: personal ? me.id : null,
      monthlyLimitUsd: parseNumber(f.get("monthlyLimitUsd")),
      notes: str(f, "notes") || null,
    },
  });
  const check = await checkKey(provider, secret);
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastCheckedAt: new Date(), lastCheckOk: check.ok, lastCheckNote: check.note } });
  revalidatePath("/keys");
  redirect(`/keys/${key.id}`);
}

export async function updateKey(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key) return { error: "Ключ не найден" };
  if (me.role !== "ADMIN" && key.ownerId !== me.id) return { error: "Нет прав" };
  const secret = str(f, "secret");
  await prisma.apiKey.update({
    where: { id },
    data: {
      label: str(f, "label") || key.label,
      notes: str(f, "notes") || null,
      monthlyLimitUsd: parseNumber(f.get("monthlyLimitUsd")),
      status: str(f, "status") === "DISABLED" ? "DISABLED" : "ACTIVE",
      ...(secret ? { secretEnc: encryptSecret(secret), secretHint: secretHint(secret), lastCheckOk: null, lastCheckNote: null } : {}),
      ...(me.role === "ADMIN" ? { ownerId: str(f, "personal") === "1" ? (key.ownerId ?? me.id) : null } : {}),
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
  if (me.role !== "ADMIN" && key.ownerId !== me.id) return { error: "Нет прав" };
  const check = await checkKey(key.provider, decryptSecret(key.secretEnc));
  await prisma.apiKey.update({ where: { id }, data: { lastCheckedAt: new Date(), lastCheckOk: check.ok, lastCheckNote: check.note } });
  revalidatePath(`/keys/${id}`);
  return check.ok ? { ok: check.note } : { error: check.note };
}

export async function deleteKey(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const key = await prisma.apiKey.findUnique({ where: { id }, include: { _count: { select: { bindings: true } } } });
  if (!key) return { error: "Ключ не найден" };
  if (me.role !== "ADMIN" && key.ownerId !== me.id) return { error: "Нет прав" };
  if (key._count.bindings) return { error: `Ключ используется в ${key._count.bindings} правил(ах). Сначала уберите его оттуда.` };
  await prisma.apiKey.delete({ where: { id } });
  revalidatePath("/keys");
  redirect("/keys");
}

/* ---------- Providers & models ---------- */
export async function updateProvider(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const id = str(f, "id");
  try {
    await prisma.provider.update({
      where: { id },
      data: { name: str(f, "name"), baseUrl: str(f, "baseUrl"), modelsEndpoint: str(f, "modelsEndpoint") || null, docsUrl: str(f, "docsUrl") || null, isActive: str(f, "isActive") === "1" },
    });
  } catch (e) { return fail(e); }
  revalidatePath("/providers");
  return { ok: "Сохранено" };
}

export async function createProvider(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const name = str(f, "name");
  const baseUrl = str(f, "baseUrl");
  if (!name || !baseUrl) return { error: "Укажите название и базовый адрес" };
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
  await requireAdmin();
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
  await requireAdmin();
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
  await requireAdmin();
  const id = str(f, "id");
  const m = await prisma.model.findUnique({ where: { id } });
  if (!m) return { error: "Модель не найдена" };
  await prisma.model.update({ where: { id }, data: { isEnabled: !m.isEnabled } });
  revalidatePath(`/providers/${str(f, "slug")}`);
  return {};
}

export async function updateModel(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
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
  await requireAdmin();
  const id = str(f, "id");
  const n = await prisma.binding.count({ where: { modelId: id } });
  if (n) return { error: `Модель используется в ${n} правил(ах)` };
  await prisma.model.delete({ where: { id } });
  revalidatePath(`/providers/${str(f, "slug")}`);
  return { ok: "Модель удалена" };
}

/* ---------- Teams ---------- */
export async function createTeam(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
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
  await requireAdmin();
  await prisma.team.update({ where: { id: str(f, "id") }, data: { name: str(f, "name"), description: str(f, "description") || null } });
  revalidatePath("/teams");
  return { ok: "Сохранено" };
}

export async function deleteTeam(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  await prisma.team.delete({ where: { id: str(f, "id") } });
  revalidatePath("/teams");
  redirect("/teams");
}

export async function addTeamMember(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  const teamId = str(f, "teamId");
  const userId = str(f, "userId");
  if (!userId) return { error: "Выберите пользователя" };
  try {
    await prisma.teamMember.create({ data: { teamId, userId, role: str(f, "role") === "LEAD" ? "LEAD" : "MEMBER" } });
  } catch (e) { return fail(e); }
  revalidatePath(`/teams/${str(f, "slug")}`);
  return { ok: "Участник добавлен" };
}

export async function removeTeamMember(_p: FormState, f: FormData): Promise<FormState> {
  await requireAdmin();
  await prisma.teamMember.delete({ where: { teamId_userId: { teamId: str(f, "teamId"), userId: str(f, "userId") } } });
  revalidatePath(`/teams/${str(f, "slug")}`);
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
  if (existing) await prisma.user.update({ where: { id: existing.id }, data: { inviteToken, inviteExpires, role, name } });
  else await prisma.user.create({ data: { email, name, role, inviteToken, inviteExpires } });
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
  return { ok: "Сохранено" };
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
  return { ok: "Пользователь удалён" };
}

export async function whoami() {
  return getCurrentUser();
}
