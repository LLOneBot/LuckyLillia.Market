import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { parseDecision, reviewPackage } from '../scripts/review.mjs';

const approved = { decision: 'approve', summary: '静态审查通过', findings: [] };
const envelope = (message = {}, finishReason = 'stop') => ({
  id: 'completion-123', model: 'test-review',
  choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(approved), ...message } }],
});

test('普通文本响应允许省略、置空或使用空的 tool_calls 数组', () => {
  for (const tool_calls of [undefined, null, []]) {
    assert.equal(parseDecision(envelope({ tool_calls })).approved, true);
  }
});

for (const [name, response, expected] of [
  ['没有 choices', {}, /缺少 choices/],
  ['没有候选结果', { choices: [] }, /0 个 choices/],
  ['多个候选结果', { choices: [...envelope().choices, ...envelope().choices] }, /2 个 choices/],
  ['长度截断', envelope({}, 'length'), /长度限制.*finish_reason=length/],
  ['内容过滤', envelope({}, 'content_filter'), /内容过滤/],
  ['资源不足', envelope({}, 'insufficient_system_resource'), /资源不足/],
  ['结束原因为工具调用', envelope({}, 'tool_calls'), /工具调用/],
  ['未知结束原因', envelope({}, 'unexpected'), /finish_reason/],
  ['拒答', envelope({ refusal: '拒绝回答' }), /拒绝提供/],
  ['实际工具调用', envelope({ tool_calls: [{ type: 'function', function: { name: 'run' } }] }), /工具调用/],
  ['工具调用字段格式错误', envelope({ tool_calls: {} }), /工具调用/],
  ['旧式函数调用', envelope({ function_call: { name: 'run' } }), /工具调用/],
  ['只有推理内容', envelope({ content: null, reasoning_content: '尚在推理' }), /只返回了推理内容/],
  ['正文为空', envelope({ content: '  ' }), /缺少非空的文本正文/],
  ['正文不是 JSON', envelope({ content: 'not JSON' }), /不是有效 JSON/],
  ['结论结构不符', envelope({ content: '{"decision":"approve"}' }), /不符合约定格式/],
]) {
  test(`响应诊断能区分${name}，并保持拒绝放行`, () => assert.throws(() => parseDecision(response), expected));
}

test('空工具调用数组不能绕过中危及以上风险的阻断', () => {
  const findings = [{ severity: 'medium', file: 'index.js', reason: '调用红包接口' }];
  const result = parseDecision(envelope({ tool_calls: [], content: JSON.stringify({ ...approved, findings }) }));
  assert.equal(result.approved, false);
  assert.equal(result.status, 'blocked');
});

const env = { MARKET_AI_BASE_URL: 'https://ai.example.com/api', MARKET_AI_MODEL: 'test-review', MARKET_AI_API_KEY: 'sk-test-must-not-leak' };
const packageJson = { name: 'luckylillia-plugin-review-test', version: '1.0.0', main: 'index.js' };
const sourceMarker = 'SOURCE_MUST_NOT_APPEAR_IN_LOGS';
const chunks = [];
for (const [path, content] of Object.entries({ 'package.json': JSON.stringify(packageJson), 'index.js': `export const value = '${sourceMarker}';` })) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(`package/${path}`, 0, 100);
  for (const [offset, width, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(width - 1, '0'), offset, width - 1);
  }
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6);
  header[154] = 0;
  chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
}
const archive = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
const manifest = {
  ...packageJson,
  dist: {
    tarball: 'https://registry.npmjs.org/luckylillia-plugin-review-test/-/luckylillia-plugin-review-test-1.0.0.tgz',
    integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'),
  },
};

async function reviewResponse(responseEnvelope, { status = 200, body, contentType = 'application/json', transportError, reviewEnv = {}, responses } = {}) {
  const logs = [];
  const requests = [], signals = [];
  let downloads = 0;
  let request;
  const result = await reviewPackage(manifest, {
    env: { ...env, ...reviewEnv }, logger: entry => logs.push(entry),
    fetchImpl: async (url, options) => {
      if (url === manifest.dist.tarball) { downloads++; return new Response(archive); }
      assert.equal(url, 'https://ai.example.com/api/chat/completions');
      request = JSON.parse(options.body);
      requests.push(request);
      signals.push(options.signal);
      if (transportError) throw transportError;
      const reply = responses ? responses[Math.min(requests.length - 1, responses.length - 1)] : responseEnvelope;
      if (reply instanceof Error) throw reply;
      if (reply instanceof Response) return reply;
      return new Response(body ?? JSON.stringify(reply), { status, headers: { 'content-type': contentType, 'x-request-id': 'request-123' } });
    },
  });
  return { result, logs, request, requests, signals, downloads };
}

test('连续截断最多重试一次，遵守配置上限并保留每次诊断，同时保护密钥和正文', async () => {
  const reasoning = 'REASONING_MUST_NOT_APPEAR_IN_LOGS';
  const content = 'CONTENT_MUST_NOT_APPEAR_IN_LOGS';
  const response = {
    ...envelope({ content, reasoning_content: reasoning }, 'length'),
    id: `completion-${env.MARKET_AI_API_KEY}`,
    usage: { prompt_tokens: 100, completion_tokens: 4096, total_tokens: 4196, completion_tokens_details: { reasoning_tokens: 4080 } },
  };
  const { result, logs, request, requests, downloads } = await reviewResponse(response, { reviewEnv: { MARKET_AI_MAX_OUTPUT_TOKENS: '4096' } });
  assert.equal(result.approved, false);
  assert.equal(result.coverage.complete, false);
  assert.match(result.summary, /finish_reason=length/);
  assert.match(result.summary, /自动重试.*共 2 次尝试/);
  assert.match(result.summary, /MARKET_AI_MAX_OUTPUT_TOKENS/);
  assert.deepEqual(requests.map(request => request.max_tokens), [4096, 4096]);
  assert.equal(downloads, 1);
  assert.deepEqual(result.diagnostics.attempts.map(attempt => [attempt.attempt, attempt.maxOutputTokens, attempt.finishReason]), [[1, 4096, 'length'], [2, 4096, 'length']]);
  assert.equal(result.diagnostics.phase, 'ai_decision');
  assert.equal(result.diagnostics.config.maxOutputTokens, request.max_tokens);
  assert.equal(result.diagnostics.response.httpStatus, 200);
  assert.equal(result.diagnostics.response.requestId, 'request-123');
  assert.equal(result.diagnostics.response.finishReason, 'length');
  assert.equal(result.diagnostics.response.contentBytes, Buffer.byteLength(content));
  assert.equal(result.diagnostics.response.reasoningBytes, Buffer.byteLength(reasoning));
  assert.equal(result.diagnostics.response.usage.completion_tokens, 4096);
  assert.equal(result.diagnostics.response.usage.reasoning_tokens, 4080);
  assert.ok(result.diagnostics.response.elapsedMs >= 0);
  assert.ok(logs.some(entry => entry.event === 'ai_response_received' && entry.finishReason === 'length'));
  assert.equal(logs.filter(entry => entry.event === 'ai_retry_scheduled').length, 1);
  assert.equal(logs.at(-1).status, 'error');
  const serialized = JSON.stringify({ result, logs });
  for (const secret of [env.MARKET_AI_API_KEY, sourceMarker, reasoning, content]) assert.equal(serialized.includes(secret), false, secret);
});

test('完整结果保留诊断信息并正常通过审查', async () => {
  const { result, logs, request, requests } = await reviewResponse(envelope({ tool_calls: [] }));
  assert.equal(request.max_tokens, 32768);
  assert.equal(requests.length, 1);
  assert.equal(result.diagnostics.attempts.length, 1);
  assert.equal(result.approved, true);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.diagnostics.phase, 'complete');
  assert.equal(result.diagnostics.response.toolCallCount, 0);
  assert.equal(logs.at(-1).status, 'approved');
});

test('推理耗尽默认额度时用完整固定版本源码重试，获得完整 JSON 后才通过', async () => {
  const reasoning = 'PARTIAL_REASONING_MUST_NOT_BE_REPLAYED';
  const first = {
    ...envelope({ content: '', reasoning_content: reasoning }, 'length'),
    id: 'completion-first', usage: { completion_tokens: 32768, reasoning_tokens: 32768 },
  };
  const second = { ...envelope(), id: 'completion-second' };
  const { result, logs, requests, signals, downloads } = await reviewResponse(null, { responses: [first, second] });
  assert.equal(result.approved, true);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(requests.map(request => request.max_tokens), [32768, 65536]);
  assert.equal(requests[0].messages[1].content, requests[1].messages[1].content);
  const input = JSON.parse(requests[1].messages[1].content);
  assert.deepEqual(input.package, { name: manifest.name, version: manifest.version });
  assert.deepEqual(input.sources.map(source => source.file), ['package.json', 'index.js']);
  assert.ok(input.sources.some(source => source.content.includes(sourceMarker)));
  assert.deepEqual(requests[1].messages.map(message => message.role), ['system', 'user']);
  assert.equal(JSON.stringify(requests[1]).includes(reasoning), false);
  assert.equal(downloads, 1);
  assert.equal(signals[0], signals[1]);
  assert.deepEqual(result.diagnostics.attempts.map(attempt => [attempt.completionId, attempt.finishReason]), [['completion-first', 'length'], ['completion-second', 'stop']]);
  assert.equal(result.diagnostics.attempts[0].usage.reasoning_tokens, 32768);
  assert.equal(result.diagnostics.response.completionId, 'completion-second');
  assert.equal(logs.find(entry => entry.event === 'ai_retry_scheduled').nextMaxOutputTokens, 65536);
  assert.equal(logs.at(-1).status, 'approved');
  assert.equal(JSON.stringify({ result, logs }).includes(reasoning), false);
});

test('完整风险结论立即暂缓，截断重试后的中危风险也不会放行', async () => {
  const blocked = envelope({ content: JSON.stringify({
    decision: 'block', summary: '存在未经授权的 QQ 操作',
    findings: [{ severity: 'medium', file: 'index.js', reason: '未核验调用者权限即自动加群' }],
  }) });
  for (const responses of [[blocked], [envelope({}, 'length'), blocked]]) {
    const { result, requests } = await reviewResponse(null, { responses });
    assert.equal(requests.length, responses.length);
    assert.equal(result.approved, false);
    assert.equal(result.status, 'blocked');
    assert.equal(result.coverage.complete, true);
    assert.equal(result.findings[0].severity, 'medium');
  }
});

test('拒答、工具调用或多个候选不能通过截断重试改变结果', async () => {
  for (const response of [
    envelope({ refusal: '拒答' }, 'length'),
    envelope({ tool_calls: [{ type: 'function', function: { name: 'run' } }] }, 'length'),
    envelope({ tool_calls: {} }, 'length'),
    envelope({ function_call: { name: 'run' } }, 'length'),
    { choices: [...envelope({}, 'length').choices, ...envelope().choices] },
    envelope({ content: '{"decision":"approve"' }),
  ]) {
    const { result, requests, logs } = await reviewResponse(null, { responses: [response, envelope()] });
    assert.equal(requests.length, 1);
    assert.equal(result.approved, false);
    assert.equal(result.coverage.complete, false);
    assert.ok(!logs.some(entry => entry.event === 'ai_retry_scheduled'));
  }
});

test('重试遇到 HTTP 或网络错误时结束并保留初次截断记录', async () => {
  const timeout = Object.assign(new Error('RETRY_TRANSPORT_SECRET'), { name: 'TimeoutError', cause: { code: 'ETIMEDOUT' } });
  for (const reply of [new Response('RETRY_HTTP_SECRET', { status: 429 }), timeout]) {
    const { result, logs, requests } = await reviewResponse(null, { responses: [envelope({}, 'length'), reply] });
    assert.equal(result.approved, false);
    assert.equal(result.status, 'error');
    assert.equal(result.coverage.complete, false);
    assert.equal(requests.length, 2);
    assert.equal(result.diagnostics.attempts[0].finishReason, 'length');
    assert.equal(result.diagnostics.attempts[1].attempt, 2);
    if (reply === timeout) assert.deepEqual(result.diagnostics.response.error, { name: 'TimeoutError', code: 'ETIMEDOUT' });
    else assert.equal(result.diagnostics.response.httpStatus, 429);
    assert.doesNotMatch(JSON.stringify({ result, logs }), /RETRY_TRANSPORT_SECRET|RETRY_HTTP_SECRET/);
  }
});

test('共用时限耗尽后不启动第二次请求，也不采用已截断的 approve 正文', async t => {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => milliseconds === 30_000 ? timeout(milliseconds) : controller.signal);
  const requests = [];
  const result = await reviewPackage(manifest, {
    env, logger: () => {},
    fetchImpl: async (url, options) => {
      if (url === manifest.dist.tarball) return new Response(archive);
      requests.push(options);
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(JSON.stringify(envelope({}, 'length'))));
          stream.close();
          controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
        },
      }));
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(result.approved, false);
  assert.equal(result.coverage.complete, false);
  assert.match(result.summary, /总时限/);
  assert.equal(result.diagnostics.attempts.length, 1);
  assert.equal(result.diagnostics.response.finishReason, 'length');
});

test('输出额度可以独立配置，并拒绝无效值', async () => {
  const custom = await reviewResponse(envelope(), { reviewEnv: { MARKET_AI_MAX_OUTPUT_TOKENS: '65536' } });
  assert.equal(custom.result.approved, true);
  assert.equal(custom.request.max_tokens, 65536);
  assert.equal(custom.result.diagnostics.config.maxOutputTokens, 65536);
  for (const value of ['0', '-1', '1.5', 'abc', '131073']) {
    const invalid = await reviewResponse(envelope(), { reviewEnv: { MARKET_AI_MAX_OUTPUT_TOKENS: value } });
    assert.equal(invalid.result.approved, false, value);
    assert.match(invalid.result.summary, /MARKET_AI_MAX_OUTPUT_TOKENS/);
    assert.equal(invalid.result.diagnostics.phase, 'configuration');
    assert.equal(invalid.request, undefined);
  }
});

test('HTTP 错误和非 JSON 响应保留状态与请求 ID', async () => {
  const http = await reviewResponse(null, { status: 429, body: 'PROVIDER_BODY_MUST_NOT_APPEAR' });
  assert.match(http.result.summary, /HTTP 429/);
  assert.equal(http.result.diagnostics.response.httpStatus, 429);
  assert.equal(http.result.diagnostics.response.requestId, 'request-123');
  assert.equal(JSON.stringify(http).includes('PROVIDER_BODY_MUST_NOT_APPEAR'), false);
  const malformed = await reviewResponse(null, { body: 'data: not-json', contentType: 'text/event-stream' });
  assert.equal(malformed.result.approved, false);
  assert.equal(malformed.result.diagnostics.phase, 'ai_response');
  assert.equal(malformed.result.diagnostics.response.httpContentType, 'text/event-stream');
  assert.equal(malformed.result.diagnostics.response.responseBytes, Buffer.byteLength('data: not-json'));
});

test('网络错误记录类型与错误码，不记录可能包含敏感信息的异常正文', async () => {
  const transportError = Object.assign(new Error('TRANSPORT_SECRET_MUST_NOT_APPEAR'), { name: 'TimeoutError', cause: { code: 'ETIMEDOUT' } });
  const { result, logs } = await reviewResponse(null, { transportError });
  assert.equal(result.approved, false);
  assert.equal(result.diagnostics.phase, 'ai_request');
  assert.deepEqual(result.diagnostics.response.error, { name: 'TimeoutError', code: 'ETIMEDOUT' });
  assert.equal(JSON.stringify({ result, logs }).includes(transportError.message), false);
});
