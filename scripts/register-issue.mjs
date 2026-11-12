import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isCategory, isImagePath, isImageSource, isPackageName, isVersion, PLUGIN_CATEGORIES, preserveImageBlanks, resolvePlugin } from './catalog.mjs';
import { reviewPackage } from './review.mjs';
import { registrationBody, reviewSummary, runUrl } from './pr-description.mjs';
import { GitHub, literal, same, sortPlugins, saveReport } from './github.mjs';

const REGISTRATION_MARKER = '<!-- market-registration -->';

function isRegistrationIssue(issue) {
  return issue && !issue.pull_request && issue.state === 'open' && /^### npm 包名\s*$/m.test(issue.body ?? '');
}

function registrationMarker(name, version) {
  // Keep retry state invisible; Issue comments still show only status and summary.
  return isPackageName(name) && isVersion(version)
    ? `${REGISTRATION_MARKER}\n<!-- market-registration-version: ${name}@${version} -->`
    : REGISTRATION_MARKER;
}

function previousRegistrationVersion(comments, name) {
  const prefix = `<!-- market-registration-version: ${name}@`;
  for (const comment of comments.toReversed()) {
    // A copied marker in a user's or another app's comment is not a review record.
    if (comment.user?.type !== 'Bot' || comment.user?.login !== 'github-actions[bot]') continue;
    const [marker, record] = String(comment.body ?? '').split(/\r?\n/, 2);
    if (marker !== REGISTRATION_MARKER || !record?.startsWith(prefix) || !record.endsWith(' -->')) continue;
    const version = record.slice(prefix.length, -4);
    if (isVersion(version)) return version;
  }
}

export function parseRegistration(body) {
  const sections = [...String(body ?? '').matchAll(/^### npm 包名\s*\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  if (sections.length !== 1) throw new Error('请使用插件登记模板，只填写一个 npm 包名。');
  const name = sections[0][1].trim().replace(/^`([^`]+)`$/, '$1');
  if (!isPackageName(name)) throw new Error('npm 包名无效；请填写完整包名，例如 @scope/luckylillia-plugin-example，不要填写 URL 或版本号。');
  return name;
}

export function parseRegistrationCategory(body) {
  const sections = [...String(body ?? '').matchAll(/^### 插件分类\s*\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  if (sections.length > 1) throw new Error('请在登记模板中只选择一个插件分类。');
  // Older Issues predate the dropdown; use the published llbot.category for them.
  if (!sections.length) return undefined;
  const value = sections[0][1].trim().replace(/^`([^`]+)`$/, '$1');
  const category = Object.entries(PLUGIN_CATEGORIES).find(([key, label]) => [key, label, `${label} (${key})`].includes(value))?.[0];
  if (!category) throw new Error(`请选择有效的插件分类：${Object.values(PLUGIN_CATEGORIES).join('、')}。`);
  return category;
}

export function parseRegistrationIcon(body) {
  const sections = [...String(body ?? '').matchAll(/^### icon\s*\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  if (sections.length > 1) throw new Error('请在登记模板中只填写一个 icon。');
  if (!sections.length) return undefined;
  const icon = sections[0][1].trim().replace(/^`([^`]+)`$/, '$1');
  if (!icon || icon === '_No response_') return undefined;
  if (!isImageSource(icon)) throw new Error('icon 必须是与 package.json.llbot.icon 相同的包内图片相对路径或 HTTP(S) 图片地址。');
  return icon;
}

export function parseRegistrationScreenshots(body) {
  const sections = [...String(body ?? '').matchAll(/^### screenshots\s*\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  if (sections.length > 1) throw new Error('请只填写一个 screenshots 栏，每行填写一张截图的路径。');
  if (!sections.length) return undefined;
  const value = sections[0][1].trim();
  if (!value || value === '_No response_') return undefined;
  const screenshots = value.split(/\r?\n/).map(line => line.trim().replace(/^`([^`]+)`$/, '$1')).filter(Boolean);
  if (screenshots.some(src => !isImagePath(src))) throw new Error('screenshots 每行必须是一个包内图片相对路径，例如 assets/preview.png；不要填写 URL、绝对路径或上传图片。');
  return screenshots;
}

export async function prepareRegistration(name, catalog, { category, icon, screenshots, previousVersion, resolve = resolvePlugin, review = reviewPackage } = {}) {
  if (category !== undefined && !isCategory(category)) throw new Error('请选择有效的插件分类。');
  const registered = catalog.plugins.find(plugin => plugin.name === name);
  if (registered) return { duplicate: true, version: registered.version };
  const resolved = await resolve(name);
  if (previousVersion !== undefined && resolved.version === previousVersion) return { ...resolved, skipped: true };
  const plugin = { ...resolved.plugin, category: category ?? (isCategory(resolved.plugin.category) ? resolved.plugin.category : 'other') };
  if (icon !== undefined && icon !== resolved.plugin.icon) throw new Error('Issue 中的 icon 与所检查 npm 版本的 package.json.llbot.icon 不一致，请填写该版本声明的相同图片路径或地址。');
  const publishedScreenshots = (resolved.plugin.screenshots ?? []).map(item => typeof item === 'string' ? item : item.src);
  if (screenshots !== undefined && !same(screenshots, publishedScreenshots)) throw new Error('Issue 中的 screenshots 与所检查 npm 版本的 package.json.llbot.screenshots 不一致，请按相同顺序每行填写一个图片路径（对象项填写 src），或留空自动读取。');
  const assessment = await review(resolved.manifest);
  if (!assessment.approved) return { ...resolved, plugin, assessment, accepted: false };
  return {
    ...resolved, plugin, assessment, accepted: true,
    plugins: sortPlugins([...catalog.plugins, plugin]),
  };
}

export async function registerIssue({ github = new GitHub(), issue, checkVersion = false, resolve = resolvePlugin, review, env = process.env, save = saveReport, log = console.log } = {}) {
  if (!isRegistrationIssue(issue)) return;
  let name, version, previousVersion;
  const url = runUrl(env);
  const comment = body => github.comment(issue.number, registrationMarker(name, version), url ? `${body}\n\n[本次检查记录](${url})` : body);
  try {
    name = parseRegistration(issue.body);
    const category = parseRegistrationCategory(issue.body);
    const icon = parseRegistrationIcon(issue.body);
    const screenshots = parseRegistrationScreenshots(issue.body);
    const base = await github.defaultBranch();
    const catalog = await github.snapshot(base);
    const branch = `market/register-issue-${issue.number}`;
    let existing, branchCatalog;
    if (checkVersion && !catalog.plugins.some(plugin => plugin.name === name)) {
      previousVersion = previousRegistrationVersion(await github.list(`/issues/${issue.number}/comments`), name);
      if (previousVersion === undefined) {
        // Older successful runs have no hidden record, but their PR records the version.
        existing = await github.branch(branch);
        branchCatalog = existing ? await github.snapshot(branch) : null;
        previousVersion = branchCatalog?.plugins.find(plugin => plugin.name === name)?.version;
      }
    }
    const result = await prepareRegistration(name, catalog, {
      category, icon, screenshots, previousVersion, review,
      resolve: async requestedName => {
        const resolved = await resolve(requestedName);
        version = resolved.version;
        if (checkVersion) log(`[market/register] Issue #${issue.number}: ${name}，上次检查 ${previousVersion ?? '无记录'}，npm latest ${version}。`);
        return resolved;
      },
    });
    version = result.version;
    if (result.skipped || (checkVersion && result.duplicate)) {
      const report = { name, version, previousVersion, skipped: true, reason: result.duplicate ? 'already_registered' : 'version_unchanged' };
      await save(`registration-${issue.number}`, report);
      log(`[market/register] Issue #${issue.number}: ${result.duplicate ? '插件已登记，版本由每小时任务维护' : 'npm 版本未变化'}，结束本次评论触发的检查。`);
      return report;
    }
    await save(`registration-${issue.number}`, { name, version, previousVersion, assessment: result.assessment, duplicate: result.duplicate });
    if (result.duplicate) {
      await comment(`包 <code>${literal(name)}</code> 已登记，版本由每小时检查任务维护。`);
      return;
    }
    if (!result.accepted) {
      await comment(`登记暂缓，尚未写入目录。发布新版本后可在此 Issue 新增评论触发检查；需要重试同一版本时，请编辑此 Issue 或重新运行登记工作流。\n\n${reviewSummary(result.assessment)}`);
      return;
    }
    if (branchCatalog === undefined) {
      existing = await github.branch(branch);
      branchCatalog = existing ? await github.snapshot(branch) : null;
    }
    const previousPlugin = branchCatalog?.plugins.find(plugin => plugin.name === name);
    result.plugin = preserveImageBlanks(result.plugin, previousPlugin);
    if (category === undefined && previousPlugin?.category !== undefined) result.plugin.category = previousPlugin.category;
    result.plugins = result.plugins.map(plugin => plugin.name === name ? result.plugin : plugin);
    let sha = branchCatalog?.sha;
    if (!branchCatalog || !same(sortPlugins(branchCatalog.plugins), result.plugins)) {
      sha = await github.commitCatalog(branch, branchCatalog ?? catalog, result.plugins, `Register ${name}`, existing?.object.sha ?? catalog.sha);
    }
    const [owner] = github.repository.split('/');
    const pulls = await github.list(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    const body = registrationBody(result, issue.number, env);
    const pull = pulls[0]
      ? await github.request('PATCH', `/pulls/${pulls[0].number}`, { title: `登记插件：${name}`, body })
      : await github.request('POST', '/pulls', { title: `登记插件：${name}`, head: branch, base, body, maintainer_can_modify: true });
    // GITHUB_TOKEN-generated PRs do not trigger pull_request. Explicitly dispatch trusted validation.
    await github.dispatchValidation(pull.number);
    await comment(`字段检查已通过，已创建登记 PR：${pull.html_url}。首次版本为 <code>${literal(result.version)}</code>，合并后发布到 npm 目录包。\n\n${reviewSummary(result.assessment)}`);
    return { number: pull.number, sha };
  } catch (error) {
    await save(`registration-${issue.number}`, { name, version, previousVersion, error: error.message, retryable: Boolean(error.retryable) });
    await comment(`登记未完成，请根据下列原因处理后编辑此 Issue，或由维护者重跑工作流。${error.retryable ? '本次是临时服务错误，不代表包或仓库无效。' : ''}\n\n<pre>${literal(error.message)}</pre>`);
    throw error;
  }
}

export async function registerEvent({ github = new GitHub(), event, env = process.env, ...options } = {}) {
  const commentEvent = env.GITHUB_EVENT_NAME === 'issue_comment';
  if (commentEvent && (event.action !== 'created' || event.comment?.user?.type !== 'User' || !isRegistrationIssue(event.issue))) return;
  const requested = env.MARKET_ISSUE_NUMBER || event.inputs?.issue_number;
  if (requested && !/^[1-9]\d*$/.test(requested)) throw new Error('Issue 编号无效');
  // Queued comments must use the current Issue body and state.
  const issueNumber = requested || (commentEvent ? event.issue.number : undefined);
  const issue = issueNumber ? await github.request('GET', `/issues/${issueNumber}`) : event.issue;
  if (!issue) throw new Error('没有登记 Issue');
  return registerIssue({
    ...options, github, issue, env,
    // Explicit workflow reruns can recover from service errors without an npm release.
    checkVersion: commentEvent && Number(env.GITHUB_RUN_ATTEMPT ?? 1) === 1,
  });
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  await registerEvent({ event });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
