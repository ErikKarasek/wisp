// One page, three windows: the main window, the menu-bar panel and the notch.
const view = new URLSearchParams(location.search).get("view");

if (view === "panel" || view === "notch") {
  document.body.className = "mini";
  const mini = await import("./mini");
  if (view === "panel") mini.startPanel();
  else await mini.startNotch();
} else {
  await import("./main");
}
export {};
