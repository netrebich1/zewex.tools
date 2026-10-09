import { redirect } from "next/navigation";

/** Раздел «Доступы к сайтам» объединён с «Сайты». */
export default function AccessRedirect() {
  redirect("/sites");
}
