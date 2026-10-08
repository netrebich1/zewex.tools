import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { registerAction } from "@/actions/auth";
import { AuthForm } from "@/components/AuthForm";

export const metadata = { title: "Регистрация" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/");
  return <AuthForm mode="register" action={registerAction} />;
}
