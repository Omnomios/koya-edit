# Git plugin (read-only)

Mounts under `/rom/plugins/git/` when `packs/` is passed to Koya (`scripts/run.sh` already does).

## Layout

```
plugins/git/
  manifest.json
  index.js
  scmView.js
```

## Behaviour

- Sidebar: **Source Control** activity tab — porcelain working-tree list (staged / changes); click a file to open; ↻ refreshes
- Status bar: branch name (`⎇ main` / `main*` when the **repo** is dirty); click focuses Source Control
- Editor gutter (same stripe chrome, two sources merged per row):
  - `editor.unsaved` — buffer vs last save/load (updates on every edit)
  - `git.diff` — file on disk vs `HEAD` (kept while editing; unsaved wins on the same row)
- Palette commands: `Git: Refresh`, `Git: Focus Source Control`
- Uses `Module/editor.runCommand` for read-only git (`rev-parse`, `status`, `diff`)
- No stage / commit / push / checkout

## Disable

Remove or rename `packs/plugins/git` and relaunch — core never imports this pack, so branch chip, SCM tab, and marks disappear.
