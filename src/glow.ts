// The glow around the screen's edge while an agent or Claude Code works, like
// the Grok Bot video: an iridescent rim slowly running round the screen. The
// window lets every click through; the main window shows and hides it.

export function startGlow() {
  const style = document.createElement("style");
  style.textContent = `
    @property --a { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
    .rim, .haze { position: fixed; inset: 0; pointer-events: none; border-radius: 14px; animation: in .6s ease-out both; }
    .rim {
      padding: 3px;
      background: conic-gradient(from var(--a), #ff6ec7, #8b9cff, #5fd3ff, #7dffb2, #ffd36e, #ff8a5f, #ff6ec7);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      filter: blur(1.5px) saturate(1.2);
      animation: spin 7s linear infinite, in .6s ease-out both;
    }
    .haze {
      padding: 26px;
      background: conic-gradient(from var(--a), #ff6ec7, #8b9cff, #5fd3ff, #7dffb2, #ffd36e, #ff8a5f, #ff6ec7);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      filter: blur(24px);
      opacity: .45;
      animation: spin 7s linear infinite, breathe 3.2s ease-in-out infinite, in .6s ease-out both;
    }
    @keyframes spin { to { --a: 360deg; } }
    @keyframes breathe { 50% { opacity: .25; } }
    @keyframes in { from { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .rim, .haze { animation: none; } }
  `;
  document.head.appendChild(style);
  document.body.innerHTML = `<div class="haze"></div><div class="rim"></div>`;
}
