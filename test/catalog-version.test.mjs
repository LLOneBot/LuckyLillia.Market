import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MarketError, matchesPublishedPlugin, metadataToPlugin, readCatalog, resolvePlugin, validateCatalog, writeCatalog } from '../scripts/catalog.mjs';
import { GitHub } from '../scripts/github.mjs';
import { registerIssue } from '../scripts/register-issue.mjs';
import { applyUpdates, scanCatalog } from '../scripts/scan-versions.mjs';
import { validateChanges } from '../scripts/validate-pr.mjs';
import { catalogHash, prepareRelease, releasePlan } from '../scripts/prepare-release.mjs';

const plugin = {
  name: '@author/example', version: '1.2.3', category: 'other', title: '示例插件', description: '目录中的简介',
  author: { name: '示例作者' }, repository: 'https://github.com/author/example',
};
const metadata = (version = plugin.version) => ({
  name: plugin.name, version, description: plugin.description, author: plugin.author,
  repository: `git+${plugin.repository}.git`, llbot: { title: plugin.title },
  dist: { tarball: `https://registry.npmjs.org/@author/example/-/example-${version}.tgz` },
});
const approved = { approved: true, status: 'approved', summary: '审查通过' };

async function directory(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'luckylillia-market-test-'));
  t.after(async () => {
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('npm 元数据保留精确版本，版本不一致的条目不能通过发布信息比对', () => {
  assert.deepEqual(metadataToPlugin(metadata()), plugin);
  assert.equal(matchesPublishedPlugin(plugin, { ...plugin, version: '2.0.0' }), false);
});

test('目录和公开 schema 都要求条目包含精确 SemVer 版本', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/plugins.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.items.required.includes('version'));
  const pattern = new RegExp(schema.items.properties.version.pattern);
  for (const version of [undefined, null, 1, {}, 'latest', '^1.0.0', '1.0', 'v1.0.0', '01.0.0', '1.0.0-01', '1.0.0\n']) {
    assert.throws(() => validateCatalog([{ ...plugin, version }]), { code: 'INVALID_VERSION' });
    if (typeof version === 'string') assert.equal(pattern.test(version), false, version);
  }
  for (const version of ['0.0.0', '1.2.3', '1.2.3-beta.1+build.7']) {
    validateCatalog([{ ...plugin, version }]);
    assert.equal(pattern.test(version), true, version);
  }
  validateCatalog([]);
});

test('目录读写只依赖 plugins.json，旧版本表不能补齐缺失的条目版本', async t => {
  const root = await directory(t);
  const another = { ...plugin, name: '@author/another', version: '2.0.0' };
  await writeCatalog(root, [plugin, another]);
  assert.deepEqual(await readdir(root), ['plugins.json']);
  assert.deepEqual(await readCatalog(root), { plugins: [another, plugin] });
  await writeFile(join(root, 'versions.json'), '{');
  assert.deepEqual(await readCatalog(root), { plugins: [another, plugin] });
  await writeFile(join(root, 'plugins.json'), JSON.stringify([{ ...plugin, version: undefined }]));
  await writeFile(join(root, 'versions.json'), JSON.stringify({ [plugin.name]: plugin.version }));
  await assert.rejects(readCatalog(root), { code: 'INVALID_VERSION' });
});

test('PR 仅变更条目版本也会审查，并锁定该版本而不是 npm latest', async () => {
  let reviews = 0;
  const fetchImpl = async url => {
    if (url === `https://registry.npmjs.org/${encodeURIComponent(plugin.name)}`) {
      return Response.json({
        name: plugin.name, 'dist-tags': { latest: '9.0.0' },
        versions: { [plugin.version]: metadata(), '9.0.0': metadata('9.0.0') },
      });
    }
    assert.equal(url, 'https://api.github.com/repos/author/example');
    return Response.json({ private: false, full_name: 'author/example' });
  };
  const result = await validateChanges(
    { plugins: [{ ...plugin, version: '1.0.0' }] }, { plugins: [plugin] }, {
      resolve: (name, options) => resolvePlugin(name, { ...options, fetchImpl }),
      review: async manifest => {
        assert.equal(manifest.version, plugin.version);
        reviews++;
        return approved;
      },
    },
  );
  assert.equal(reviews, 1);
  assert.deepEqual(result, { approved: true, reports: [{ name: plugin.name, version: plugin.version, assessment: approved }] });
});

test('未变化的目录条目不重复解析或审查', async () => {
  const unexpected = async () => assert.fail('不应请求 npm 或 AI');
  const catalog = { plugins: [plugin] };
  assert.deepEqual(await validateChanges(catalog, structuredClone(catalog), { resolve: unexpected, review: unexpected }), { approved: true, reports: [] });
  assert.deepEqual(await scanCatalog(catalog, {
    resolve: async () => ({ plugin, version: plugin.version, manifest: metadata() }), review: unexpected,
  }), { updates: [], reports: [] });
});

test('通过审查后同时更新版本和元数据，并保留隐藏图片的设置', async () => {
  const current = { plugins: [{ ...plugin, icon: '', screenshots: [] }] };
  const published = { ...plugin, version: '1.3.0', title: '新版插件', icon: 'assets/icon.png', screenshots: ['assets/preview.png'] };
  const result = await scanCatalog(current, {
    resolve: async () => ({ plugin: published, version: published.version, manifest: metadata(published.version) }),
    review: async () => approved,
  });
  assert.equal(result.reports[0].previous, plugin.version);
  assert.deepEqual(applyUpdates(current, result.updates), {
    changed: true, plugins: [{ ...published, icon: '', screenshots: [] }],
  });
  assert.deepEqual(current, { plugins: [{ ...plugin, icon: '', screenshots: [] }] });
  for (const concurrent of [
    { plugins: [] },
    { plugins: [{ ...current.plugins[0], version: '1.4.0' }] },
    { plugins: [{ ...current.plugins[0], title: '维护者修改' }] },
  ]) {
    assert.deepEqual(applyUpdates(concurrent, result.updates), { ...concurrent, changed: false });
  }
});

test('登记流程从 GitHub 单文件快照创建包含版本的目录提交', async () => {
  const sha = 'a'.repeat(40);
  const registered = { ...plugin, name: '@author/registered' };
  const requests = [];
  const github = new GitHub({ repository: 'example/market', token: 'test-only-token' });
  github.request = async (method, path, body) => {
    requests.push({ method, path, body });
    if (method === 'GET') {
      if (path === '') return { default_branch: 'main' };
      if (path === '/git/ref/heads/main') return { object: { sha } };
      if (path === `/git/commits/${sha}`) return { tree: { sha: 'base-tree' } };
      if (path === `/contents/plugins.json?ref=${sha}`) {
        const content = JSON.stringify([registered]);
        return { type: 'file', encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
      }
      if (path === '/git/ref/heads/market%2Fregister-issue-42') throw new MarketError('分支不存在', { code: 'HTTP_404' });
      if (path.startsWith('/pulls?')) return [];
    } else if (method === 'POST') {
      if (path === '/git/trees') return { sha: 'new-tree' };
      if (path === '/git/commits') return { sha: 'new-commit' };
      if (path === '/git/refs') return {};
      if (path === '/pulls') return { number: 7, html_url: 'https://github.com/example/market/pull/7' };
      if (path === '/actions/workflows/validate-catalog.yml/dispatches') return;
      if (path === '/issues/42/comments') return { id: 1 };
    }
    assert.fail(`意外的 GitHub 请求：${method} ${path}`);
  };
  const result = await registerIssue({
    github, issue: { number: 42, state: 'open', body: `### npm 包名\n\n${plugin.name}\n` },
    resolve: async () => ({ plugin, version: plugin.version, manifest: metadata() }),
    review: async () => approved, env: {}, save: async () => {},
  });
  assert.deepEqual(result, { number: 7, sha: 'new-commit' });
  const tree = requests.find(request => request.path === '/git/trees').body;
  assert.equal(tree.base_tree, 'base-tree');
  assert.deepEqual(tree.tree.map(file => file.path), ['plugins.json']);
  assert.deepEqual(JSON.parse(tree.tree[0].content), [plugin, registered]);
  assert.deepEqual(requests.find(request => request.path === '/git/commits').body, {
    message: `Register ${plugin.name}`, tree: 'new-tree', parents: [sha],
  });
});

test('目录哈希包含条目版本，但不受条目和对象字段顺序影响', () => {
  const plugins = [plugin, { ...plugin, name: '@author/another' }];
  const reordered = [...plugins].reverse().map(entry => Object.fromEntries(Object.entries(entry).reverse()));
  assert.equal(catalogHash(plugins), catalogHash(reordered));
  assert.notEqual(catalogHash(plugins), catalogHash([{ ...plugin, version: '1.3.0' }, plugins[1]]));
  const catalog = { plugins };
  const pkg = { version: '0.1.0' };
  const latest = { version: '0.1.1', market: { catalogHash: catalogHash(plugins) } };
  assert.equal(releasePlan(pkg, catalog, latest).publish, false);
  assert.equal(releasePlan(pkg, { plugins: [{ ...plugin, version: '1.3.0' }, plugins[1]] }, latest).version, '0.1.2');
});

test('首次合并发布升级目录包版本并标记 schemaVersion 2', async t => {
  t.mock.method(console, 'log', () => {});
  const root = await directory(t);
  await writeCatalog(root, [plugin]);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@luckylillia/market', version: '0.1.0' }));
  const plan = await prepareRelease({ root, fetchImpl: async url => {
    assert.equal(url, 'https://registry.npmjs.org/%40luckylillia%2Fmarket/latest');
    return Response.json({ version: '0.1.0' });
  } });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(plan.publish, true);
  assert.equal(pkg.version, '0.1.1');
  assert.deepEqual(pkg.market, { schemaVersion: 2, catalogHash: catalogHash([plugin]) });
  assert.deepEqual((await readdir(root)).sort(), ['package.json', 'plugins.json']);
});
