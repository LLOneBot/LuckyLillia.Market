import { literal } from './github.mjs';

// Escape package/model text before inserting it into Markdown or table cells.
function text(value, limit = 2000) {
  const source = String(value ?? '');
  const excerpt = source.length > limit ? source.slice(0, limit) + '…（节选，完整内容见报告）' : source;
  return literal(excerpt.replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&')).replace(/\r\n|\r|\n/g, '<br>');
}

export function reviewSummary(assessment) {
  return text(assessment.summary, 4000);
}

export function runUrl(env) {
  const attempt = /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : '';
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') && /^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '')
    ? `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${attempt}` : null;
}

const severity = { critical: '严重', high: '高', medium: '中', low: '低' };
const priority = { critical: 0, high: 1, medium: 2, low: 3 };

export function registrationBody(result, issueNumber, env = process.env) {
  const { plugin, version, assessment } = result;
  const title = text(plugin.title, 200);
  const packageUrl = `https://www.npmjs.com/package/${plugin.name}/v/${encodeURIComponent(version)}`;
  const lines = [
    `登记插件 **${title}**，首次记录版本 ${text(version, 256)}。`,
    '',
    '## 插件用途',
    '',
    text(plugin.description),
    '',
    '以上用途来自该版本的 npm 简介，由插件发布者提供。',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    `| npm 包及版本 | [${text(plugin.name, 214)}@${text(version, 256)}](${packageUrl}) |`,
    `| 作者 | ${text(plugin.author.name, 200)} |`,
    `| GitHub 仓库 | [查看源码](${plugin.repository}) |`,
    '',
    '作者信息仅作署名展示，不代表身份或所有权认证。',
    '',
    '## 风险审查',
    '',
  ];
  const state = {
    approved: 'AI 静态审查通过：本次未发现达到阻断级别的风险，仍需维护者审核。',
    blocked: '审查未通过，暂缓登记或更新。',
    error: '审查未完成，暂缓登记或更新。',
  }[assessment.status] ?? '没有有效的审查结论。';
  lines.push(`**${state}**`, '', text(assessment.summary, 1200), '', '### 具体风险点', '');
  const findings = [...(assessment.findings ?? [])].sort((a, b) => (priority[a.severity] ?? 4) - (priority[b.severity] ?? 4));
  if (!findings.length) {
    lines.push(assessment.status === 'approved' ? '本次静态审查未报告具体风险项。' : '没有可用的风险条目，请查看上方原因和完整报告。');
  } else {
    lines.push('| 等级 | 文件 | 风险原因及依据 |', '| --- | --- | --- |');
    let size = 0;
    let shown = 0;
    for (const finding of findings) {
      const row = `| ${severity[finding.severity] ?? '未知'} | ${text(finding.file, 240)} | ${text(finding.reason, 800)} |`;
      if (size + row.length > 20_000) break;
      lines.push(row);
      size += row.length;
      shown++;
    }
    if (shown < findings.length) lines.push('', `共 ${findings.length} 条风险项，此处展示 ${shown} 条；其余见完整报告。`);
  }
  lines.push('', '### 检查范围', '');
  if (assessment.coverage) {
    const coverage = assessment.coverage;
    lines.push(
      `- 已向模型提交 ${coverage.inspectedFiles?.length ?? 0} 个文件；归档共 ${coverage.totalFiles ?? 0} 个文件，另有 ${coverage.omittedFiles?.length ?? 0} 个资源文件未提交。`,
      `- 代码检查${coverage.complete ? '已完成' : '未完成'}；文件清单及省略原因见完整报告。`,
      '- 仅静态读取此精确版本的发布包；不执行插件，不逐个审查依赖，也不验证运行时行为。',
    );
  } else {
    lines.push('未提供文件覆盖记录，请查看完整报告。');
  }
  const url = runUrl(env);
  lines.push(
    '',
    '静态审查通过不代表运行安全。PR 的最终检查结果以当前提交的 `market/catalog` 状态及其报告为准。',
    '',
    url ? `完整登记报告：[本次检查记录](${url}) → artifact \`registration-review\` → \`registration-${issueNumber}.json\`。` : '完整登记报告见登记工作流的 `registration-review` artifact。',
    '',
    `Closes #${issueNumber}`,
  );
  return lines.join('\n');
}
