# Saturn Marketplace

The list of community languages and themes for [Saturn](https://github.com/Saturn-Editor). Saturn has no server: it reads [`index.json`](index.json) straight from this repo at

```
https://raw.githubusercontent.com/Saturn-Editor/Marketplace/refs/heads/main/index.json
```

## Submitting a language or theme

1. Publish a GitHub Release in your own repo with a `.zip` asset. The zip holds your folder's contents **at its root**:
   - a language has `saturn-module.json` at the top level;
   - a theme has `theme.json` at the top level.
2. Get the zip's SHA-256: `shasum -a 256 my-theme-1.0.0.zip` (macOS) or `sha256sum my-theme-1.0.0.zip` (Linux).
3. Open a pull request that adds your entry to `languages` or `themes` in `index.json`. To publish an update, change `version`, `download` and `sha256` on your existing entry.

A check downloads your zip, compares its SHA-256, and validates the manifest inside it. A maintainer then reviews and merges.

### Language entry

```json
{
  "id": "markdown",
  "name": "Markdown",
  "description": "Markdown editing and preview.",
  "author": "Saturn-Editor",
  "repo": "Saturn-Editor/Language-Markdown",
  "version": "0.1.0",
  "saturnApi": "^0.1",
  "badge": "MD",
  "default": true,
  "download": "https://github.com/Saturn-Editor/Language-Markdown/releases/download/v0.1.0/markdown-0.1.0.zip",
  "sha256": "<64 hex characters>"
}
```

`badge` is optional. `default` is optional (`true` or `false`): languages with `"default": true` are pre-ticked in Saturn's first-launch "Welcome to Saturn" popup, where the user can untick them before they are installed. The zip's `saturn-module.json` must have the same `id` and `version`, and a `saturnApi` caret range.

### Theme entry

```json
{
  "id": "midnight",
  "name": "Midnight",
  "description": "A deep blue theme.",
  "author": "you",
  "repo": "you/saturn-midnight",
  "version": "1.0.0",
  "download": "https://github.com/you/saturn-midnight/releases/download/v1.0.0/midnight-1.0.0.zip",
  "sha256": "<64 hex characters>"
}
```

One theme holds both its light and dark variants. Saturn's Light/Dark toggle picks which one is shown. `theme.json` is a theme repo's only manifest. The zip's `theme.json` has the same `id` and `version` as the entry, a `name`, an optional `description`, and a `light` variant, a `dark` variant, or (usually) both:

```json
{
  "id": "midnight",
  "name": "Midnight",
  "version": "1.0.0",
  "description": "A deep blue theme.",
  "light": {
    "colors": { "app": "slate-100", "editor": "white", "...": "..." },
    "syntax": [{ "scope": "keyword", "color": "indigo-600", "fontStyle": "bold" }]
  },
  "dark": {
    "colors": { "app": "slate-950", "editor": "slate-900", "...": "..." },
    "syntax": [{ "scope": "keyword", "color": "indigo-300" }]
  }
}
```

Each variant needs a `syntax` array and a Tailwind colour (e.g. `neutral-900`, `white`, `amber-500/18`) for every one of these tokens: `app`, `editor`, `panel`, `raised`, `divider`, `border`, `text`, `strong`, `muted`, `accent`, `on-accent`, `selection`, `hover`.

A syntax rule is `{ "scope", "color"?, "fontStyle"? }`:

- `scope` is a TextMate scope. It can list space-separated ancestor scopes, e.g. `comment.block.documentation entity.name.tag`.
- `color` is optional: a Tailwind colour, or a theme token such as `text` or `muted`.
- `fontStyle` is optional: any of `bold`, `italic`, `underline`, `strikethrough`, space-separated, or `""` to reset.

### Rules

- `id` is lowercase `a-z`, `0-9`, `.` and `-`, and unique across all languages and themes.
- `version` is semver (`1.2.3`).
- `languages` and `themes` must each have at least one entry.
- `download` must be a `.zip` under `https://github.com/<repo>/releases/download/`.

## Checking locally

```sh
npm run validate            # structure + download/verify every entry
node scripts/validate.mjs --offline   # structure only
```
