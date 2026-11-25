// Окно расширения: токен и проверка связи с порталом.
const $ = (id) => document.getElementById(id);
const show = (text, ok) => {
  $("msg").textContent = text;
  $("msg").className = `msg ${ok ? "ok" : "bad"}`;
};

async function check() {
  const r = await chrome.runtime.sendMessage({ type: "api", action: "hello", body: {} });
  if (r.ok) show(`Связь есть: ${r.data.user}. Образов: ${r.data.looks.length}.${r.data.latest && r.data.latest !== chrome.runtime.getManifest().version ? ` Вышла версия ${r.data.latest} — скачайте её на странице «Расширение».` : ""}`, true);
  else show(r.data.error || "Портал не ответил", false);
}

(async () => {
  $("ver").textContent = `v${chrome.runtime.getManifest().version}`;
  const s = await chrome.storage.local.get(["token", "city"]);
  $("city").value = s.city || "";
  if (s.token) {
    $("token").value = s.token;
    check();
  }
})();

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: $("token").value.trim(), city: $("city").value.trim() });
  check();
});
