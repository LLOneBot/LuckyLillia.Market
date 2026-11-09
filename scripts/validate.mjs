import { matchesPublishedPlugin, readCatalog, resolvePlugin } from './catalog.mjs';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--remote')) throw new Error('用法：node scripts/validate.mjs [--remote]');
  const { plugins, versions } = await readCatalog();
  if (args.includes('--remote')) {
    for (const plugin of plugins) {
      const current = await resolvePlugin(plugin.name, { version: versions[plugin.name], githubToken: process.env.GITHUB_TOKEN });
      if (!matchesPublishedPlugin(plugin, current.plugin)) {
        throw new Error(`${plugin.name} 的目录元数据与已登记 npm 版本不一致，请从发布包重新同步。`);
      }
    }
  }
  console.log(`已校验 ${plugins.length} 个插件及对应版本${args.includes('--remote') ? '（含 npm 和 GitHub 元数据）' : ''}。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
