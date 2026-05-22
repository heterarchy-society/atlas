# Atlas

Build tooling for [Heterarchy](https://heterarchy.fyi) data collections. Reads source files (Markdown, YAML, TOML), validates them against JSON schemas, and emits static JS/JSON bundles consumed by the site.

## Install

```sh
npm install
```

Or use it as a dependency in a dataset repo:

```sh
npm install @heterarchy/atlas
```

## Usage

```
atlas <command>
```

| Command | Description |
|---|---|
| `build` | Build `dist/` from collection sources |
| `validate` | Validate all source files against schema |
| `unresolved` | Show unresolved `[[wiki links]]` |
| `stale` | Show translations with an outdated source hash |
| `translate [lang] [id]` | Translate missing/stale entries via Codex CLI |
| `resolve-authors` | Resolve GitHub usernames from git emails |

## Configuration

Each dataset repo needs a `config.toml`. A single collection:

```toml
[collection]
name       = "glossary"
source_dir = "glossary"
format     = "md"          # md | yaml | toml
output_key = "terms"
git_history = true         # emit per-item git history to dist/
```

Multiple collections use `[[collections]]` (array syntax).

The optional `[output]` section controls where build artifacts land:

```toml
[output]
dir = "dist"   # default
```

## Build output

`atlas build` writes one JS module per collection plus a combined JSON index:

```
dist/
  terms.js      # export default { meta, terms: [...] }
  index.json    # all collections merged
```

If `git_history = true`, a `dist/<output_key>-history.json` is also written with per-item commit history.

## Atlas scripts hook

Drop an `atlas-scripts.js` (or `.ts`) in the dataset root to transform items at build time:

```js
export default {
  transform(item, { allItems, config, col, rootDir }) {
    return { ...item, slug: item.id.toLowerCase() }
  }
}
```

## Translations

`atlas translate` uses [Codex CLI](https://github.com/openai/codex) to translate glossary entries. Configuration lives in `config.toml`:

```toml
[languages]
default = "cs"

[languages.cs]
name = "Czech"

[translation]
prompt        = "..."   # bootstrap prompt (first term in a session)
resume_prompt = "..."   # short prompt for subsequent terms
```

Sessions are stored in `.translation-session-{lang}` (git-ignored) so terminology stays consistent across terms in the same run.

```sh
atlas translate        # interactive — prompts for each stale/missing term
atlas translate cs     # same, explicit language
atlas translate cs tor # translate a single term non-interactively
```

## Datasets

- [`datasets/glossary`](datasets/glossary) — reference glossary for the parallel society
- [`datasets/books`](datasets/books) — book recommendations
