import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { metadataToPlugin, PLUGIN_CATEGORIES, validateCatalog } from '../scripts/catalog.mjs';
import { parseRegistrationCategory, prepareRegistration, registerIssue } from '../scripts/register-issue.mjs';
import { applyUpdates, scanCatalog } from '../scripts/scan-versions.mjs';
import { validateChanges } from '../scripts/validate-pr.mjs';

const categories = [
  ['protocol', '协议端'], ['adapter', '适配器'], ['chat', '消息互动'],
  ['tool', '工具'], ['service', '依赖组件'], ['other', '其他'],
];
const manifest = {
  name: '@author/category-example', version: '1.0.0', description: '分类登记测试',
  author: { name: 'Test' }, repository: 'https://github.com/author/category-example',
  llbot: { title: '分类示例', category: 'service' },
};
const published = metadataToPlugin(manifest);
const resolve = async () => ({ plugin: structuredClone(published), manifest, version: manifest.version });
const approved = { approved: true, status: 'approved', summary: '审查通过' };
const review = async () => approved;
const body = value => `### npm 包名\n\n${manifest.name}\n\n### 插件分类\n\n${value}\n\n### icon\n\n_No response_\n`;

test('注册分类沿用 Bot 的六个值，支持下拉选项、中文名和原始值', async () => {
  assert.deepEqual(Object.entries(PLUGIN_CATEGORIES), categories);
  const schema = JSON.parse(await readFile(new URL('../schemas/plugins.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.items.properties.category.enum, categories.map(([key]) => key));
  for (const [key, label] of categories) {
    for (const value of [key, label, `${label} (${key})`]) {
      assert.equal(parseRegistrationCategory(body(value)), key);
      assert.equal(parseRegistrationCategory(body(value).replaceAll('\n', '\r\n')), key);
    }
  }
});

test('旧 Issue 没有分类栏时允许回退，空白、伪造、多个和重复分类均拒绝', () => {
  assert.equal(parseRegistrationCategory(`### npm 包名\n\n${manifest.name}\n`), undefined);
  for (const value of ['', '_No response_', 'unknown', 'Service', '工具 (service)', 'tool, chat', 'tool\nchat', 'constructor']) {
    assert.throws(() => parseRegistrationCategory(body(value)), /有效的插件分类/);
  }
  assert.throws(() => parseRegistrationCategory(body('tool') + '\n### 插件分类\n\nchat'), /只选择一个/);
});

test('目录允许旧条目省略分类，但只接受 Bot 支持的分类值', () => {
  const { category, ...legacy } = published;
  validateCatalog([legacy]);
  for (const [category] of categories) validateCatalog([{ ...published, category }]);
  for (const category of [undefined, null, '', 'other ', 'invalid', 1, {}, []]) {
    assert.throws(() => validateCatalog([{ ...published, category }]), { code: 'INVALID_CATEGORY' });
  }
});

test('登记采用选择的分类，审查仍使用原始 npm 清单且不会改写发布信息', async () => {
  const result = await prepareRegistration(manifest.name, { plugins: [] }, {
    category: 'chat', resolve,
    review: async checked => { assert.equal(checked, manifest); return approved; },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.plugin.category, 'chat');
  assert.deepEqual(result.plugins, [{ ...published, category: 'chat' }]);
  assert.equal(published.category, 'service');
  assert.equal(manifest.llbot.category, 'service');
  await assert.rejects(prepareRegistration(manifest.name, { plugins: [] }, {
    category: 'invalid', resolve: async () => assert.fail('无效分类不应请求 npm'), review,
  }), /有效的插件分类/);
});

test('未选择分类时沿用 npm 声明，未声明或未知的分类归为其他', async () => {
  assert.equal((await prepareRegistration(manifest.name, { plugins: [] }, { resolve, review })).plugin.category, 'service');
  for (const category of [undefined, null, 'unknown', 'Service', [], {}]) {
    const plugin = metadataToPlugin({ ...manifest, llbot: { ...manifest.llbot, category } });
    assert.equal(plugin.category, 'other');
    assert.equal((await prepareRegistration(manifest.name, { plugins: [] }, {
      resolve: async () => ({ plugin, manifest, version: manifest.version }), review,
    })).plugin.category, 'other');
  }
});

test('分类可由目录选择，其他 npm 字段仍需一致且分类变更仍接受 AI 审查', async () => {
  let reviews = 0;
  const proposed = { ...published, category: 'tool' };
  const result = await validateChanges({ plugins: [published] }, { plugins: [proposed] }, {
    resolve, review: async () => { reviews++; return approved; },
  });
  assert.equal(result.approved, true);
  assert.equal(reviews, 1);
  await assert.rejects(validateChanges({ plugins: [] }, { plugins: [{ ...proposed, title: '伪造标题' }] }, {
    resolve, review: async () => assert.fail('发布信息不匹配时不应调用 AI'),
  }), /与 npm 发布信息不一致/);
  const blocked = await validateChanges({ plugins: [published] }, { plugins: [proposed] }, {
    resolve, review: async () => ({ approved: false }),
  });
  assert.equal(blocked.approved, false);
});

test('新版本保留市场分类，扫描期间的分类修改不会被覆盖', async () => {
  const current = { plugins: [{ ...published, category: 'tool' }] };
  const nextManifest = { ...manifest, version: '1.1.0', llbot: { title: '新版标题', category: 'adapter' } };
  const { updates } = await scanCatalog(current, {
    resolve: async () => ({ plugin: metadataToPlugin(nextManifest), manifest: nextManifest, version: nextManifest.version }), review,
  });
  const updated = applyUpdates(current, updates);
  assert.equal(updated.changed, true);
  assert.deepEqual(updated.plugins, [{ ...metadataToPlugin(nextManifest), category: 'tool' }]);
  assert.deepEqual(current, { plugins: [{ ...published, category: 'tool' }] });
  const concurrent = { plugins: [{ ...published, category: 'chat' }] };
  assert.deepEqual(applyUpdates(concurrent, updates), { ...concurrent, changed: false });
});

test('编辑 Issue 可修改登记 PR 的分类，旧 Issue 重跑保留已有目录分类', async () => {
  let plugins;
  const commits = [];
  const descriptions = [];
  const pull = { number: 7, html_url: 'https://github.com/example/market/pull/7' };
  const github = {
    repository: 'example/market', defaultBranch: async () => 'main',
    snapshot: async branch => ({ sha: branch, tree: 'tree', plugins: branch === 'main' ? [] : structuredClone(plugins) }),
    branch: async () => plugins ? { object: { sha: 'previous' } } : null,
    commitCatalog: async (branch, snapshot, next) => { plugins = structuredClone(next); commits.push(plugins); return 'commit'; },
    list: async () => descriptions.length ? [pull] : [],
    request: async (method, path, data) => { descriptions.push(data.body); return pull; },
    dispatchValidation: async () => {}, comment: async () => {},
  };
  for (const choice of ['工具 (tool)', '消息互动 (chat)']) {
    await registerIssue({
      github, issue: { number: 42, state: 'open', body: body(choice) },
      resolve, review, env: {}, save: async () => {},
    });
  }
  assert.deepEqual(commits.map(entries => entries[0].category), ['tool', 'chat']);
  assert.match(descriptions[0], /插件分类.*工具/);
  assert.match(descriptions[1], /插件分类.*消息互动/);
  await registerIssue({
    github, issue: { number: 42, state: 'open', body: `### npm 包名\n\n${manifest.name}\n` },
    resolve, review, env: {}, save: async () => {},
  });
  assert.equal(commits.length, 2);
  assert.equal(plugins[0].category, 'chat');
  assert.match(descriptions[2], /插件分类.*消息互动/);
});
