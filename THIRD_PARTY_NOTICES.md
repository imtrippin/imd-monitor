# Third-party notices

The built page (`web/dist`) bundles these packages, each under the MIT License:

- React 18.3.1 and ReactDOM 18.3.1 — Copyright (c) Meta Platforms, Inc. and affiliates
- scheduler 0.23.2 — Copyright (c) Meta Platforms, Inc. and affiliates

They are installed from npm (`web/package.json`); their license texts ship inside each package
(`node_modules/<name>/LICENSE`) and are not modified.

The build uses Vite and `@vitejs/plugin-react` (MIT) as development tools; nothing from them is
redistributed in the page.

The "GitHub" look (`web/src/skin-github.css`) uses colour values taken from GitHub's Primer design
system (`@primer/primitives`, MIT License, Copyright (c) GitHub Inc.). No Primer code is included; the
palette values are applied through this project's own CSS tokens.

The backend and the hub use only Node.js built-in modules (`node:http`, `node:sqlite`, `node:zlib`,
`node:fs`, `node:path`, `node:child_process`); the collectors and the watcher use only the Python
standard library.

Everything else in this repository is covered by the MIT License in `LICENSE`.
