# Mindmap

A small, dependency-free HTML5 mindmap editor. Central idea in the middle,
organic tapering colour-coded branches radiating out, free-form drag-and-drop
positioning and inline text editing. Runs as plain static files — no build
step — so it deploys straight to Apache and can later be wrapped as a
standalone (Electron/Tauri) app.

## Features

- Central node with colour-coded main branches; sub-branches inherit the
  branch colour.
- Organic **tapering** branches (filled SVG paths, thick at the root, thin at
  the tip) — the classic hand-drawn mindmap look.
- Drag any node (with its whole subtree) to reposition; pan the canvas; scroll
  to zoom.
- Inline rename (double-click a node or press F2).
- Add child (`Tab` / **+ Child**), add sibling (`Enter` / **+ Sibling**),
  delete subtree (`Del`).
- Per-branch colour picker.
- Autosaves to `localStorage`; **Export** / **Import** as JSON.

## Usage

Open `index.html` in a browser, or serve the directory statically:

```sh
python3 -m http.server 8123
```

Then visit <http://localhost:8123>.

## Deployment

Hosted at <https://mindmap.apps.aukes.com> on `sebas`. The repository is cloned
into `/var/www/mindmap`; the GitLab CI `deploy` stage SSHes to the host and runs
`git pull` on every push to `main`.
