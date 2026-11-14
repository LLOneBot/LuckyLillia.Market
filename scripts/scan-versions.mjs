import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isPackageName, isVersion, preserveImageBlanks, resolvePlugin } from './catalog.mjs';
import { reviewPackage } from './review.mjs';
import { GitHub, output, same, saveReport, stableKey } from './github.mjs';
import { versionCommentBody, versionIssueBody } from './pr-description.mjs';

const ISSUE_PREFIX = '插件更新暂缓：';

function versionIssueName(issue) {
  if (!issue || issue.pull_request || issue.state !== 'open'
      || issue.user?.type !== 'Bot' || issue.user.login !== 'github-actions[bot]'
      || !Number.isSafeInteger(issue.number) || issue.number < 1
      || typeof issue.title !== 'string' || !issue.title.startsWith(ISSUE_PREFIX)) return;
  // Existing Issues identify the package/version in their title and hash marker.
  const target = issue.title.slice(ISSUE_PREFIX.length);
  const separator = target.lastIndexOf('@');
  const name = separator > 0 ? target.slice(0, separator) : target;
  const version = separator > 0 ? target.slice(separator + 1) : undefined;
  if (!isPackageName(name) || (version !== undefined && !isVersion(version))) return;
  const marker = `<!-- market-review:${stableKey(`${name}@${version ?? 'metadata'}`)} -->`;
  if (String(issue.body ?? '').split(/\r?\n/, 1)[0] === marker) return name;
}

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
    const previous = plugins[index];
    plugins[index] = preserveImageBlanks(update.plugin, previous);
    // A release cannot replace the category chosen during registration or by a maintainer.
    if (previous.category !== undefined) plugins[index].category = previous.category;
    changed = true;
  }
  return { plugins, changed };
}

export async function scanVersions({ github = new GitHub(), resolve, review, issue, env = process.env, save = saveReport, log = console.log } = {}) {
  const name = issue ? versionIssueName(issue) : undefined;
  if (issue && !name) return;
  await output('changed', 'false');
  const branch = await github.defaultBranch();
  const original = await github.snapshot(branch);
  const plugins = name ? original.plugins.filter(plugin => plugin.name === name) : original.plugins;
  if (name) log(`[market/versions] Issue #${issue.number}: 检查 ${name} 的 npm latest。`);
  const { updates, reports } = await scanCatalog({ plugins }, { resolve, review });
  const reason = name && !reports.length ? (plugins.length ? 'up_to_date' : 'not_registered') : undefined;
  await save('versions', {
    scannedAt: new Date().toISOString(), plugins: plugins.length, reports,
    ...(name ? { name, issue: issue.number } : {}),
    ...(reason ? { skipped: true, reason } : {}),
  });
  const finish = async result => {
    if (issue) await github.comment(issue.number, '<!-- market-version-retry -->', versionCommentBody(result, env));
    return result;
  };
  for (const report of reports.filter(report => !report.assessment.approved)) {
    await github.reportIssue(`${report.name}@${report.version ?? 'metadata'}`, `${ISSUE_PREFIX}${report.name}${report.version ? `@${report.version}` : ''}`,
      versionIssueBody(report, env));
  }
  if (!updates.length) return finish({ changed: false, reports, ...(reason ? { reason } : {}) });
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await github.snapshot(branch);
    const next = applyUpdates(current, updates);
    if (!next.changed) return finish({ changed: false, reports });
    try {
      const sha = await github.commitCatalog(branch, current, next.plugins, 'Update approved plugin versions');
      await output('changed', 'true');
      await output('sha', sha);
      return finish({ changed: true, reports, sha });
    } catch (error) {
      if (attempt === 2 || !['HTTP_409', 'HTTP_422'].includes(error.code)) throw error;
    }
  }
}

export async function scanEvent({ github = new GitHub(), event, env = process.env, ...options } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'issue_comment') return scanVersions({ ...options, github, env });
  if (event?.action !== 'created' || event.comment?.user?.type !== 'User' || !versionIssueName(event.issue)) return;
  // Recheck live state after queueing, before accessing npm or reviewing a package.
  const issue = await github.request('GET', `/issues/${event.issue.number}`);
  if (!versionIssueName(issue)) return;
  return scanVersions({ ...options, github, issue, env });
}

async function main() {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  await scanEvent({ event });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
