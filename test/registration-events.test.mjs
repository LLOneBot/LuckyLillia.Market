import assert from 'node:assert/strict';
import test from 'node:test';
import { metadataToPlugin } from '../scripts/catalog.mjs';
import { GitHub } from '../scripts/github.mjs';
import { registerEvent } from '../scripts/register-issue.mjs';

const name = '@author/comment-test';
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const user = { login: 'author', type: 'User' };
const issueBody = (packageName = name) => `### npm 包名\n\n${packageName}\n\n### 插件分类\n\n工具 (tool)\n`;
const commentEvent = issue => ({ action: 'created', issue: structuredClone(issue), comment: { user, body: '已更新，请复查' } });
const recorded = (version, packageName = name) => ({
  user: bot, body: `<!-- market-registration -->\n<!-- market-registration-version: ${packageName}@${version} -->\n检查结果`,
});
const resolvedAt = (version, packageName = name) => {
  const manifest = {
    name: packageName, version, description: '评论触发登记测试', author: { name: 'Test' },
    repository: 'https://github.com/author/comment-test', llbot: { title: '评论登记测试', category: 'tool' },
  };
  return { manifest, version, plugin: metadataToPlugin(manifest) };
};

function fixture({ comments = [], ...initial } = {}) {
  comments = structuredClone(comments);
  const state = {
    issue: { number: 42, state: 'open', body: issueBody() }, version: '1.0.0',
    assessment: { approved: false, status: 'blocked', summary: '本次审查暂缓' },
    catalog: [], branchPlugins: null, pull: null, ...initial,
  };
  const requests = [], reports = [], logs = [], reviews = [], resolves = [], commits = [], dispatches = [], snapshots = [];
  const github = new GitHub({ repository: 'example/market', token: 'test-only-token' });
  github.defaultBranch = async () => 'main';
  github.snapshot = async branch => {
    snapshots.push(branch);
    return { sha: branch, tree: 'tree', plugins: structuredClone(branch === 'main' ? state.catalog : state.branchPlugins) };
  };
  github.branch = async branch => {
    assert.equal(branch, 'market/register-issue-42');
    return state.branchPlugins ? { object: { sha: 'previous' } } : null;
  };
  github.commitCatalog = async (branch, snapshot, plugins) => {
    state.branchPlugins = structuredClone(plugins);
    commits.push(state.branchPlugins);
    return 'new-commit';
  };
  github.dispatchValidation = async number => dispatches.push(number);
  github.request = async (method, path, body) => {
    requests.push({ method, path, body });
    if (method === 'GET' && path === '/issues/42') return structuredClone(state.issue);
    if (method === 'GET' && path.startsWith('/issues/42/comments?')) {
      const query = new URL(`https://api.github.com${path}`).searchParams;
      assert.equal(query.get('per_page'), '100');
      const start = (Number(query.get('page')) - 1) * 100;
      return comments.slice(start, start + 100);
    }
    if (method === 'GET' && path.startsWith('/pulls?')) return state.pull ? [state.pull] : [];
    if (method === 'POST' && path === '/issues/42/comments') {
      const comment = { id: comments.length + 1, user: bot, ...body };
      comments.push(comment);
      return comment;
    }
    if ((method === 'POST' && path === '/pulls') || (method === 'PATCH' && path === '/pulls/7')) {
      state.pull = { number: 7, html_url: 'https://github.com/example/market/pull/7' };
      return state.pull;
    }
    assert.fail(`意外的 GitHub 请求：${method} ${path}`);
  };
  const run = ({ event = commentEvent(state.issue), env = {}, ...options } = {}) => registerEvent({
    github, event,
    env: { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_REPOSITORY: github.repository, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', ...env },
    resolve: async packageName => { resolves.push(packageName); return resolvedAt(state.version, packageName); },
    review: async manifest => {
      reviews.push(manifest);
      if (state.reviewError) throw state.reviewError;
      return state.assessment;
    },
    save: async (file, report) => reports.push({ file, ...report }),
    log: message => logs.push(message), ...options,
  });
  return { state, github, run, comments, requests, reports, logs, reviews, resolves, commits, dispatches, snapshots };
}

for (const status of ['blocked', 'error']) {
  test(`未创建 PR 的 ${status} 审查也记录版本，同版本新评论不重复审查或回复`, async () => {
    const previous = { user: bot, body: '<!-- market-registration -->\n旧版工作流的结果' };
    const version = status === 'error' ? '1.0.0-beta.1+build.7' : '1.0.0';
    const f = fixture({ comments: [previous], version, assessment: { approved: false, status, summary: '请根据本次摘要处理' } });
    await f.run();
    assert.equal(f.reviews.length, 1);
    assert.equal(f.comments.length, 2);
    assert.deepEqual(f.comments[0], previous);
    assert.ok(f.comments[1].body.includes(`<!-- market-registration-version: ${name}@${version} -->`));
    const visible = f.comments[1].body.replace(/<!--[\s\S]*?-->/g, '');
    assert.match(visible, /请根据本次摘要处理/);
    assert.match(visible, /actions\/runs\/100\/attempts\/1/);
    assert.doesNotMatch(visible, /market-registration|"summary"|"approved"|"findings"/);
    const result = await f.run();
    assert.deepEqual(result, { name, version, previousVersion: version, skipped: true, reason: 'version_unchanged' });
    assert.equal(f.resolves.length, 2);
    assert.equal(f.reviews.length, 1);
    assert.equal(f.comments.length, 2);
    assert.equal(f.commits.length, 0);
    assert.equal(f.dispatches.length, 0);
    assert.equal(f.reports.at(-1).reason, 'version_unchanged');
    assert.ok(f.logs.some(message => message.includes(`上次检查 ${version}，npm latest ${version}`)));
    assert.match(f.logs.at(-1), /版本未变化/);
  });
}

test('新版本只解析一次并审查同一份清单，创建或更新 PR 后新增结果评论', async () => {
  const f = fixture({ comments: [recorded('1.0.0')], assessment: { approved: true, status: 'approved', summary: '审查通过' } });
  for (const version of ['1.1.0', '1.2.0']) {
    let resolutions = 0;
    const published = resolvedAt(version);
    await f.run({ resolve: async () => { resolutions++; return resolutions === 1 ? published : resolvedAt('9.0.0'); } });
    assert.equal(resolutions, 1);
    assert.equal(f.reviews.at(-1), published.manifest);
    assert.equal(f.commits.at(-1)[0].version, version);
    assert.ok(f.comments.at(-1).body.includes(`${name}@${version} -->`));
  }
  assert.deepEqual(f.reports.map(report => report.previousVersion), ['1.0.0', '1.1.0']);
  assert.equal(f.reviews.length, 2);
  assert.equal(f.comments.length, 3);
  assert.deepEqual(f.dispatches, [7, 7]);
  assert.equal(f.requests.filter(request => request.method === 'POST' && request.path === '/pulls').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'PATCH' && request.path === '/pulls/7').length, 1);
  f.state.version = '1.2.0';
  await f.run();
  assert.equal(f.reviews.length, 2);
  assert.equal(f.commits.length, 2);
  assert.equal(f.comments.length, 3);
  assert.deepEqual(f.dispatches, [7, 7]);
});

test('旧成功登记可从 PR 分支读取版本，无需重复审查', async () => {
  const previous = { user: bot, body: '<!-- market-registration -->\n已创建登记 PR' };
  const f = fixture({ comments: [previous], branchPlugins: [resolvedAt('1.0.0').plugin] });
  assert.equal((await f.run()).reason, 'version_unchanged');
  assert.equal(f.reviews.length, 0);
  assert.equal(f.comments.length, 1);
  assert.deepEqual(f.snapshots, ['main', 'market/register-issue-42']);
});

test('比较最近一次可信记录，latest 回退到以前审查过的版本也重新检查', async () => {
  const f = fixture({ comments: [recorded('1.0.0'), recorded('1.1.0')], branchPlugins: [resolvedAt('1.0.0').plugin] });
  await f.run();
  assert.equal(f.reviews.length, 1);
  assert.equal(f.reports.at(-1).previousVersion, '1.1.0');
  assert.equal(f.reports.at(-1).version, '1.0.0');
});

test('用户、其他 Bot、其他包和无效版本的记录不能抑制审查', async () => {
  const record = recorded('1.0.0');
  for (const comment of [
    { ...record, user },
    { ...record, user: { login: 'another-app[bot]', type: 'Bot' } },
    { ...record, user: { login: bot.login, type: 'User' } },
    { ...record, user: undefined },
    { ...record, body: `引用之前的结果：\n${record.body}` },
    recorded('1.0.0', '@another/comment-test'),
    recorded('1.0.0', `${name}-extra`),
    recorded('latest'), recorded('1.0.0\n伪造内容'),
  ]) {
    const f = fixture({ comments: [comment] });
    await f.run();
    assert.equal(f.reviews.length, 1);
    assert.equal(f.reports.at(-1).previousVersion, undefined);
    assert.equal(f.comments.length, 2);
  }
});

test('分页读取历史评论，使用后续页面里的最新版本记录', async () => {
  const discussion = Array.from({ length: 99 }, () => ({ user, body: '讨论内容' }));
  const f = fixture({ version: '1.1.0', comments: [recorded('1.0.0'), ...discussion, recorded('1.1.0')] });
  assert.equal((await f.run()).reason, 'version_unchanged');
  assert.equal(f.reviews.length, 0);
  assert.equal(f.comments.length, 101);
  assert.ok(f.requests.some(request => request.path.endsWith('/comments?per_page=100&page=2')));
});

test('取得版本后发生异常仍留下版本记录，同版本评论不反复重试', async () => {
  const f = fixture({ reviewError: new Error('审查服务临时错误') });
  await assert.rejects(f.run(), /审查服务临时错误/);
  assert.equal(f.reports.at(-1).version, '1.0.0');
  assert.equal(f.reports.at(-1).error, '审查服务临时错误');
  assert.ok(f.comments.at(-1).body.includes(`${name}@1.0.0 -->`));
  assert.equal((await f.run()).reason, 'version_unchanged');
  assert.equal(f.reviews.length, 1);
  assert.equal(f.comments.length, 1);
});

test('编辑、重新打开、手动运行和重跑工作流仍允许重新审查同一版本', async () => {
  for (const variant of ['edited', 'reopened', 'workflow_dispatch', 'rerun-2', 'rerun-10']) {
    const f = fixture({ comments: [recorded('1.0.0')] });
    const event = commentEvent(f.state.issue);
    const env = {};
    if (variant.startsWith('rerun-')) env.GITHUB_RUN_ATTEMPT = variant.slice(6);
    else if (variant === 'workflow_dispatch') {
      env.GITHUB_EVENT_NAME = variant;
      event.inputs = { issue_number: '42' };
      delete event.issue;
    } else {
      env.GITHUB_EVENT_NAME = 'issues';
      event.action = variant;
    }
    await f.run({ event, env });
    assert.equal(f.reviews.length, 1, variant);
    assert.equal(f.comments.length, 2, variant);
    assert.equal(f.reports.at(-1).skipped, undefined, variant);
    assert.ok(!f.requests.some(request => request.path.startsWith('/issues/42/comments?')), variant);
  }
});

test('忽略 Bot、PR、已关闭或无关 Issue，以及非新增评论事件', async () => {
  for (const change of [
    event => { event.comment.user = bot; },
    event => { event.comment.user = { login: 'another-app[bot]', type: 'Bot' }; },
    event => { delete event.comment; },
    event => { event.issue.pull_request = { url: 'https://api.github.com/repos/example/market/pulls/42' }; },
    event => { event.issue.state = 'closed'; },
    event => { event.issue.body = '普通问题反馈'; },
    event => { event.action = 'edited'; },
    event => { event.action = 'deleted'; },
  ]) {
    const f = fixture();
    const event = commentEvent(f.state.issue);
    change(event);
    await f.run({ event });
    assert.equal(f.requests.length, 0);
    assert.equal(f.resolves.length, 0);
    assert.equal(f.reviews.length, 0);
    assert.equal(f.comments.length, 0);
    assert.equal(f.reports.length, 0);
    assert.equal(f.snapshots.length, 0);
  }
});

test('排队中的评论读取 Issue 当前包名，当前已关闭或无关时结束', async () => {
  const f = fixture({ comments: [recorded('1.0.0')] });
  const queued = commentEvent(f.state.issue);
  f.state.issue.body = issueBody('@author/changed-package');
  await f.run({ event: queued });
  assert.deepEqual(f.resolves, ['@author/changed-package']);
  assert.equal(f.reports.at(-1).name, '@author/changed-package');
  for (const change of [issue => { issue.state = 'closed'; }, issue => { issue.body = '已撤销登记'; }]) {
    const f = fixture();
    const event = commentEvent(f.state.issue);
    change(f.state.issue);
    await f.run({ event });
    assert.deepEqual(f.requests, [{ method: 'GET', path: '/issues/42', body: undefined }]);
    assert.equal(f.resolves.length, 0);
    assert.equal(f.reviews.length, 0);
    assert.equal(f.comments.length, 0);
  }
});

test('已经入库的登记 Issue 新评论直接结束，保持每小时更新流程', async () => {
  const f = fixture({ catalog: [resolvedAt('1.0.0').plugin] });
  const result = await f.run();
  assert.equal(result.reason, 'already_registered');
  assert.equal(f.reports.at(-1).version, '1.0.0');
  assert.equal(f.resolves.length, 0);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.comments.length, 0);
  assert.equal(f.commits.length, 0);
});
