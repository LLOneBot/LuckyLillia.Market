import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewPackage } from '../scripts/review.mjs';
import { prepareRegistration } from '../scripts/register-issue.mjs';
import { validateChanges } from '../scripts/validate-pr.mjs';
import { scanCatalog } from '../scripts/scan-versions.mjs';

const aiEnv = {
  MARKET_AI_BASE_URL: 'https://ai.example.com/api/ai/',
  MARKET_AI_MODEL: 'review-test',
  MARKET_AI_API_KEY: 'test-only-key',
};
const plugin = {
  name: 'luckylillia-plugin-review', title: '审查测试', description: '必须通过 AI 审查的插件',
  author: { name: 'Test' }, repository: 'https://github.com/example/review',
};
const manifest = {
  name: plugin.name, version: '1.1.0',
  dist: { tarball: 'https://registry.npmjs.org/luckylillia-plugin-review/-/luckylillia-plugin-review-1.1.0.tgz' },
};
const resolve = async () => ({ plugin: structuredClone(plugin), manifest, version: manifest.version });

test('AI 审查缺少接口、模型或密钥时均不通过', async () => {
  for (const key of Object.keys(aiEnv)) {
    const env = { ...aiEnv };
    delete env[key];
    const assessment = await reviewPackage(manifest, {
      env, logger: () => {}, fetchImpl: async () => assert.fail('配置不完整时不应请求外部服务'),
    });
    assert.equal(assessment.approved, false, key);
    assert.equal(assessment.status, 'error', key);
    assert.ok(assessment.summary.includes(key), assessment.summary);
  }
});

for (const legacyEnabled of [undefined, 'false']) {
  test(`AI 审查失败时阻止登记、PR 校验和版本更新（旧开关${legacyEnabled === undefined ? '未设置' : '为 false'}）`, async () => {
    const env = { ...aiEnv, ...(legacyEnabled === undefined ? {} : { MARKET_AI_ENABLED: legacyEnabled }) };
    let downloads = 0;
    const review = checked => reviewPackage(checked, {
      env,
      logger: () => {},
      fetchImpl: async url => {
        assert.equal(url, manifest.dist.tarball);
        downloads++;
        return new Response(null, { status: 503 });
      },
    });
    const empty = { plugins: [], versions: {} };
    const registration = await prepareRegistration(plugin.name, empty, { resolve, review });
    assert.equal(registration.accepted, false);
    assert.equal(registration.assessment.status, 'error');
    assert.equal(registration.plugins, undefined);
    assert.equal(registration.versions, undefined);
    assert.deepEqual(empty, { plugins: [], versions: {} });

    const proposed = { plugins: [plugin], versions: { [plugin.name]: manifest.version } };
    const validation = await validateChanges(empty, proposed, { resolve, review });
    assert.equal(validation.approved, false);
    assert.equal(validation.reports.length, 1);
    assert.equal(validation.reports[0].assessment.status, 'error');

    const current = { plugins: [plugin], versions: { [plugin.name]: '1.0.0' } };
    const scan = await scanCatalog(current, { resolve, review });
    assert.deepEqual(scan.updates, []);
    assert.equal(scan.reports.length, 1);
    assert.equal(scan.reports[0].assessment.approved, false);
    assert.equal(scan.reports[0].assessment.status, 'error');
    assert.deepEqual(current, { plugins: [plugin], versions: { [plugin.name]: '1.0.0' } });
    assert.equal(downloads, 3);
  });
}
