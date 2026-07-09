// Регенерация registry.json из GitHub Releases. Источник истины — реально загруженные ассеты (zip плагинов
// по аркам). Поэтому сборка на РАЗНЫХ машинах/в разное время НЕ требует ручной синхронизации индекса: каждая
// машина заливает свои арки в Release (`gh release upload <tag> <zip>`), потом любой запуск этого скрипта
// пересобирает registry.json из того, что фактически опубликовано. Недостающая арка просто отсутствует, пока
// её машина не зальёт. sha256 не считаем (качаем с GitHub по HTTPS).
//
// Запуск из корня репо реестра (нужен `gh`, авторизованный токеном публикатора):
//   node scripts/regen-registry.mjs
// ENV (опц.): REGISTRY_REPO=owner/repo (иначе — из git remote текущего репо), REGISTRY_NAME="…".

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh ${args.join(' ')} → ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

const slug = process.env.REGISTRY_REPO || JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
const releases = JSON.parse(gh(['api', `repos/${slug}/releases`, '--paginate']));

// Имя ассета: <id>-<version>-<platform>-<arch>.zip → вытаскиваем platform-arch.
const ARCH_RE = /-(darwin-(?:arm64|x64)|win32-(?:x64|arm64|ia32)|linux-(?:x64|arm64))\.zip$/;

// tag: <pluginId>-v<version>. Держим самый свежий Release на плагин.
const byPlugin = new Map();
for (const rel of releases) {
  if (rel.draft) continue;
  const m = /^(.+)-v(\d[\w.-]*)$/.exec(rel.tag_name || '');
  if (!m) continue;
  const [, id, version] = m;
  const downloads = {};
  for (const a of rel.assets || []) {
    const am = ARCH_RE.exec(a.name);
    if (am) downloads[am[1]] = a.browser_download_url;
  }
  if (!Object.keys(downloads).length) continue;
  const prev = byPlugin.get(id);
  if (!prev || new Date(rel.created_at) > new Date(prev._at)) {
    byPlugin.set(id, { version, downloads, _at: rel.created_at });
  }
}

// Витрина-метаданные из plugins/<id>/manifest.json (имя/описание/права — для показа в Hub до установки).
const plugins = [];
for (const [id, info] of byPlugin) {
  let meta = {};
  const mf = path.join(repoRoot, 'plugins', id, 'manifest.json');
  if (fs.existsSync(mf)) {
    try { meta = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { /* битый манифест витрины — пропускаем метаданные */ }
  }
  const entry = {
    id,
    name: meta.name || id,
    version: info.version,
    tier: meta.tier || 'community',
    description: meta.description || '',
    permissions: Array.isArray(meta.permissions) ? meta.permissions : [],
    icon: meta.icon || '',
    downloads: info.downloads,
  };
  if (Array.isArray(meta.egress)) entry.egress = meta.egress;
  plugins.push(entry);
}
plugins.sort((a, b) => a.id.localeCompare(b.id));

const registry = {
  name: process.env.REGISTRY_NAME || '1Cifer Community Plugins (unofficial)',
  schema: 1,
  plugins,
};
fs.writeFileSync(path.join(repoRoot, 'registry.json'), JSON.stringify(registry, null, 2) + '\n');
console.log(
  `✓ registry.json (${slug}): ${plugins.length} плагин(ов) — ` +
    plugins.map((p) => `${p.id}@${p.version}[${Object.keys(p.downloads).join(',')}]`).join(', '),
);
