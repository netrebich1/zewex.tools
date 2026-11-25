"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleFav } from "@/actions/stylist";

/** Сердечко на фото вещи: в избранное и обратно. */
export function FavButton({ itemId, fav }: { itemId: string; fav: boolean }) {
  const [on, setOn] = useState(fav);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label={on ? "Убрать из избранного" : "В избранное"}
      title={on ? "Убрать из избранного" : "В избранное"}
      disabled={pending}
      onClick={() => start(async () => {
        const r = await toggleFav(itemId);
        if (!r.error) {
          setOn(!!r.fav);
          router.refresh();
        }
      })}
      className={`absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full border text-[18px] leading-none shadow transition ${on ? "border-danger bg-danger text-white" : "border-line bg-surface/90 text-ink hover:text-danger"}`}
    >
      {on ? "♥" : "♡"}
    </button>
  );
}
