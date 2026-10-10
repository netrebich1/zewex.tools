/** Справочники для формы доступа к сайту: команды пользователя, сервисы, участники команд. */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { TeamMemberOption } from "@/components/sites/SiteAccessForm";
import { seesAllSites } from "@/lib/permissions";

export async function accessFormData(me: CurrentUser) {
  const isAdmin = seesAllSites(me);
  const [teams, projects, memberships] = await Promise.all([
    prisma.team.findMany({ where: isAdmin ? {} : { id: { in: me.teamIds } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.project.findMany({ orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, slug: true, name: true } }),
    prisma.teamMember.findMany({ where: isAdmin ? {} : { teamId: { in: me.teamIds } }, include: { user: { select: { id: true, name: true, email: true, isActive: true } } } }),
  ]);
  const members: TeamMemberOption[] = memberships
    .filter((m) => m.user.isActive)
    .map((m) => ({ teamId: m.teamId, userId: m.userId, name: m.user.name || m.user.email, email: m.user.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { teams, projects, members };
}
