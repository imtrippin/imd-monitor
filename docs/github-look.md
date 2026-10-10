# The GitHub look

A second look for the dashboard, selectable in the top bar ("Classic" / "GitHub"), saved in `localStorage` as `imd-skin` and applied before first paint by `main.jsx` as `data-skin="github"` on `<html>`. Light and dark still follow the existing theme toggle and the system preference.

`web/src/skin-github.css` redefines the same tokens the classic look uses (Primer's palettes: canvas `#ffffff` / `#0d1117`, subtle `#f6f8fa` / `#161b22`, border `#d1d9e0` / `#30363d`, accent blue `#0969da` / `#4493f8`, success green, attention yellow, danger red; system sans; `ui-monospace` only for code), then adjusts shapes: bordered boxes without shadows, 6 px radii, the grey header bar with a round mark, underline navigation with the coral marker, pill-shaped labels and counters, grey table headers, round avatars, 8 px progress bars. Nothing in `App.jsx` changed apart from the selector and the state behind it, so both looks render the same components and data.

Checked with headless-Chrome screenshots of the Agents and Network views in light and dark (0 console errors).
