import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHub } from '../scripts/github.mjs';
import { registerIssue } from '../scripts/register-issue.mjs';

test('Issue 编辑及工作流重试各新增评论，保留历史结果并链接到对应运行', async () => {
  const previous = { id: 1, body: '<!-- market-registration -->\n旧检查结果', user: { type: 'Bot' } };
  const comments = [structuredClone(previous)];
  const requests = [];
  const reports = [];
  const github = new GitHub({
    repository: 'example/market', token: 'test-only-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      assert.equal(options.method, 'POST');
      assert.equal(url, 'https://api.github.com/repos/example/market/issues/1/comments');
      const comment = { id: comments.length + 1, ...JSON.parse(options.body) };
      comments.push(comment);
      return Response.json(comment);
    },
  });
  github.defaultBranch = async () => 'main';
  github.snapshot = async () => ({ plugins: [] });
  const issue = { number: 1, state: 'open', body: '### npm 包名\n\nluckylillia-plugin-test\n' };
  const resolve = async name => ({ plugin: { name, version: '1.0.0' }, manifest: { name, version: '1.0.0' }, version: '1.0.0' });
  for (const [run, attempt] of [['100', '1'], ['101', '1'], ['101', '2']]) {
    await registerIssue({
      github, issue, resolve,
      review: async () => ({ approved: false, status: 'error', summary: `运行 ${run} 第 ${attempt} 次检查未完成` }),
      env: { GITHUB_REPOSITORY: github.repository, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt },
      save: async (name, report) => reports.push({ name, report }),
    });
    assert.ok(comments.at(-1).body.includes(`https://github.com/example/market/actions/runs/${run}/attempts/${attempt}`));
  }
  assert.equal(requests.length, 3);
  assert.equal(reports.length, 3);
  assert.equal(comments.length, 4);
  assert.deepEqual(comments[0], previous);
  assert.match(comments[1].body, /运行 100 第 1 次/);
  assert.match(comments[2].body, /运行 101 第 1 次/);
  assert.match(comments[3].body, /运行 101 第 2 次/);
});
