import assert from 'node:assert/strict';
import test from 'node:test';
import { metadataToPlugin } from '../scripts/catalog.mjs';
import { GitHub, stableKey } from '../scripts/github.mjs';
import { scanEvent } from '../scripts/scan-versions.mjs';

const name = 'lucky-lillia-plugin-blipreview';
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const user = { login: 'author', type: 'User' };
const approved = {
  approved: true, status: 'approved', summary: '权限检查已修复，审查通过。',
  findings: [], diagnostics: { detail: 'diagnostic-only' }, coverage: { inspectedFiles: ['coverage-only.js'] },
};
const issueFor = (packageName = name, version = '1.0.17') => ({
  number: 5, user: bot, state: 'open',
  title: `插件更新暂缓：${packageName}${version ? `@${version}` : ''}`,
  body: `<!-- market-review:${stableKey(`${packageName}@${version ?? 'metadata'}`)} -->\n旧审查摘要`,
});
const commentEvent = issue => ({ action: 'created', issue: structuredClone(issue), comment: { user, body: '已发布修复版本，请重新检查' } });
const resolvedAt = (version, packageName = name) => {
  const manifest = {
    name: packageName, version, description: '评论触发版本更新', author: { name: 'Test' },
    repository: 'https://github.com/author/example', llbot: { title: '测试插件', category: 'tool' },
  };
  return { manifest, version, plugin: metadataToPlugin(manifest) };
};

function fixture(initial = {}) {
  const other = resolvedAt('1.0.0', '@author/other').plugin;
  const state = {
    issue: issueFor(), version: '1.0.18', assessment: approved,
    catalog: [{ ...resolvedAt('1.0.16').plugin, category: 'chat', icon: '', screenshots: [] }, other], ...initial,
  };
  const requests = [], snapshots = [], resolves = [], reviews = [], commits = [], comments = [], reports = [], issueReports = [], logs = [];
  const github = new GitHub({ repository: 'example/market', token: 'test-only-token' });
  github.defaultBranch = async () => 'main';
  github.snapshot = async branch => {
    snapshots.push(branch);
    return { sha: 'snapshot', tree: 'tree', plugins: structuredClone(state.catalog) };
  };
  github.commitCatalog = async (branch, snapshot, plugins) => {
    assert.equal(branch, 'main');
    assert.deepEqual(snapshot.plugins, state.catalog);
    state.catalog = structuredClone(plugins);
    commits.push(state.catalog);
    return 'updated-catalog';
  };
  github.reportIssue = async (key, title, body) => {
    issueReports.push({ key, title, body });
    return { number: 5, html_url: 'https://github.com/example/market/issues/5' };
  };
  github.request = async (method, path, body) => {
    requests.push({ method, path, body });
    if (method === 'GET' && path === '/issues/5') return structuredClone(state.issue);
    if (method === 'POST' && path === '/issues/5/comments') {
      const comment = { user: bot, ...body };
      comments.push(comment);
      return comment;
    }
    assert.fail(`意外的 GitHub 请求：${method} ${path}`);
  };
  const run = ({ event = commentEvent(state.issue), env = {}, ...options } = {}) => scanEvent({
    github, event,
    env: { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_REPOSITORY: github.repository, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', ...env },
    resolve: async packageName => {
      resolves.push(packageName);
      if (state.resolveError) throw state.resolveError;
      return resolvedAt(state.version, packageName);
    },
    review: async manifest => {
      reviews.push(manifest);
      if (state.concurrentCatalog) state.catalog = structuredClone(state.concurrentCatalog);
      return state.assessment;
    },
    save: async (file, report) => reports.push({ file, ...report }),
    log: message => logs.push(message), ...options,
  });
  return { state, github, run, requests, snapshots, resolves, reviews, commits, comments, reports, issueReports, logs };
}

test('旧暂缓 Issue 的用户评论只检查对应插件的最新包，通过后更新目录并回复摘要', async () => {
  const f = fixture();
  // The deployed legacy marker used by Issue #5 must keep working after the format change.
  f.state.issue.body = '<!-- market-review:5b1ed2b1ae510d07c162a5b4 -->\r\n<pre>旧 JSON 报告</pre>';
  const other = structuredClone(f.state.catalog[1]);
  const published = resolvedAt('1.0.18');
  let resolutions = 0;
  const result = await f.run({ resolve: async packageName => {
    assert.equal(packageName, name);
    resolutions++;
    return resolutions === 1 ? published : resolvedAt('9.0.0');
  } });
  assert.equal(resolutions, 1);
  assert.equal(f.reviews[0], published.manifest);
  assert.equal(result.changed, true);
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.state.catalog, [{ ...published.plugin, category: 'chat', icon: '', screenshots: [] }, other]);
  assert.equal(f.issueReports.length, 0);
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, /1\.0\.18.*已更新市场目录/);
  assert.match(f.comments[0].body, /权限检查已修复/);
  assert.ok(f.comments[0].body.includes('https://github.com/example/market/actions/runs/100/attempts/1'));
  assert.doesNotMatch(f.comments[0].body, /diagnostic-only|coverage-only|"findings"|"approved"/);
  assert.equal(f.reports[0].file, 'versions');
  assert.equal(f.reports[0].plugins, 1);
  assert.equal(f.reports[0].issue, 5);
  assert.deepEqual(f.reports[0].reports[0].assessment, approved);
});

for (const status of ['blocked', 'error']) {
  test(`${status} 结果保留旧版本，完整数据只写报告，评论可重试同一待审版本`, async () => {
    const assessment = {
      ...approved, approved: false, status, summary: '请修复权限检查。',
      findings: [{ severity: 'high', file: 'private.js', reason: 'finding-only' }],
    };
    const f = fixture({ version: '1.0.17', assessment });
    const before = structuredClone(f.state.catalog);
    assert.equal((await f.run()).changed, false);
    assert.deepEqual(f.state.catalog, before);
    assert.equal(f.commits.length, 0);
    assert.equal(f.issueReports[0].key, `${name}@1.0.17`);
    for (const body of [f.issueReports[0].body, f.comments[0].body]) {
      assert.match(body, /请修复权限检查/);
      assert.match(body, /1\.0\.17/);
      assert.ok(body.includes('actions/runs/100/attempts/1'));
      assert.doesNotMatch(body, /finding-only|diagnostic-only|coverage-only|<pre>|"summary"/);
    }
    assert.deepEqual(f.reports[0].reports[0].assessment, assessment);
    const previousComment = structuredClone(f.comments[0]);
    f.state.assessment = approved;
    await f.run({ env: { GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '2' } });
    assert.equal(f.reviews.length, 2);
    assert.equal(f.state.catalog[0].version, '1.0.17');
    assert.equal(f.comments.length, 2);
    assert.deepEqual(f.comments[0], previousComment);
    assert.ok(f.comments[1].body.includes('actions/runs/101/attempts/2'));
    const event = commentEvent(f.state.issue);
    event.comment = f.comments[1];
    await f.run({ event });
    assert.equal(f.reviews.length, 2);
    assert.equal(f.comments.length, 2);
  });
}

test('npm latest 已入库时不调用 AI，并给评论者返回跳过原因和运行链接', async () => {
  const f = fixture({ version: '1.0.16' });
  const result = await f.run();
  assert.equal(result.reason, 'up_to_date');
  assert.deepEqual(f.resolves, [name]);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.commits.length, 0);
  assert.equal(f.issueReports.length, 0);
  assert.equal(f.reports[0].reason, 'up_to_date');
  assert.match(f.comments[0].body, /无需更新/);
  assert.ok(f.comments[0].body.includes('actions/runs/100/attempts/1'));
});

test('已经移出目录的插件不会被评论重新登记或触发 npm 和 AI 请求', async () => {
  const f = fixture({ catalog: [] });
  const result = await f.run();
  assert.equal(result.reason, 'not_registered');
  assert.equal(f.resolves.length, 0);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.commits.length, 0);
  assert.equal(f.reports[0].reason, 'not_registered');
  assert.match(f.comments[0].body, /已不在市场目录/);
});

test('元数据错误产生的无版本 Issue 和 scoped 包名也支持评论重试', async () => {
  for (const packageName of [name, '@author/scoped-plugin']) {
    for (const version of [undefined, '1.0.17-beta.1+build.7']) {
      const issue = issueFor(packageName, version ?? null);
      const f = fixture({ issue, catalog: [resolvedAt('1.0.16', packageName).plugin] });
      await f.run();
      assert.deepEqual(f.resolves, [packageName]);
      assert.equal(f.reviews.length, 1);
      assert.equal(f.commits[0][0].name, packageName);
    }
  }
});

test('npm 读取失败仍保存错误并回复摘要，不改动目录', async () => {
  const f = fixture({ resolveError: new Error('npm 暂时不可用') });
  await f.run();
  assert.equal(f.reviews.length, 0);
  assert.equal(f.commits.length, 0);
  assert.equal(f.reports[0].reports[0].assessment.status, 'error');
  assert.equal(f.issueReports[0].key, `${name}@metadata`);
  assert.match(f.comments[0].body, /npm 暂时不可用/);
});

test('忽略 Bot、PR、关闭或伪造的暂缓 Issue，以及非新增评论事件', async () => {
  for (const change of [
    event => { event.comment.user = bot; },
    event => { event.comment.user = { login: 'other[bot]', type: 'Bot' }; },
    event => { delete event.comment; },
    event => { delete event.issue; },
    event => { event.issue.pull_request = {}; },
    event => { event.issue.state = 'closed'; },
    event => { event.issue.user = user; },
    event => { event.issue.user = { ...bot, login: 'other[bot]' }; },
    event => { event.issue.user = { ...bot, type: 'User' }; },
    event => { event.issue.title = '普通问题'; },
    event => { event.issue.title = 123; },
    event => { event.issue.title = `插件更新暂缓：${name}@latest`; },
    event => { event.issue.title = '插件更新暂缓：../invalid@1.0.17'; },
    event => { event.issue.title = '插件更新暂缓：@other/package@1.0.17'; },
    event => { event.issue.body = '普通问题反馈'; },
    event => { event.issue.body = `引用旧结果：\n${event.issue.body}`; },
    event => { event.issue.body = event.issue.body.replace('market-review:', 'market-registration:'); },
    event => { event.issue.number = 0; },
    event => { event.issue.number = '5'; },
    event => { event.action = 'edited'; },
    event => { event.action = 'deleted'; },
  ]) {
    const f = fixture();
    const event = commentEvent(f.state.issue);
    change(event);
    assert.equal(await f.run({ event }), undefined);
    for (const calls of [f.requests, f.snapshots, f.resolves, f.reviews, f.commits, f.comments, f.reports, f.issueReports]) assert.equal(calls.length, 0);
  }
});

test('排队后重新读取 Issue，已关闭或标记已变时不再检查', async () => {
  for (const change of [
    issue => { issue.state = 'closed'; },
    issue => { issue.body = '此问题已撤销'; },
    issue => { issue.title = '普通问题'; },
  ]) {
    const f = fixture();
    const event = commentEvent(f.state.issue);
    change(f.state.issue);
    assert.equal(await f.run({ event }), undefined);
    assert.deepEqual(f.requests, [{ method: 'GET', path: '/issues/5', body: undefined }]);
    for (const calls of [f.snapshots, f.resolves, f.reviews, f.commits, f.comments, f.reports]) assert.equal(calls.length, 0);
  }
});

test('审查期间目录被删除或修改时不覆盖变更，回复不会声称更新成功', async () => {
  for (const concurrentCatalog of [[], [{ ...resolvedAt('1.0.16').plugin, title: '维护者修改的名称' }]]) {
    const f = fixture({ concurrentCatalog });
    const result = await f.run();
    assert.equal(result.changed, false);
    assert.equal(f.reviews.length, 1);
    assert.equal(f.commits.length, 0);
    assert.deepEqual(f.state.catalog, concurrentCatalog);
    assert.match(f.comments[0].body, /本次未写入更新/);
    assert.doesNotMatch(f.comments[0].body, /已更新市场目录/);
  }
});

test('定时和手动扫描继续检查完整目录，不向单个 Issue 发送重试评论', async () => {
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const f = fixture();
    const result = await f.run({ env: { GITHUB_EVENT_NAME: eventName } });
    assert.equal(result.changed, true);
    assert.deepEqual(f.resolves, [name, '@author/other']);
    assert.equal(f.reviews.length, 2);
    assert.equal(f.commits.length, 1);
    assert.equal(f.comments.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.reports[0].plugins, 2);
    assert.equal(f.reports[0].issue, undefined);
  }
});
