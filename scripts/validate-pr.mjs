import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { matchesPublishedPlugin, resolvePlugin, validateCatalog } from './catalog.mjs';
import { reviewPackage } from './review.mjs';
import { GitHub, saveReport } from './github.mjs';

export async function validateChanges(base, proposed, { resolve = resolvePlugin, review = reviewPackage } = {}) {
  validateCatalog(proposed.plugins, proposed.versions);
  const reports = [];
  for (const plugin of proposed.plugins) {
    const previous = base.plugins.find(entry => entry.name === plugin.name);
    const version = proposed.versions[plugin.name];
    if (isDeepStrictEqual(previous, plugin) && base.versions[plugin.name] === version) continue;
    const resolved = await resolve(plugin.name, { version });
    if (resolved.version !== version || !matchesPublishedPlugin(plugin, resolved.plugin)) throw new Error(`${plugin.name}@${version} 的目录字段与 npm 发布信息不一致。`);
    const assessment = await review(resolved.manifest);
    reports.push({ name: plugin.name, version, assessment });
  }
  return { approved: reports.every(report => report.assessment.approved), reports };
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const number = String(process.env.MARKET_PR_NUMBER || event.inputs?.pr_number || event.pull_request?.number || '');
  if (!/^[1-9]\d*$/.test(number)) throw new Error('PR 编号无效');
  const github = new GitHub();
  const pull = await github.request('GET', `/pulls/${number}`);
  if (pull.state !== 'open') return;
  const branch = await github.defaultBranch();
  if (pull.base.repo.full_name !== github.repository || pull.base.ref !== branch) throw new Error('目录变更必须提交到本仓库默认分支');
  const sha = pull.head.sha;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('无效的 PR commit');
  const status = (state, description) => github.request('POST', `/statuses/${sha}`, {
    state, context: 'market/catalog', description,
    target_url: `https://github.com/${github.repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  });
  await status('pending', '正在检查 npm 元数据、精确版本和配置的 AI 审查');
  try {
    const base = await github.snapshot(branch);
    // Only parse two JSON blobs at the immutable head SHA. Never checkout or run PR code.
    const plugins = await github.file('plugins.json', sha);
    const versions = await github.file('versions.json', sha);
    const result = await validateChanges(base, { plugins, versions });
    await saveReport(`pr-${number}`, { sha, ...result });
    if (!result.approved) throw new Error('一个或多个插件版本未通过审查，详情见工作流报告');
    await status('success', '目录字段、版本及当前配置的审查均通过');
  } catch (error) {
    await status('failure', '目录检查未通过，详情见工作流日志与报告');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
