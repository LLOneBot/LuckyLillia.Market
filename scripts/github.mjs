import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fetchJson, validateCatalog } from './catalog.mjs';

export const pretty = value => JSON.stringify(value, null, 2) + '\n';
export const stableKey = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const same = isDeepStrictEqual;
export const sortPlugins = plugins => [...plugins].sort((a, b) => a.name.localeCompare(b.name, 'en'));
// All text originating from packages or models is rendered literally, without mentions.
export const literal = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;');
export function reportText(report) {
  const text = pretty(report);
  const excerpt = text.length > 8000 ? `${text.slice(0, 8000)}\n…完整记录见该次工作流的审查 artifact。` : text;
  return `<pre>${literal(excerpt)}</pre>`;
}

export async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export async function saveReport(name, data) {
  await mkdir('reports', { recursive: true });
  await writeFile(`reports/${name}.json`, pretty(data));
}

export class GitHub {
  constructor({ repository = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch } = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('缺少有效的 GITHUB_REPOSITORY');
    if (!token) throw new Error('缺少 GITHUB_TOKEN');
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, body) {
    if ((path !== '' && !path.startsWith('/')) || path.startsWith('//')) throw new Error('GitHub API 路径无效');
    return fetchJson(`https://api.github.com/repos/${this.repository}${path}`, {
      fetchImpl: this.fetchImpl, method,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async optional(path) {
    try { return await this.request('GET', path); }
    catch (error) { if (error.code === 'HTTP_404' || error.status === 404) return null; throw error; }
  }

  async list(path) {
    const entries = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      entries.push(...batch);
      if (batch.length < 100) return entries;
    }
    throw new Error('GitHub 列表超过自动处理上限');
  }

  async defaultBranch() { return (await this.request('GET', '')).default_branch; }

  async branch(name) { return this.optional(`/git/ref/heads/${encodeURIComponent(name)}`); }

  async file(path, ref) {
    const data = await this.request('GET', `/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (data.type !== 'file' || data.encoding !== 'base64' || data.size > 4 * 1024 * 1024) throw new Error(`${path} 不是大小合适的 JSON 文件`);
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  }

  async snapshot(branch) {
    const ref = await this.branch(branch);
    if (!ref) throw new Error(`找不到分支 ${branch}`);
    const sha = ref.object.sha;
    const [commit, plugins, versions] = await Promise.all([
      this.request('GET', `/git/commits/${sha}`), this.file('plugins.json', sha), this.file('versions.json', sha),
    ]);
    validateCatalog(plugins, versions);
    return { sha, tree: commit.tree.sha, plugins, versions };
  }

  async commitCatalog(branch, snapshot, plugins, versions, message, parent = snapshot.sha) {
    validateCatalog(plugins, versions);
    const files = {
      'plugins.json': sortPlugins(plugins),
      'versions.json': Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    };
    const tree = await this.request('POST', '/git/trees', {
      base_tree: snapshot.tree,
      tree: Object.entries(files).map(([path, value]) => ({ path, mode: '100644', type: 'blob', content: pretty(value) })),
    });
    const commit = await this.request('POST', '/git/commits', { message, tree: tree.sha, parents: [parent] });
    const ref = await this.branch(branch);
    if (ref) await this.request('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
    else await this.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
    return commit.sha;
  }

  async comment(issue, marker, body) {
    const comments = await this.list(`/issues/${issue}/comments`);
    const existing = comments.find(comment => comment.user?.type === 'Bot' && comment.body?.startsWith(marker));
    const fullBody = `${marker}\n${body}`;
    if (existing?.body === fullBody) return existing;
    return existing
      ? this.request('PATCH', `/issues/comments/${existing.id}`, { body: fullBody })
      : this.request('POST', `/issues/${issue}/comments`, { body: fullBody });
  }

  async reportIssue(key, title, body) {
    const marker = `<!-- market-review:${stableKey(key)} -->`;
    const issues = await this.list('/issues?state=all&creator=github-actions%5Bbot%5D');
    const existing = issues.find(issue => !issue.pull_request && issue.body?.startsWith(marker));
    const fullBody = `${marker}\n${body}`;
    if (existing) {
      if (existing.body !== fullBody) await this.request('PATCH', `/issues/${existing.number}`, { body: fullBody });
      return existing;
    }
    return this.request('POST', '/issues', { title, body: fullBody });
  }

  async dispatchValidation(prNumber) {
    await this.request('POST', '/actions/workflows/validate-catalog.yml/dispatches', {
      ref: await this.defaultBranch(), inputs: { pr_number: String(prNumber) },
    });
  }
}
