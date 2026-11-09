import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isImagePath, isImageSource, isPackageName, preserveImageBlanks, resolvePlugin } from './catalog.mjs';
import { reviewPackage } from './review.mjs';
import { registrationBody } from './pr-description.mjs';
import { GitHub, literal, reportText, same, sortPlugins, saveReport } from './github.mjs';

export function parseRegistration(body) {
  const sections = [...String(body ?? '').matchAll(/^### npm 包名\s*\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
  if (sections.length !== 1) throw new Error('请使用插件登记模板，只填写一个 npm 包名。');
  const name = sections[0][1].trim().replace(/^`([^`]+)`$/, '$1');
  if (!isPackageName(name)) throw new Error('npm 包名无效；请填写完整包名，例如 @scope/luckylillia-plugin-example，不要填写 URL 或版本号。');
  return name;
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

export async function prepareRegistration(name, catalog, { icon, screenshots, resolve = resolvePlugin, review = reviewPackage } = {}) {
  if (catalog.plugins.some(plugin => plugin.name === name)) return { duplicate: true };
  const resolved = await resolve(name);
  if (icon !== undefined && icon !== resolved.plugin.icon) throw new Error('Issue 中的 icon 与所检查 npm 版本的 package.json.llbot.icon 不一致，请填写该版本声明的相同图片路径或地址。');
  const publishedScreenshots = (resolved.plugin.screenshots ?? []).map(item => typeof item === 'string' ? item : item.src);
  if (screenshots !== undefined && !same(screenshots, publishedScreenshots)) throw new Error('Issue 中的 screenshots 与所检查 npm 版本的 package.json.llbot.screenshots 不一致，请按相同顺序每行填写一个图片路径（对象项填写 src），或留空自动读取。');
  const assessment = await review(resolved.manifest);
  if (!assessment.approved) return { ...resolved, assessment, accepted: false };
  return {
    ...resolved, assessment, accepted: true,
    plugins: sortPlugins([...catalog.plugins, resolved.plugin]),
    versions: { ...catalog.versions, [name]: resolved.version },
  };
}

export async function registerIssue({ github = new GitHub(), issue, resolve, review } = {}) {
  if (issue.pull_request || issue.state !== 'open' || !/^### npm 包名\s*$/m.test(issue.body ?? '')) return;
  const marker = '<!-- market-registration -->';
  try {
    const name = parseRegistration(issue.body);
    const icon = parseRegistrationIcon(issue.body);
    const screenshots = parseRegistrationScreenshots(issue.body);
    const base = await github.defaultBranch();
    const catalog = await github.snapshot(base);
    const result = await prepareRegistration(name, catalog, { icon, screenshots, resolve, review });
    await saveReport(`registration-${issue.number}`, { name, version: result.version, assessment: result.assessment, duplicate: result.duplicate });
    if (result.duplicate) {
      await github.comment(issue.number, marker, `包 <code>${literal(name)}</code> 已登记，版本由每小时检查任务维护。`);
      return;
    }
    if (!result.accepted) {
      await github.comment(issue.number, marker, `登记暂缓，尚未写入目录。修复后请发布新版本并编辑此 Issue，或请维护者重新运行登记工作流。\n\n${reportText(result.assessment)}`);
      return;
    }
    const branch = `market/register-issue-${issue.number}`;
    const existing = await github.branch(branch);
    const branchCatalog = existing ? await github.snapshot(branch) : null;
    result.plugin = preserveImageBlanks(result.plugin, branchCatalog?.plugins.find(plugin => plugin.name === name));
    result.plugins = result.plugins.map(plugin => plugin.name === name ? result.plugin : plugin);
    let sha = branchCatalog?.sha;
    if (!branchCatalog || !same(sortPlugins(branchCatalog.plugins), result.plugins) || !same(branchCatalog.versions, result.versions)) {
      sha = await github.commitCatalog(branch, branchCatalog ?? catalog, result.plugins, result.versions, `Register ${name}`, existing?.object.sha ?? catalog.sha);
    }
    const [owner] = github.repository.split('/');
    const pulls = await github.list(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    const body = registrationBody(result, issue.number);
    const pull = pulls[0]
      ? await github.request('PATCH', `/pulls/${pulls[0].number}`, { title: `登记插件：${name}`, body })
      : await github.request('POST', '/pulls', { title: `登记插件：${name}`, head: branch, base, body, maintainer_can_modify: true });
    // GITHUB_TOKEN-generated PRs do not trigger pull_request. Explicitly dispatch trusted validation.
    await github.dispatchValidation(pull.number);
    await github.comment(issue.number, marker, `字段检查已通过，已创建登记 PR：${pull.html_url}。首次版本为 <code>${literal(result.version)}</code>，合并后发布到 npm 目录包。\n\n${reportText(result.assessment)}`);
    return { number: pull.number, sha };
  } catch (error) {
    await saveReport(`registration-${issue.number}`, { error: error.message, retryable: Boolean(error.retryable) });
    await github.comment(issue.number, marker, `登记未完成，请根据下列原因处理后编辑此 Issue，或由维护者重跑工作流。${error.retryable ? '本次是临时服务错误，不代表包或仓库无效。' : ''}\n\n<pre>${literal(error.message)}</pre>`);
    throw error;
  }
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const github = new GitHub();
  const requested = process.env.MARKET_ISSUE_NUMBER || event.inputs?.issue_number;
  if (requested && !/^[1-9]\d*$/.test(requested)) throw new Error('Issue 编号无效');
  const issue = requested ? await github.request('GET', `/issues/${requested}`) : event.issue;
  if (!issue) throw new Error('没有登记 Issue');
  await registerIssue({ github, issue });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
