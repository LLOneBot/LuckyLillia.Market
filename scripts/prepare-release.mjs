import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fetchJson, readCatalog } from './catalog.mjs';
import { output, pretty } from './github.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function catalogHash(plugins, versions) {
  return createHash('sha256').update(JSON.stringify(canonical({
    plugins: [...plugins].sort((a, b) => a.name.localeCompare(b.name, 'en')), versions,
  }))).digest('hex');
}

export function releasePlan(pkg, catalog, latest) {
  const hash = catalogHash(catalog.plugins, catalog.versions);
  if (latest?.market?.catalogHash === hash) return { publish: false, version: latest.version, hash };
  if (!latest) return { publish: true, version: pkg.version, hash };
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(latest.version);
  if (!match || !Number.isSafeInteger(Number(match[3]) + 1)) throw new Error('市场目录包 latest 版本必须是稳定的 x.y.z 版本');
  return { publish: true, version: `${match[1]}.${match[2]}.${Number(match[3]) + 1}`, hash };
}

export async function prepareRelease({ root = process.cwd(), fetchImpl = globalThis.fetch } = {}) {
  const pkgPath = `${root}/package.json`;
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (pkg.name !== '@luckylillia/market') throw new Error('市场目录包名不匹配');
  const catalog = await readCatalog(root);
  let latest;
  try { latest = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`, { fetchImpl }); }
  catch (error) { if (error.code !== 'HTTP_404') throw error; }
  const plan = releasePlan(pkg, catalog, latest);
  if (plan.publish) {
    pkg.version = plan.version;
    pkg.market = { schemaVersion: 1, catalogHash: plan.hash };
    await writeFile(pkgPath, pretty(pkg));
  }
  await output('publish', String(plan.publish));
  await output('version', plan.version);
  console.log(plan.publish ? `目录变化，准备发布 ${pkg.name}@${plan.version}` : '目录内容未变化，跳过发布');
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareRelease().catch(error => { console.error(error.message); process.exitCode = 1; });
}
