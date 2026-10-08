import { redirect } from "next/navigation";
import { getCurrentUser, registrationOpen } from "@/lib/auth";
import { loginAction } from "@/actions/auth";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Вход" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return <AuthForm mode="login" action={loginAction} showRegister={await registrationOpen()} />;
}
