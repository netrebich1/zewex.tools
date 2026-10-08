import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginAction } from "@/actions/auth";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Вход" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return <AuthForm mode="login" action={loginAction} />;
}
