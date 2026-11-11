import { pathToFileURL } from 'node:url';
import { preserveImageBlanks, resolvePlugin } from './catalog.mjs';
import { reviewPackage } from './review.mjs';
import { GitHub, output, reportText, same, saveReport } from './github.mjs';

export async function scanCatalog(catalog, { resolve = resolvePlugin, review = reviewPackage } = {}) {
  const updates = [];
  const reports = [];
  for (const plugin of catalog.plugins) {
    let version;
    try {
      const resolved = await resolve(plugin.name);
      version = resolved.version;
      if (version === plugin.version) continue;
      const assessment = await review(resolved.manifest);
      reports.push({ name: plugin.name, previous: plugin.version, version, assessment });
      if (assessment.approved) updates.push({ ...resolved, previous: plugin.version, previousPlugin: plugin });
    } catch (error) {
      reports.push({ name: plugin.name, version, assessment: { approved: false, status: 'error', summary: error.message, retryable: Boolean(error.retryable) } });
    }
  }
  return { updates, reports };
}

// Rebase only unchanged entries. Never resurrect a removed plugin or overwrite a concurrent update.
export function applyUpdates(catalog, updates) {
  const plugins = [...catalog.plugins];
  let changed = false;
  for (const update of updates) {
    const index = plugins.findIndex(plugin => plugin.name === update.plugin.name);
    if (index < 0 || plugins[index].version !== update.previous) continue;
    if (update.previousPlugin && !same(plugins[index], update.previousPlugin)) continue;
    // An explicit blank hides the artwork across automatic version updates.
    // Missing fields in older entries may gain the newly published artwork.
    plugins[index] = preserveImageBlanks(update.plugin, plugins[index]);
    changed = true;
  }
  return { plugins, changed };
}

export async function scanVersions({ github = new GitHub(), resolve, review } = {}) {
  await output('changed', 'false');
  const branch = await github.defaultBranch();
  const original = await github.snapshot(branch);
  const { updates, reports } = await scanCatalog(original, { resolve, review });
  await saveReport('versions', { scannedAt: new Date().toISOString(), plugins: original.plugins.length, reports });
  for (const report of reports.filter(report => !report.assessment.approved)) {
    await github.reportIssue(`${report.name}@${report.version ?? 'metadata'}`, `插件更新暂缓：${report.name}${report.version ? `@${report.version}` : ''}`,
      `该插件保留原有版本。修复发布包或恢复审查服务后，每小时任务会重新检查；维护者也可以手动运行。\n\n${reportText(report)}`);
  }
  if (!updates.length) return { changed: false, reports };
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await github.snapshot(branch);
    const next = applyUpdates(current, updates);
    if (!next.changed) return { changed: false, reports };
    try {
      const sha = await github.commitCatalog(branch, current, next.plugins, 'Update approved plugin versions');
      await output('changed', 'true');
      await output('sha', sha);
      return { changed: true, reports, sha };
    } catch (error) {
      if (attempt === 2 || !['HTTP_409', 'HTTP_422'].includes(error.code)) throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  scanVersions().catch(error => { console.error(error.message); process.exitCode = 1; });
}
