import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRegistration, parseRegistrationIcon, parseRegistrationScreenshots, prepareRegistration } from '../scripts/register-issue.mjs';

const name = 'luckylillia-plugin-screenshots';
const catalog = { plugins: [], versions: {} };
const issueBody = value => '### npm 包名\n\n' + name + '\n\n### icon\n\nassets/icon.png\n\n### screenshots\n\n' + value + '\n';
const published = {
  name, title: '截图示例', description: '登记截图测试',
  author: { name: 'Test' }, repository: 'https://github.com/example/screenshots',
  icon: 'assets/icon.png',
  screenshots: ['assets/preview.png', { src: './assets/设置 页面.webp', caption: '设置页面' }],
};
const manifest = { name, version: '1.0.0', llbot: { screenshots: published.screenshots } };
const resolve = async () => ({ plugin: structuredClone(published), manifest, version: manifest.version });
const review = async () => ({ approved: true });

test('多行截图保留顺序、中文、空格和相对路径前缀，兼容 CRLF', () => {
  const body = issueBody('assets/preview.png\n\n\u0060./assets/设置 页面.webp\u0060').replaceAll('\n', '\r\n');
  assert.equal(parseRegistration(body), name);
  assert.equal(parseRegistrationIcon(body), 'assets/icon.png');
  assert.deepEqual(parseRegistrationScreenshots(body), ['assets/preview.png', './assets/设置 页面.webp']);
});

test('旧 Issue 和未填写截图的表单仍使用 npm 声明', async () => {
  for (const body of [undefined, '### npm 包名\n\n' + name, issueBody(''), issueBody('  \n '), issueBody('_No response_')]) {
    const screenshots = parseRegistrationScreenshots(body);
    assert.equal(screenshots, undefined);
    const result = await prepareRegistration(name, catalog, { screenshots, resolve, review });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.plugin.screenshots, published.screenshots);
  }
});

test('重复截图栏不能覆盖前一个输入', () => {
  assert.throws(() => parseRegistrationScreenshots(issueBody('assets/preview.png') + '\n### screenshots\n\nassets/other.png'), /只填写一个 screenshots/);
});

test('拒绝越界路径、URL、绝对路径和非图片输入', () => {
  for (const value of [
    '../preview.png', 'assets/../preview.png', '/assets/preview.png',
    'C:/images/preview.png', 'assets\\preview.png', 'https://example.com/preview.png',
    '![截图](https://example.com/preview.png)', 'assets/readme.md', 'assets/preview\u0000.png',
  ]) {
    assert.throws(() => parseRegistrationScreenshots(issueBody(value)), /包内图片相对路径/, value);
  }
});

test('匹配路径后保留 npm 中的截图说明并生成目录数据', async () => {
  let reviews = 0;
  const result = await prepareRegistration(name, catalog, {
    icon: published.icon, screenshots: ['assets/preview.png', './assets/设置 页面.webp'], resolve,
    review: async checked => { assert.equal(checked, manifest); reviews++; return { approved: true }; },
  });
  assert.equal(reviews, 1);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.plugins, [published]);
  assert.deepEqual(result.versions, { [name]: '1.0.0' });
  assert.deepEqual(catalog, { plugins: [], versions: {} });
});

test('缺少、多填或顺序不同的截图在审查前拒绝，不改写目录', async () => {
  for (const screenshots of [
    ['assets/preview.png'],
    ['./assets/设置 页面.webp', 'assets/preview.png'],
    ['assets/preview.png', './assets/设置 页面.webp', 'assets/extra.png'],
  ]) {
    await assert.rejects(prepareRegistration(name, catalog, {
      screenshots, resolve, review: async () => assert.fail('截图不匹配时不应调用审查'),
    }), /screenshots.*不一致/);
  }
  assert.deepEqual(catalog, { plugins: [], versions: {} });
});

test('没有发布截图声明时不能通过 Issue 添加截图', async () => {
  await assert.rejects(prepareRegistration(name, catalog, {
    screenshots: ['assets/preview.png'],
    resolve: async () => ({ ...(await resolve()), plugin: { ...published, screenshots: undefined } }),
    review: async () => assert.fail('缺少声明时不应调用审查'),
  }), /screenshots.*不一致/);
});
