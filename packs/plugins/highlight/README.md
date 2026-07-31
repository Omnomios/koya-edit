# Highlight plugin packs

Mount this tree with Koya’s `-m` so packs appear under `/rom/plugins/highlight/`.

`scripts/run.sh` already mounts `packs/`.

## Layout

```
plugins/highlight/<language-id>/
  manifest.json
  highlights.scm
  grammar.so          # optional when grammar is built into Module/editor
```

### `manifest.json`

```json
{
  "id": "rust",
  "extensions": ["rs"],
  "grammar": "grammar.so",
  "grammarSymbol": "tree_sitter_rust",
  "highlights": "highlights.scm"
}
```

| Field | Purpose |
| --- | --- |
| `id` | Language id (`doc.language`) |
| `extensions` | File extensions merged into path→language map |
| `grammar` | `"builtin"` for languages linked into `Module/editor`, or a `.so` path relative to the pack |
| `grammarSymbol` | `dlsym` name (default `tree_sitter_<id>`) when loading a `.so` |
| `highlights` | Tree-sitter highlight query file |

### Built-in languages

`javascript`, `c`, `cpp`, `json`, `markdown`, `html`, and `css` ship with `"grammar": "builtin"` (parsers linked into `libsm-editor.so`).

### Adding a language (no app rebuild)

1. Build a tree-sitter grammar as a native shared library exporting `TSLanguage *tree_sitter_<id>(void)` (must match host arch/ABI; WASM is not supported).
2. Add `highlights.scm` using capture names the theme understands (`keyword`, `string`, `comment`, `function`, `type`, `number`, `constant`, `operator`, `punctuation`, `variable`, `property`, …). Dotted names (`function.method`) fall back to the first segment.
3. Write `manifest.json` and place the pack under `packs/plugins/highlight/<id>/`.
4. Restart KoyaEdit.

Queries emit **scopes**; colours come from the editor theme (`theme.syntax`).

## Contract

`Module/editor.highlight({ source, language, query })` returns `{ spans: [{ start, end, scope }] }` with Unicode code-point offsets. The JS provider maps scopes to colours; the viewport paints `UI.addColourArea` on line slots.
