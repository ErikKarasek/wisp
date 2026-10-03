// One page, several windows: the main window, the menu-bar panel, the notch, the
// screen glow and the bot carried out of the notch.
const view = new URLSearchParams(location.search).get("view");

// Whether the characters' shapes move, in every window that draws them; Settings announces a change.
{
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { setShapeMotion } = await import("./mascot/mascot");
  const { EV_NOTCH_PREFS } = await import("./broadcast");
  const load = async () => setShapeMotion((await invoke<{ shapeMotion?: boolean }>("config_load").catch(() => ({}) as { shapeMotion?: boolean })).shapeMotion !== false);
  await load();
  void listen(EV_NOTCH_PREFS, () => void load());
}

if (view === "glow") {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((el) => el.remove());
  (await import("./glow")).startGlow();
} else if (view === "panel" || view === "notch" || view === "buddy") {
  // The small windows have their own styles; the main window's (.side, .card,
  // .live…) would otherwise leak in and draw borders where there should be none.
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((el) => el.remove());
  document.body.className = "mini";
  const mini = await import("./mini");
  if (view === "panel") mini.startPanel();
  else if (view === "buddy") await mini.startBuddy();
  else await mini.startNotch();
} else {
  await import("./main");
}
export {};
