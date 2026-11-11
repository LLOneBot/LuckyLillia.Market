import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org';
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class MarketError extends Error {
  constructor(message, { code = 'INVALID_METADATA', retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'MarketError';
    this.code = code;
    this.retryable = retryable;
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'INVALID_METADATA') => { throw new MarketError(message, { code }); };
const string = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const keysOnly = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));

/** Preview captions are short display strings, not localized objects once stored in the catalogue. */
const isCaption = value => string(value, 200) && value === value.trim();

/** A catalogue screenshot is a package image path, HTTP(S) URL, or { src, caption }. */
export function isScreenshot(item) {
  if (isImageSource(item)) return true;
  if (!object(item) || !keysOnly(item, ['src', 'caption']) || !isImageSource(item.src)) return false;
  return !Object.hasOwn(item, 'caption') || isCaption(item.caption);
}

export function isPackageName(name) {
  return typeof name === 'string' && name === name.trim() && name.length <= 214 && NAME_PATTERN.test(name) && !['node_modules', 'favicon.ico'].includes(name);
}

export function isVersion(value) {
  return typeof value === 'string' && value === value.trim() && value.length <= 256 && VERSION_PATTERN.test(value);
}

/** Public image URLs only; do not let URL parsing repair whitespace or backslashes. */
export function isImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

/** Keep package-relative image filenames verbatim, including ./, spaces and Unicode. */
export function isImagePath(value) {
  return string(value, 2048) && value === value.trim()
    && !value.startsWith('/') && !/[:\\]/.test(value)
    && !value.split('/').includes('..')
    && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(value);
}

export function isImageSource(value) {
  return isImageUrl(value) || isImagePath(value);
}

/** Missing or explicitly empty images are allowed, including in old registration PRs. */
export function matchesPublishedPlugin(plugin, published) {
  const { icon, screenshots, ...required } = plugin;
  const { icon: publishedIcon, screenshots: publishedScreenshots, ...publishedRequired } = published;
  return isDeepStrictEqual(required, publishedRequired)
    && (!icon || icon === publishedIcon)
    && (!screenshots?.length || isDeepStrictEqual(screenshots, publishedScreenshots));
}

/** Keep a maintainer's explicit opt-out when regenerating otherwise authoritative npm metadata. */
export function preserveImageBlanks(plugin, previous) {
  return {
    ...plugin,
    ...(previous?.icon === '' ? { icon: '' } : {}),
    ...(Array.isArray(previous?.screenshots) && previous.screenshots.length === 0 ? { screenshots: [] } : {}),
  };
}

/** Normalize npm's repository URL forms; never accept a host or path supplied by a redirect. */
export function normalizeRepository(repository) {
  let value = object(repository) ? repository.url : repository;
  if (typeof value !== 'string' || !value.trim()) {
    fail('npm 包缺少有效的 repository。请在 package.json.repository 填写公开 GitHub 仓库地址，发布新版本后重新提交。', 'MISSING_REPOSITORY');
  }
  value = value.trim().replace(/^git\+/, '');
  if (/^github:/i.test(value)) value = `https://github.com/${value.slice(7)}`;
  if (/^git@github\.com:/i.test(value)) value = value.replace(/^git@github\.com:/i, 'https://github.com/');
  // URL normalizes dot segments and backslashes, so reject them before parsing.
  if (/[\\\s%?#]/.test(value) || /(?:^|\/)\.\.?(?:\/|$)/.test(value)) {
    fail('repository 必须指向 GitHub 仓库根地址，例如 https://github.com/owner/repo。', 'INVALID_REPOSITORY');
  }
  let url;
  try { url = new URL(value); } catch { fail('repository 不是有效的 GitHub 仓库地址。', 'INVALID_REPOSITORY'); }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.port || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))) {
    fail('repository 必须是 github.com 上的公开仓库地址。', 'INVALID_REPOSITORY');
  }
  const parts = url.pathname.replace(/\/$/, '').split('/');
  if (parts.length !== 3 || parts[0] !== '') fail('repository 必须指向仓库根地址，不能是文件或目录链接。', 'INVALID_REPOSITORY');
  const owner = parts[1];
  const repo = parts[2].replace(/\.git$/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || ['.', '..'].includes(repo) || repo.endsWith('.git')) {
    fail('repository 的 GitHub 所有者或仓库名称无效。', 'INVALID_REPOSITORY');
  }
  return `https://github.com/${owner}/${repo}`;
}

function authorUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** Author is display attribution only. Email and arbitrary package metadata are omitted. */
export function parseAuthor(author) {
  let name;
  let url;
  if (typeof author === 'string') {
    name = author.replace(/<[^>]*>/g, '').trim();
    const suffix = name.match(/\s*\(([^()]*)\)\s*$/);
    if (suffix && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(suffix[1])) {
      url = authorUrl(suffix[1]);
      name = name.slice(0, suffix.index).trim();
    }
  } else if (object(author)) {
    name = typeof author.name === 'string' ? author.name.trim() : undefined;
    url = authorUrl(author.url);
  }
  if (!string(name, 200) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
    fail('npm 包缺少作者名称。请在 package.json.author 中填写作者名称并发布新版本；作者信息仅用于展示。', 'MISSING_AUTHOR');
  }
  return { name, ...(url ? { url } : {}) };
}

function localized(value) {
  if (typeof value === 'string') return value.trim();
  if (!object(value)) return undefined;
  for (const locale of ['zh-CN', 'zh', 'en']) {
    if (typeof value[locale] === 'string' && value[locale].trim()) return value[locale].trim();
  }
  return undefined;
}

export function metadataToPlugin(metadata) {
  if (!object(metadata) || !isPackageName(metadata.name)) fail('npm 包名称无效。', 'INVALID_PACKAGE_NAME');
  if (!isVersion(metadata.version)) fail('npm 包必须提供精确版本号，不能使用范围或标签。', 'INVALID_VERSION');
  if (!object(metadata.llbot)) fail('该 npm 包没有 llbot 插件声明。请在 package.json 中补充 llbot 并发布新版本。', 'NOT_A_PLUGIN');
  const title = localized(metadata.llbot.title);
  const description = localized(metadata.llbot.description) || localized(metadata.description);
  if (!string(title, 200)) fail('请在 package.json.llbot.title 填写插件名称并发布新版本。', 'MISSING_TITLE');
  if (!string(description, 2000)) fail('请在 package.json.description 或 llbot.description 填写插件简介并发布新版本。', 'MISSING_DESCRIPTION');
  const plugin = { name: metadata.name, version: metadata.version, title, description, author: parseAuthor(metadata.author), repository: normalizeRepository(metadata.repository) };
  const icon = metadata.llbot.icon;
  const screenshots = Array.isArray(metadata.llbot.screenshots)
    ? metadata.llbot.screenshots.map(item => {
        const src = object(item) ? item.src : item;
        if (!isImageSource(src)) return undefined;
        if (!object(item)) return src;
        const caption = localized(item.caption);
        return { src, ...(caption && isCaption(caption) ? { caption } : {}) };
      }).filter(Boolean)
    : [];
  if (isImageSource(icon)) plugin.icon = icon;
  if (screenshots.length) plugin.screenshots = screenshots;
  return plugin;
}

export function validateCatalog(plugins) {
  if (!Array.isArray(plugins)) fail('plugins.json 必须是插件数组。', 'INVALID_CATALOG');
  const names = new Set();
  for (const plugin of plugins) {
    if (!object(plugin) || !keysOnly(plugin, ['name', 'version', 'title', 'description', 'author', 'repository', 'icon', 'screenshots'])) fail('插件条目包含无效字段。', 'INVALID_CATALOG');
    if (!isPackageName(plugin.name)) fail('插件条目包含无效 npm 包名。', 'INVALID_PACKAGE_NAME');
    if (names.has(plugin.name)) fail(`插件重复登记：${plugin.name}。`, 'DUPLICATE_PACKAGE');
    names.add(plugin.name);
    if (!isVersion(plugin.version)) fail(`插件 ${plugin.name} 缺少精确版本号，或版本号无效。`, 'INVALID_VERSION');
    if (!string(plugin.title, 200) || plugin.title !== plugin.title.trim() || !string(plugin.description, 2000) || plugin.description !== plugin.description.trim()) fail(`插件 ${plugin.name} 的名称或简介无效。`, 'INVALID_CATALOG');
    if (!object(plugin.author) || !keysOnly(plugin.author, ['name', 'url']) || !string(plugin.author.name, 200) || plugin.author.name !== plugin.author.name.trim()) fail(`插件 ${plugin.name} 的作者信息无效。`, 'INVALID_CATALOG');
    if (Object.hasOwn(plugin.author, 'url') && !authorUrl(plugin.author.url)) fail(`插件 ${plugin.name} 的作者链接必须是 HTTP(S) 地址。`, 'INVALID_CATALOG');
    if (typeof plugin.repository !== 'string' || normalizeRepository(plugin.repository) !== plugin.repository) fail(`插件 ${plugin.name} 的 repository 必须是规范 GitHub 地址。`, 'INVALID_CATALOG');
    if (Object.hasOwn(plugin, 'icon') && plugin.icon !== '' && !isImageSource(plugin.icon)) fail(`插件 ${plugin.name} 的 icon 必须是包内图片相对路径、HTTP(S) 地址或空字符串。`, 'INVALID_CATALOG');
    if (Object.hasOwn(plugin, 'screenshots') && (!Array.isArray(plugin.screenshots) || plugin.screenshots.some(item => !isScreenshot(item)))) fail(`插件 ${plugin.name} 的 screenshots 必须是包内图片相对路径、HTTP(S) 图片地址或 { src, caption } 对象的数组，可为空数组。`, 'INVALID_CATALOG');
  }
}

export async function readCatalog(root = process.cwd()) {
  let plugins;
  try {
    plugins = JSON.parse(await readFile(join(root, 'plugins.json'), 'utf8'));
  } catch (cause) {
    throw new MarketError('无法读取 plugins.json，请检查文件是否存在且为有效 JSON。', { code: 'INVALID_CATALOG', cause });
  }
  validateCatalog(plugins);
  return { plugins };
}

export async function writeCatalog(root, plugins) {
  validateCatalog(plugins);
  const sorted = [...plugins].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  await writeFile(join(root, 'plugins.json'), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

/** Bounded JSON transport. Request bodies and response bodies never enter diagnostic messages. */
export async function fetchJson(url, { fetchImpl = globalThis.fetch, headers, maxBytes = 16 * 1024 * 1024, timeoutMs = 20_000, signal, ...options } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url, { ...options, headers: { Accept: 'application/json', 'User-Agent': 'LuckyLillia-Market', ...headers }, redirect: 'error', signal: requestSignal });
  } catch (cause) {
    throw new MarketError('网络请求失败或超时，请稍后重试。', { code: 'NETWORK_ERROR', retryable: true, cause });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new MarketError(`远程服务返回 HTTP ${response.status}。`, { code: `HTTP_${response.status}`, retryable: [401, 403, 408, 425, 429].includes(response.status) || response.status >= 500 });
  }
  if (response.status === 204) return undefined;
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new MarketError('远程 JSON 超过允许的大小。', { code: 'RESPONSE_TOO_LARGE' });
  }
  let body;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new MarketError('远程服务返回了空响应。', { code: 'INVALID_JSON' });
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new MarketError('远程 JSON 超过允许的大小。', { code: 'RESPONSE_TOO_LARGE' });
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    body = Buffer.concat(chunks, size).toString('utf8');
  } catch (cause) {
    if (cause instanceof MarketError) throw cause;
    throw new MarketError('读取远程响应失败或超时，请稍后重试。', { code: 'NETWORK_ERROR', retryable: true, cause });
  }
  try { return JSON.parse(body); } catch (cause) {
    throw new MarketError('远程服务返回了无效 JSON，请稍后重试。', { code: 'INVALID_JSON', retryable: true, cause });
  }
}

export async function fetchPackage(name, { version, fetchImpl = globalThis.fetch } = {}) {
  if (!isPackageName(name)) fail('请输入有效的 npm 包名，不能填写 URL、版本范围或文件路径。', 'INVALID_PACKAGE_NAME');
  if (version !== undefined && !isVersion(version)) fail('版本号必须是精确的 SemVer 版本，不能使用范围或标签。', 'INVALID_VERSION');
  let packument;
  try { packument = await fetchJson(`${REGISTRY}/${encodeURIComponent(name)}`, { fetchImpl }); } catch (error) {
    if (error.code === 'HTTP_404') fail('npm 上不存在这个包，请先发布插件再登记。', 'PACKAGE_NOT_FOUND');
    throw error;
  }
  if (!object(packument) || packument.name !== name || !object(packument.versions)) fail('npm 返回的包信息不完整或包名不匹配。', 'INVALID_PACKAGE');
  const resolved = version ?? packument['dist-tags']?.latest;
  if (!isVersion(resolved)) fail('npm 包没有有效的 latest 版本。', 'INVALID_VERSION');
  if (!Object.hasOwn(packument.versions, resolved)) fail('npm 上不存在所选版本，请等待发布同步后重试。', 'VERSION_NOT_FOUND');
  const metadata = packument.versions[resolved];
  if (!object(metadata) || metadata.name !== name || metadata.version !== resolved) fail('npm 版本元数据与所选包名或版本不匹配。', 'INVALID_PACKAGE');
  const plugin = metadataToPlugin(metadata);
  if (!object(metadata.dist) || typeof metadata.dist.tarball !== 'string') fail('npm 包缺少发布文件信息。', 'INVALID_DIST');
  return { name, version: resolved, metadata, plugin, dist: metadata.dist };
}

export async function checkRepository(repository, { fetchImpl = globalThis.fetch, token } = {}) {
  const canonical = normalizeRepository(repository);
  const [owner, repo] = canonical.slice('https://github.com/'.length).split('/');
  let result;
  try {
    result = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, { fetchImpl, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, maxBytes: 1024 * 1024 });
  } catch (error) {
    if (error.code === 'HTTP_404') fail('repository 指向的 GitHub 仓库不存在或不是公开仓库，请修正 package.json.repository 后发布新版本。', 'REPOSITORY_NOT_FOUND');
    throw error;
  }
  if (!object(result) || result.private !== false || typeof result.full_name !== 'string' || result.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) fail('repository 必须指向可公开访问的 GitHub 仓库。', 'INVALID_REPOSITORY');
  return canonical;
}

export async function resolvePlugin(name, options = {}) {
  const result = await fetchPackage(name, options);
  await checkRepository(result.plugin.repository, { fetchImpl: options.fetchImpl, token: options.githubToken ?? process.env.GITHUB_TOKEN });
  return { plugin: result.plugin, version: result.version, manifest: result.metadata };
}
