---
"@domicile-desktop/engine": minor
"@domicile-desktop/e2e-harness": patch
"domicile": minor
---

`domicile devtools` sends a DevTools Protocol method to a browser window's page, from a short list that reads and drives the page, and `domicile mcp` offers agents browser tools on it: `browser_snapshot` reads the page's accessibility tree, and `browser_click`, `browser_type`, `browser_key`, `browser_navigate` and `browser_screenshot` act on its elements by ref. `list-windows` gives a browser window's `engine_id`. Private windows are never driven.
