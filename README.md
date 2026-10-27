# Saturn Marketplace

The list of community languages, themes and extensions for [Saturn](https://github.com/Saturn-Editor). Saturn has no server: it reads [`index.json`](index.json) straight from this repo at

```
https://raw.githubusercontent.com/Saturn-Editor/Marketplace/refs/heads/main/index.json
```

`index.json` (schema 2) only names one list file per kind. Saturn fetches it first, then only the list for the section being viewed:

```json
{
  "schema": 2,
  "languages": "languages.json",
  "themes": "themes.json",
  "extensions": "extensions.json"
}
```

| Kind | List | Manifest at the zip root |
| --- | --- | --- |
| Languages | [`languages.json`](languages.json) | `saturn-language.json` |
| Themes | [`themes.json`](themes.json) | `theme.json` |
| Extensions | [`extensions.json`](extensions.json) | `saturn-extension.json` |

Each list is a JSON array of entries, and each entry keeps a short history of its releases in `versions`, newest first. Saturn installs the newest version whose `saturnApi` matches the running Saturn. If a newer version needs a newer Saturn, the user is told to update Saturn to get it. If no version is compatible, the entry can't be installed.

## Submitting a language, theme or extension

1. Publish a GitHub Release in your own repo with a `.zip` asset. The zip holds your folder's contents **at its root**, with your manifest (see the table above) at the top level.
2. Get the zip's SHA-256: `shasum -a 256 my-theme-1.0.0.zip` (macOS) or `sha256sum my-theme-1.0.0.zip` (Linux).
3. Open a pull request that adds your entry to the right list file.

To publish an update, **add** a version at the top of your entry's `versions`. Don't replace the old one: users on an older Saturn keep installing the newest version their Saturn supports. Keep at most 10 versions and drop the oldest when you go over.

A check downloads each new or changed version's zip, compares its SHA-256, and validates the manifest inside it. A maintainer then reviews and merges.

### Language entry

```json
{
  "id": "markdown",
  "name": "Markdown",
  "description": "Markdown editing and preview.",
  "author": "Saturn-Editor",
  "repo": "Saturn-Editor/Language-Markdown",
  "image": "https://raw.githubusercontent.com/Saturn-Editor/Language-Markdown/main/icon.svg",
  "default": true,
  "versions": [
    {
      "version": "1.1.0",
      "saturnApi": "^0.2",
      "download": "https://github.com/Saturn-Editor/Language-Markdown/releases/download/v1.1.0/markdown-1.1.0.zip",
      "sha256": "<64 hex characters>"
    }
  ]
}
```

`image` is optional on every kind of entry: an `https` URL for the picture Saturn shows in the marketplace. `default` is optional (`true` or `false`): languages with `"default": true` are pre-ticked in Saturn's first-launch "Welcome to Saturn" popup, where the user can untick them before they are installed.

Each version's zip must have a `saturn-language.json` with the entry's `id`, that version's `version`, and a `saturnApi` caret range. The current Saturn API is `^0.2`.

Language and extension manifests may also declare:

- `requires`: `[{ "name", "command", "args"?, "install"? }]`, the external tools the module needs (`command` is run as-is, without `${setting:…}` substitution);
- `contributes.settings`: `[{ "id", "label", "type", "default"?, "options"?, "description"? }]`, where `type` is `text`, `select`, `checkbox`, `folder` or `file`;
- `contributes.buttons`: `[{ "command", "title", "icon"? }]`.

An `icon` is a relative `.svg` or `.png` path inside the zip, e.g. `icons/build.svg`. Subfolders are fine, but not `..` or absolute paths, and the file must be in the zip. The zip root may also hold `icon.svg` (or `icon.png` as a fallback) as the module's own picture.

### Theme entry

```json
{
  "id": "midnight",
  "name": "Midnight",
  "description": "A deep blue theme.",
  "author": "you",
  "repo": "you/saturn-midnight",
  "versions": [
    {
      "version": "1.0.0",
      "download": "https://github.com/you/saturn-midnight/releases/download/v1.0.0/midnight-1.0.0.zip",
      "sha256": "<64 hex characters>"
    }
  ]
}
```

Theme versions have no `saturnApi`. One theme holds both its light and dark variants. Saturn's Light/Dark toggle picks which one is shown. `theme.json` is a theme repo's only manifest. Each version's `theme.json` has the entry's `id`, that version's `version`, a `name`, an optional `description`, and a `light` variant, a `dark` variant, or (usually) both:

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

### Extension entry

```json
{
  "id": "claudecode",
  "name": "Claude Code",
  "description": "Claude Code integration for Saturn.",
  "author": "Saturn-Editor",
  "repo": "Saturn-Editor/Module-Claude",
  "image": "https://raw.githubusercontent.com/Saturn-Editor/Module-Claude/main/icon.svg",
  "versions": [
    {
      "version": "1.0.0",
      "saturnApi": "^0.2",
      "download": "https://github.com/Saturn-Editor/Module-Claude/releases/download/v1.0.0/claudecode-1.0.0.zip",
      "sha256": "<64 hex characters>"
    }
  ]
}
```

The same fields as a language, except that there is no `default`. Each version's zip must have a `saturn-extension.json` with the entry's `id`, that version's `version`, and a `saturnApi` caret range. Besides `requires`, settings and buttons, an extension can contribute `commands`, `runConfigurations` and `panels` (`[{ "id", "title", "dock", "icon"? }]`, where `dock` is `left` or `bottom`), but not `languages`, `languageServer`, `previews`, `fileTemplates` or `newProject`.

### Rules

- `id` is lowercase `a-z`, `0-9`, `.` and `-`, and unique across all languages, themes and extensions.
- `versions` has 1 to 10 entries, newest first, with no version listed twice. Each `version` is semver (`1.2.3`).
- `download` must be a `.zip` under `https://github.com/<repo>/releases/download/`, and `sha256` is 64 lowercase hex characters.
- `languages.json` and `themes.json` must each have at least one entry. `extensions` may be left out of `index.json`, but if it is listed, `extensions.json` must have at least one entry.

## Checking locally

```sh
node scripts/validate.mjs --all       # structure + download/verify every version
node scripts/validate.mjs --offline   # structure only
```
