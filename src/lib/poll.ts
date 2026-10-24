/**
 * Опрос сервера раз в `ms`, но только из видимой вкладки. Если тик был пропущен, пока вкладка была скрыта,
 * при возврате на неё — сразу одно обновление. Возвращает функцию очистки (для useEffect).
 */
export function pollWhileVisible(fn: () => unknown, ms: number): () => void {
  let missed = false;
  const t = setInterval(() => {
    if (document.visibilityState === "visible") void fn();
    else missed = true;
  }, ms);
  const onVisible = () => {
    if (document.visibilityState !== "visible" || !missed) return;
    missed = false;
    void fn();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(t);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
