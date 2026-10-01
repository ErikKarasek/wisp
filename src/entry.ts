// One page, three windows: the main window, the menu-bar panel and the notch.
const view = new URLSearchParams(location.search).get("view");

if (view === "glow") {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((el) => el.remove());
  (await import("./glow")).startGlow();
} else if (view === "panel" || view === "notch") {
  // The small windows have their own styles; the main window's (.side, .card,
  // .live…) would otherwise leak in and draw borders where there should be none.
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((el) => el.remove());
  document.body.className = "mini";
  const mini = await import("./mini");
  if (view === "panel") mini.startPanel();
  else await mini.startNotch();
} else {
  await import("./main");
}
export {};
