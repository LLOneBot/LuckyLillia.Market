import { GitHub } from './github.mjs';

// Dispatch the actual publishing workflow so npm always sees publish.yml as
// its OIDC identity, including when an hourly scan initiates publication.
const github = new GitHub();
await github.request('POST', '/actions/workflows/publish.yml/dispatches', { ref: await github.defaultBranch() });
console.log('已请求发布检查；目录内容未变化时会跳过 npm 发布。');
