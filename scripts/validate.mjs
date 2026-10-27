#!/usr/bin/env node
// Validates the marketplace index (schema 2).
//
//   node scripts/validate.mjs [index.json] [--base base/index.json] [--all] [--offline]
//
// index.json names one list file per kind (languages.json, themes.json, extensions.json),
// read from the same folder. The index and every list are always checked structurally.
// Versions that are new or changed relative to --base (or every version with --all) are
// also downloaded: the zip's sha256 must match, and the manifest at the zip root must agree
// with the entry's id and that version. --offline skips the download step.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Mirrors Saturn-Core src/shared/types.ts THEME_TOKENS.
const THEME_TOKENS = [
  'app', 'editor', 'panel', 'raised', 'divider', 'border', 'text',
  'strong', 'muted', 'accent', 'on-accent', 'selection', 'hover',
];

const SCHEMA = 2;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
// Each entry keeps a bounded release history; add a version rather than replacing one.
const MAX_VERSIONS = 10;

const ID = /^[a-z0-9][a-z0-9.-]*$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Same shape satisfiesCaret() in Saturn-Core accepts.
const CARET = /^\^?\d+(?:\.\d+)?(?:\.\d+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Same check Saturn-Core applies to list file names in index.json.
const LIST_FILE = /^[\w.-]+\.json$/;
// Tailwind colour: "neutral-900", "white", "amber-500/18", "white/5".
const COLOR = /^(?:[a-z]+-(?:50|[1-9]00|950)|white|black|transparent)(?:\/\d{1,3})?$/;

const FIELDS = {
  languages: {
    required: ['id', 'name', 'description', 'author', 'repo'],
    optional: ['image'],
    // Pre-ticked in Saturn's first-launch welcome popup.
    flags: ['default'],
    saturnApi: true,
  },
  themes: {
    required: ['id', 'name', 'description', 'author', 'repo'],
    optional: ['image'],
    flags: [],
    saturnApi: false,
  },
  extensions: {
    required: ['id', 'name', 'description', 'author', 'repo'],
    optional: ['image'],
    flags: [],
    saturnApi: true,
  },
};

const KINDS = Object.keys(FIELDS);
// Kinds Saturn reads as empty when missing; the rest must be present.
const OPTIONAL_KINDS = ['extensions'];
const MANIFESTS = { languages: 'saturn-language.json', themes: 'theme.json', extensions: 'saturn-extension.json' };

// Same check Saturn-Core applies to button and panel icons: a relative .svg/.png path in the module.
const ICON = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(svg|png)$/i;
const DOCKS = ['left', 'bottom'];
const SETTING_TYPES = ['text', 'select', 'checkbox', 'folder', 'file'];
// Contributions only languages may make.
const LANGUAGE_ONLY = ['languages', 'languageServer', 'previews', 'fileTemplates', 'newProject'];

const VARIANTS = ['light', 'dark'];
const FONT_STYLES = ['bold', 'italic', 'underline', 'strikethrough'];

const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

function parseArgs(argv) {
  const args = { index: 'index.json', base: null, all: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') args.base = argv[++i];
    else if (arg === '--all') args.all = true;
    else if (arg === '--offline') args.offline = true;
    else args.index = arg;
  }
  return args;
}

function readJson(path, where) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(where, `cannot read JSON (${err.message})`);
    return null;
  }
}

const isString = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// Orders semver strings; a pre-release sorts before its release.
function compareSemver(a, b) {
  const split = (v) => {
    const dash = v.indexOf('-');
    return dash === -1 ? [v, null] : [v.slice(0, dash), v.slice(dash + 1)];
  };
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  const numsA = coreA.split('.').map(Number);
  const numsB = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (numsA[i] !== numsB[i]) return numsA[i] - numsB[i];
  if (preA === preB) return 0;
  if (preA === null) return 1;
  if (preB === null) return -1;
  return preA.localeCompare(preB, 'en', { numeric: true });
}

// Checks one entry of a list file and returns its well-formed versions.
function checkEntry(kind, entry, where) {
  if (!isObject(entry)) {
    fail(where, 'must be an object');
    return [];
  }
  const { required, optional, flags, saturnApi } = FIELDS[kind];
  const before = errors.length;

  for (const key of required) {
    if (!isString(entry[key])) fail(where, `"${key}" must be a non-empty string`);
  }
  for (const key of optional) {
    if (key in entry && !isString(entry[key])) fail(where, `"${key}" must be a non-empty string`);
  }
  for (const key of flags) {
    if (key in entry && typeof entry[key] !== 'boolean') fail(where, `"${key}" must be true or false`);
  }
  for (const key of Object.keys(entry)) {
    if (key !== 'versions' && !required.includes(key) && !optional.includes(key) && !flags.includes(key)) {
      fail(where, `unknown field "${key}"`);
    }
  }
  if (errors.length > before) return [];

  if (!ID.test(entry.id)) fail(where, `id "${entry.id}" must match [a-z0-9.-] and start with a letter or digit`);
  if (!REPO.test(entry.repo)) fail(where, `repo "${entry.repo}" must be "owner/name"`);
  if ('image' in entry && !isHttpsUrl(entry.image)) fail(where, `image "${entry.image}" must be an https URL`);

  const versions = entry.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    fail(where, '"versions" must be a non-empty array');
    return [];
  }
  if (versions.length > MAX_VERSIONS) {
    fail(where, `has ${versions.length} versions; keep at most ${MAX_VERSIONS} (drop the oldest)`);
  }

  // Releases must come from the author's own repo.
  const prefix = `https://github.com/${entry.repo}/releases/download/`;
  const keys = ['version', 'download', 'sha256', ...(saturnApi ? ['saturnApi'] : [])];
  const valid = [];
  versions.forEach((release, i) => {
    const at = `${where} versions[${i}]`;
    if (!isObject(release)) {
      fail(at, 'must be an object');
      return;
    }
    const start = errors.length;
    for (const key of keys) {
      if (!isString(release[key])) fail(at, `"${key}" must be a non-empty string`);
    }
    for (const key of Object.keys(release)) {
      if (!keys.includes(key)) fail(at, kind === 'themes' && key === 'saturnApi' ? 'themes have no "saturnApi"' : `unknown field "${key}"`);
    }
    if (errors.length > start) return;

    if (!SEMVER.test(release.version)) fail(at, `version "${release.version}" must be semver (x.y.z)`);
    if (!SHA256.test(release.sha256)) fail(at, 'sha256 must be 64 lowercase hex characters');
    if (saturnApi && !CARET.test(release.saturnApi)) {
      fail(at, `saturnApi "${release.saturnApi}" must be a caret range like "^0.2"`);
    }
    if (!release.download.startsWith(prefix) || !release.download.endsWith('.zip')) {
      fail(at, `download must be a .zip under ${prefix}`);
    }
    if (errors.length === start) valid.push(release);
  });

  // Saturn reads versions newest first.
  for (let i = 1; i < valid.length; i++) {
    const order = compareSemver(valid[i - 1].version, valid[i].version);
    if (order === 0) fail(where, `version ${valid[i].version} is listed twice`);
    else if (order < 0) fail(where, `versions must be newest first (${valid[i - 1].version} is listed before ${valid[i].version})`);
  }
  return valid;
}

// Reads index.json and its list files: { kind: { file, entries } }, or null if unreadable.
function loadIndex(indexPath, report = true) {
  const where = (label) => (report ? label : `base ${label}`);
  const index = readJson(indexPath, where(indexPath));
  if (!isObject(index)) {
    if (index) fail(where('index.json'), 'must be an object');
    return null;
  }
  if (index.schema !== SCHEMA) {
    fail(where('index.json'), `"schema" must be ${SCHEMA}`);
    return null;
  }
  for (const key of Object.keys(index)) {
    if (!['schema', ...KINDS].includes(key)) fail(where('index.json'), `unknown field "${key}"`);
  }

  const lists = {};
  const files = new Set();
  for (const kind of KINDS) {
    const file = index[kind];
    if (file === undefined && OPTIONAL_KINDS.includes(kind)) continue;
    if (typeof file !== 'string' || !LIST_FILE.test(file)) {
      fail(where('index.json'), `"${kind}" must be a list file name like "${kind}.json"`);
      continue;
    }
    if (files.has(file)) fail(where('index.json'), `"${kind}" reuses ${file}`);
    files.add(file);
    const entries = readJson(join(dirname(indexPath), file), where(file));
    if (!Array.isArray(entries)) {
      if (entries) fail(where(file), 'must be a JSON array of entries');
      continue;
    }
    // Saturn treats an empty list as a broken index.
    if (entries.length === 0) fail(where(file), 'must not be empty');
    lists[kind] = { file, entries };
  }
  return lists;
}

// Returns one item per well-formed version: { kind, entry, release, where }.
function checkLists(lists) {
  const valid = [];
  const seen = new Map();
  for (const [kind, { file, entries }] of Object.entries(lists)) {
    entries.forEach((entry, i) => {
      const where = `${file}[${i}]${isString(entry?.id) ? ` (${entry.id})` : ''}`;
      const releases = checkEntry(kind, entry, where);
      if (!isString(entry?.id)) return;
      if (seen.has(entry.id)) {
        fail(where, `id "${entry.id}" is already used by ${seen.get(entry.id)}`);
        return;
      }
      seen.set(entry.id, where);
      for (const release of releases) valid.push({ kind, entry, release, where: `${where} ${release.version}` });
    });
  }
  return valid;
}

// files: every path in the zip, so icons can be checked to exist.
function checkModuleManifest(kind, manifest, entry, where, files) {
  const name = MANIFESTS[kind];
  for (const key of ['id', 'name', 'version', 'saturnApi']) {
    if (!isString(manifest[key])) fail(where, `${name}: "${key}" must be a non-empty string`);
  }
  if (manifest.id !== entry.id) fail(where, `${name} id "${manifest.id}" does not match entry id "${entry.id}"`);
  if (manifest.version !== entry.version) {
    fail(where, `${name} version "${manifest.version}" does not match entry version "${entry.version}"`);
  }
  if (isString(manifest.saturnApi) && !CARET.test(manifest.saturnApi)) {
    fail(where, `${name} saturnApi "${manifest.saturnApi}" must be a caret range like "^0.1"`);
  }

  const list = (value, at) => {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    fail(where, `${name}: ${at} must be an array`);
    return [];
  };
  const strings = (item, at, keys) => {
    for (const key of keys) if (!isString(item?.[key])) fail(where, `${at}.${key} must be a non-empty string`);
  };

  list(manifest.requires, '"requires"').forEach((item, i) => strings(item, `${name}: requires[${i}]`, ['name', 'command']));

  const contributes = manifest.contributes;
  if (contributes === undefined) return;
  if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) {
    fail(where, `${name}: "contributes" must be an object`);
    return;
  }
  list(contributes.settings, 'contributes.settings').forEach((item, i) => {
    const at = `${name}: contributes.settings[${i}]`;
    strings(item, at, ['id', 'label']);
    if (!SETTING_TYPES.includes(item?.type)) fail(where, `${at}.type must be one of ${SETTING_TYPES.join(', ')}`);
  });
  const icon = (item, at) => {
    if (item?.icon === undefined) return;
    if (typeof item.icon !== 'string' || !ICON.test(item.icon)) {
      fail(where, `${at}.icon "${item.icon}" must be a relative .svg or .png path inside the module`);
    } else if (files && !files.has(item.icon)) {
      fail(where, `${at}.icon "${item.icon}" is not in the zip`);
    }
  };
  list(contributes.buttons, 'contributes.buttons').forEach((item, i) => {
    const at = `${name}: contributes.buttons[${i}]`;
    strings(item, at, ['command', 'title']);
    icon(item, at);
  });
  if (kind === 'extensions') {
    list(contributes.panels, 'contributes.panels').forEach((item, i) => {
      const at = `${name}: contributes.panels[${i}]`;
      strings(item, at, ['id', 'title']);
      if (!DOCKS.includes(item?.dock)) fail(where, `${at}.dock must be ${DOCKS.map((d) => `"${d}"`).join(' or ')}`);
      icon(item, at);
    });
    for (const key of LANGUAGE_ONLY) {
      if (key in contributes) fail(where, `${name}: extensions cannot contribute "${key}" (languages only)`);
    }
  }
}

function checkThemeManifest(theme, entry, where) {
  for (const key of ['id', 'name', 'version']) {
    if (!isString(theme[key])) fail(where, `theme.json: "${key}" must be a non-empty string`);
  }
  if ('description' in theme && !isString(theme.description)) fail(where, 'theme.json: "description" must be a non-empty string');
  if (theme.id !== entry.id) fail(where, `theme.json id "${theme.id}" does not match entry id "${entry.id}"`);
  if (theme.version !== entry.version) {
    fail(where, `theme.json version "${theme.version}" does not match entry version "${entry.version}"`);
  }
  for (const key of Object.keys(theme)) {
    if (!['id', 'name', 'version', 'description', ...VARIANTS].includes(key)) fail(where, `theme.json: unknown field "${key}"`);
  }

  const present = VARIANTS.filter((variant) => theme[variant] !== undefined);
  if (present.length === 0) fail(where, 'theme.json: needs a "light" or "dark" variant (or both)');
  for (const variant of present) checkThemeVariant(theme[variant], `theme.json: ${variant}`, where);
}

function checkThemeVariant(variant, at, where) {
  if (!variant || typeof variant !== 'object' || Array.isArray(variant)) {
    fail(where, `${at} must be an object`);
    return;
  }
  for (const key of Object.keys(variant)) {
    if (key !== 'colors' && key !== 'syntax') fail(where, `${at}: unknown field "${key}"`);
  }

  const colors = variant.colors;
  if (!colors || typeof colors !== 'object') {
    fail(where, `${at}: "colors" must be an object`);
  } else {
    for (const token of THEME_TOKENS) {
      if (!(token in colors)) fail(where, `${at}: colors."${token}" is missing`);
      else if (typeof colors[token] !== 'string' || !COLOR.test(colors[token])) {
        fail(where, `${at}: colors."${token}" "${colors[token]}" is not a Tailwind colour like "neutral-900" or "amber-500/18"`);
      }
    }
    for (const token of Object.keys(colors)) {
      if (!THEME_TOKENS.includes(token)) fail(where, `${at}: unknown colour token "${token}"`);
    }
  }

  if (!Array.isArray(variant.syntax)) {
    fail(where, `${at}: "syntax" must be an array`);
    return;
  }
  variant.syntax.forEach((rule, i) => {
    const ruleAt = `${at}: syntax[${i}]`;
    if (!isString(rule?.scope)) fail(where, `${ruleAt}.scope must be a non-empty string`);
    // A colour is a Tailwind colour or one of the theme's own tokens ("text", "muted").
    if (rule?.color !== undefined && !(typeof rule.color === 'string' && (COLOR.test(rule.color) || THEME_TOKENS.includes(rule.color)))) {
      fail(where, `${ruleAt}.color "${rule.color}" is not a Tailwind colour or theme token`);
    }
    // Space-separated styles; "" resets.
    if (rule?.fontStyle !== undefined && !(typeof rule.fontStyle === 'string'
      && rule.fontStyle.split(' ').filter(Boolean).every((style) => FONT_STYLES.includes(style)))) {
      fail(where, `${ruleAt}.fontStyle "${rule.fontStyle}" must be space-separated ${FONT_STYLES.join('/')} or ""`);
    }
  });
}

async function checkRelease({ kind, entry, release, where }) {
  const res = await fetch(release.download, { redirect: 'follow' });
  if (!res.ok) {
    fail(where, `download failed: HTTP ${res.status} ${release.download}`);
    return;
  }
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > MAX_ZIP_BYTES) {
    fail(where, `zip is ${zip.length} bytes; the limit is ${MAX_ZIP_BYTES}`);
    return;
  }

  const sha256 = createHash('sha256').update(zip).digest('hex');
  if (sha256 !== release.sha256) {
    fail(where, `sha256 mismatch: entry has ${release.sha256}, the zip is ${sha256}`);
    return;
  }

  const manifestName = MANIFESTS[kind];
  const dir = mkdtempSync(join(tmpdir(), 'saturn-market-'));
  try {
    const zipPath = join(dir, 'release.zip');
    writeFileSync(zipPath, zip);
    let files;
    try {
      files = new Set(execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean));
    } catch {
      fail(where, 'the download is not a readable zip');
      return;
    }
    if (!files.has(manifestName)) {
      fail(where, `${manifestName} must be at the root of the zip (not inside a folder)`);
      return;
    }
    // Extract only the manifest; unzip refuses paths outside the target directory.
    try {
      execFileSync('unzip', ['-qq', '-o', zipPath, manifestName, '-d', join(dir, 'out')], { stdio: 'pipe' });
    } catch {
      fail(where, `${manifestName} must be at the root of the zip (not inside a folder)`);
      return;
    }
    const manifestPath = join(dir, 'out', manifestName);
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
      fail(where, `${manifestName} must be at the root of the zip`);
      return;
    }
    const manifest = readJson(manifestPath, `${where}: ${manifestName}`);
    if (!manifest || typeof manifest !== 'object') return;
    // The manifest must describe exactly this version of this entry.
    const expected = { id: entry.id, version: release.version };
    if (kind === 'themes') checkThemeManifest(manifest, expected, where);
    else checkModuleManifest(kind, manifest, expected, where, files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Versions whose release differs from --base. A base on an older schema counts as empty.
function changedVersions(valid, basePath) {
  if (!basePath || !existsSync(basePath)) return valid;
  const baseErrors = errors.length;
  const lists = loadIndex(basePath, false);
  // Problems in the base index aren't this change's fault.
  errors.length = baseErrors;
  if (!lists) return valid;
  const before = new Map();
  for (const [kind, { entries }] of Object.entries(lists)) {
    for (const entry of entries) {
      for (const release of Array.isArray(entry?.versions) ? entry.versions : []) {
        before.set(`${kind}:${entry.id}:${release?.version}`, JSON.stringify(release));
      }
    }
  }
  return valid.filter(({ kind, entry, release }) => (
    before.get(`${kind}:${entry.id}:${release.version}`) !== JSON.stringify(release)
  ));
}

const args = parseArgs(process.argv.slice(2));
const lists = loadIndex(args.index);
const valid = lists ? checkLists(lists) : [];

if (!args.offline) {
  const toFetch = args.all ? valid : changedVersions(valid, args.base);
  for (const item of toFetch) {
    console.log(`Checking release for ${item.where}`);
    try {
      await checkRelease(item);
    } catch (err) {
      fail(item.where, `release check failed (${err.message})`);
    }
  }
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(`index OK (${valid.length} version${valid.length === 1 ? '' : 's'})`);
