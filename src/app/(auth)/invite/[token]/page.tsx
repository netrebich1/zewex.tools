import { prisma } from "@/lib/db";
import { acceptInviteAction } from "@/actions/auth";
import { AuthForm } from "@/components/AuthForm";
import { Alert } from "@/components/ui";
import Link from "next/link";

export const metadata = { title: "Приглашение" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await prisma.user.findUnique({ where: { inviteToken: token } });
  if (!user || !user.inviteExpires || user.inviteExpires < new Date()) {
    return (
      <div className="space-y-4">
        <Alert tone="danger">Приглашение недействительно или истекло. Попросите администратора выслать новое.</Alert>
        <Link href="/login" className="btn-ghost w-full">На страницу входа</Link>
      </div>
    );
  }
  return <AuthForm mode="invite" action={acceptInviteAction} token={token} email={user.email} />;
}
