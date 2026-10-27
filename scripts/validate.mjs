#!/usr/bin/env node
// Validates the marketplace index.
//
//   node scripts/validate.mjs [index.json] [--base base-index.json] [--all] [--offline]
//
// The whole index is always checked structurally. Entries that are new or changed
// relative to --base (or every entry with --all) are also downloaded: the zip's
// sha256 must match the entry, and the manifest at the zip root must agree with it.
// --offline skips the download step.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirrors Saturn-Core src/shared/types.ts THEME_TOKENS.
const THEME_TOKENS = [
  'app', 'editor', 'panel', 'raised', 'divider', 'border', 'text',
  'strong', 'muted', 'accent', 'on-accent', 'selection', 'hover',
];

const SCHEMA = 1;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

const ID = /^[a-z0-9][a-z0-9.-]*$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Same shape satisfiesCaret() in Saturn-Core accepts.
const CARET = /^\^?\d+(?:\.\d+)?(?:\.\d+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Tailwind colour: "neutral-900", "white", "amber-500/18", "white/5".
const COLOR = /^(?:[a-z]+-(?:50|[1-9]00|950)|white|black|transparent)(?:\/\d{1,3})?$/;

const FIELDS = {
  languages: {
    required: ['id', 'name', 'description', 'author', 'repo', 'version', 'saturnApi', 'download', 'sha256'],
    optional: ['badge'],
    // Pre-ticked in Saturn's first-launch welcome popup.
    flags: ['default'],
  },
  themes: {
    required: ['id', 'name', 'description', 'author', 'repo', 'version', 'download', 'sha256'],
    optional: [],
    flags: [],
  },
};

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

function checkEntry(kind, entry, where) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(where, 'must be an object');
    return false;
  }
  const { required, optional, flags } = FIELDS[kind];
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
    if (!required.includes(key) && !optional.includes(key) && !flags.includes(key)) fail(where, `unknown field "${key}"`);
  }
  if (errors.length > before) return false;

  if (!ID.test(entry.id)) fail(where, `id "${entry.id}" must match [a-z0-9.-] and start with a letter or digit`);
  if (!REPO.test(entry.repo)) fail(where, `repo "${entry.repo}" must be "owner/name"`);
  if (!SEMVER.test(entry.version)) fail(where, `version "${entry.version}" must be semver (x.y.z)`);
  if (!SHA256.test(entry.sha256)) fail(where, 'sha256 must be 64 lowercase hex characters');
  if (kind === 'languages' && !CARET.test(entry.saturnApi)) {
    fail(where, `saturnApi "${entry.saturnApi}" must be a caret range like "^0.1"`);
  }

  // Releases must come from the author's own repo.
  const prefix = `https://github.com/${entry.repo}/releases/download/`;
  if (!entry.download.startsWith(prefix) || !entry.download.endsWith('.zip')) {
    fail(where, `download must be a .zip under ${prefix}`);
  }

  return errors.length === before;
}

function checkIndex(index) {
  if (!index || typeof index !== 'object') {
    fail('index.json', 'must be an object');
    return [];
  }
  if (index.schema !== SCHEMA) fail('index.json', `"schema" must be ${SCHEMA}`);
  for (const key of Object.keys(index)) {
    if (!['schema', 'languages', 'themes'].includes(key)) fail('index.json', `unknown field "${key}"`);
  }

  const valid = [];
  const seen = new Map();
  for (const kind of ['languages', 'themes']) {
    if (!Array.isArray(index[kind])) {
      fail('index.json', `"${kind}" must be an array`);
      continue;
    }
    // Saturn treats an empty list as a broken index.
    if (index[kind].length === 0) fail('index.json', `"${kind}" must not be empty`);
    index[kind].forEach((entry, i) => {
      const where = `${kind}[${i}]${isString(entry?.id) ? ` (${entry.id})` : ''}`;
      if (!checkEntry(kind, entry, where)) return;
      if (seen.has(entry.id)) {
        fail(where, `id "${entry.id}" is already used by ${seen.get(entry.id)}`);
        return;
      }
      seen.set(entry.id, where);
      valid.push({ kind, entry, where });
    });
  }
  return valid;
}

function checkLanguageManifest(manifest, entry, where) {
  for (const key of ['id', 'name', 'version', 'saturnApi']) {
    if (!isString(manifest[key])) fail(where, `saturn-module.json: "${key}" must be a non-empty string`);
  }
  if (manifest.id !== entry.id) fail(where, `saturn-module.json id "${manifest.id}" does not match entry id "${entry.id}"`);
  if (manifest.version !== entry.version) {
    fail(where, `saturn-module.json version "${manifest.version}" does not match entry version "${entry.version}"`);
  }
  if (isString(manifest.saturnApi) && !CARET.test(manifest.saturnApi)) {
    fail(where, `saturn-module.json saturnApi "${manifest.saturnApi}" must be a caret range like "^0.1"`);
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

async function checkRelease({ kind, entry, where }) {
  const res = await fetch(entry.download, { redirect: 'follow' });
  if (!res.ok) {
    fail(where, `download failed: HTTP ${res.status} ${entry.download}`);
    return;
  }
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > MAX_ZIP_BYTES) {
    fail(where, `zip is ${zip.length} bytes; the limit is ${MAX_ZIP_BYTES}`);
    return;
  }

  const sha256 = createHash('sha256').update(zip).digest('hex');
  if (sha256 !== entry.sha256) {
    fail(where, `sha256 mismatch: entry has ${entry.sha256}, the zip is ${sha256}`);
    return;
  }

  const manifestName = kind === 'languages' ? 'saturn-module.json' : 'theme.json';
  const dir = mkdtempSync(join(tmpdir(), 'saturn-market-'));
  try {
    const zipPath = join(dir, 'release.zip');
    writeFileSync(zipPath, zip);
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
    if (kind === 'languages') checkLanguageManifest(manifest, entry, where);
    else checkThemeManifest(manifest, entry, where);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function changedEntries(valid, basePath) {
  const base = basePath && existsSync(basePath) ? readJson(basePath, 'base index') : null;
  if (!base) return valid;
  const before = new Map();
  for (const kind of ['languages', 'themes']) {
    for (const entry of Array.isArray(base[kind]) ? base[kind] : []) {
      if (entry && typeof entry === 'object') before.set(`${kind}:${entry.id}`, JSON.stringify(entry));
    }
  }
  return valid.filter(({ kind, entry }) => before.get(`${kind}:${entry.id}`) !== JSON.stringify(entry));
}

const args = parseArgs(process.argv.slice(2));
const index = readJson(args.index, args.index);
const valid = index ? checkIndex(index) : [];

if (!args.offline) {
  const toFetch = args.all ? valid : changedEntries(valid, args.base);
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
console.log(`index.json OK (${valid.length} entr${valid.length === 1 ? 'y' : 'ies'})`);
