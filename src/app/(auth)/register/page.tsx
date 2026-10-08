import { redirect } from "next/navigation";
import { getCurrentUser, registrationOpen } from "@/lib/auth";
import { registerAction } from "@/actions/auth";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Регистрация" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/");
  // Once the owner has registered, the page disappears: everyone else comes in by invitation.
  if (!(await registrationOpen())) redirect("/login");
  return <AuthForm mode="register" action={registerAction} />;
}
