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
heterarchy-atlas <command>
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

`heterarchy-atlas build` writes one JS module per collection plus a combined JSON index:

```
dist/
  terms.js      # export default { meta, terms: [...] }
  index.json    # all collections merged
```

If `git_history = true`, a `dist/<output_key>-history.json` is also written with per-item commit history.

### Redirects

When an item id is renamed, record the old id in `redirects.yaml` at the dataset repo root:

```yaml
# redirects.yaml
mario: mario-havel
```

Validation checks that targets exist, sources are not live ids, and there are no redirect chains. Build emits the map into `dist/index.json` under `meta.redirects` for the frontend.

Optional path override in `config.toml`:

```toml
redirects = "redirects.yaml"
```

### Wiki links

Markdown descriptions use `[[wiki links]]`. Atlas does not resolve or validate them at build time; the site frontend resolves targets against loaded datasets.

| Syntax | Meaning |
|--------|---------|
| `[[bitcoin]]` | Glossary term `bitcoin` (default collection) |
| `[[bit gold\|bitcoin]]` | Display text → glossary id |
| `[[people:david-chaum]]` | Person `david-chaum` in the people dataset |
| `[[David Chaum\|people:david-chaum]]` | Display text → person id |

The prefix before `:` is the dataset collection name (`glossary`, `people`, `books`, `writings`), matching each repo’s `name` in `config.toml`. Without a prefix, links refer to the glossary.

The `unresolved` command only checks glossary-to-glossary links within a single glossary dataset (legacy helper for authors).

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

`heterarchy-atlas translate` uses [Codex CLI](https://github.com/openai/codex) to translate glossary entries. Configuration lives in `config.toml`:

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
heterarchy-atlas translate        # interactive — prompts for each stale/missing term
heterarchy-atlas translate cs     # same, explicit language
heterarchy-atlas translate cs tor # translate a single term non-interactively
```

## Datasets

- [`datasets/glossary`](datasets/glossary) — reference glossary for the parallel society
- [`datasets/books`](datasets/books) — book recommendations
- [`datasets/writings`](datasets/writings) — primary source texts
- [`datasets/people`](datasets/people) — people and contributors referenced by the project

## Adding a new dataset

1. **Create the dataset repo** with a `config.toml`, `package.json`, `.github/workflows/deploy.yml`, and `.gitignore` — use an existing dataset as a template.

2. **Add it as a submodule** in this repo:
   ```sh
   git submodule add git@github.com:heterarchy-society/<name>.git datasets/<name>
   ```

3. **Register it in the rebuild workflow** — add the repo name to the matrix in [`.github/workflows/rebuild-datasets.yml`](.github/workflows/rebuild-datasets.yml):
   ```yaml
   repo: ["books", "glossary", "writings", "<name>"]
   ```
   This ensures the dataset is rebuilt automatically whenever Atlas itself is updated.

4. **Update `DATASET_DISPATCH_TOKEN`** — the token in [GitHub repository secrets](https://github.com/heterarchy-society/atlas/settings/secrets/actions) must have `contents: write` access to the new repo. Regenerate or update it at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens).

5. **Update `WEB_DISPATCH_TOKEN`** in the new dataset repo's secrets — this token is used by the dataset's deploy workflow to trigger a website rebuild after each deploy. It needs `contents: write` access to the `heterarchy-society/heterarchy.fyi` repo.
