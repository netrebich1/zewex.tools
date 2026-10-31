import { ProjectsNav } from "@/components/projects/ProjectsNav";
import { getCurrentUser } from "@/lib/auth";
import { overdueTasksCount } from "@/lib/projects/tasks";

export default async function ProjectsLayout({ children }: { children: React.ReactNode }) {
  const me = await getCurrentUser();
  const overdue = me ? await overdueTasksCount(me).catch(() => 0) : 0;
  return (
    <div>
      <ProjectsNav counts={{ overdue }} />
      {children}
    </div>
  );
}
