import { readFile } from 'node:fs/promises';

const apiBaseUrl = 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const reportPath = process.env.ALERT_REPORT_PATH ?? 'secret-scanning-alerts.json';
const analysisPath = process.env.ALERT_ANALYSIS_PATH ?? 'secret-scanning-analysis.json';

if (!token) {
  throw new Error('GITHUB_TOKEN is required to create issues and analysis comments.');
}

if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error('GITHUB_REPOSITORY must have the owner/repository format.');
}

const [owner, repo] = repository.split('/');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const analysisReport = JSON.parse(await readFile(analysisPath, 'utf8'));

if (
  report.repository !== repository
  || !Array.isArray(report.alerts)
  || analysisReport.repository !== repository
  || !Array.isArray(analysisReport.analyses)
) {
  throw new Error('The alert report or analysis is invalid or belongs to a different repository.');
}

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed with status ${response.status}.`);
  }

  return {
    data: response.status === 204 ? null : await response.json(),
    nextPage: response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1],
  };
}

async function getAllPages(url) {
  const items = [];
  let nextPage = url;

  while (nextPage) {
    const page = await request(nextPage);
    if (!Array.isArray(page.data)) {
      throw new Error('GitHub API returned an unexpected paginated response.');
    }

    items.push(...page.data);
    nextPage = page.nextPage;
  }

  return items;
}

function escapeMarkdown(value) {
  return String(value ?? 'unknown')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 2000)
    .replace(/[\\`|*_{}\[\]<>]/g, '\\$&');
}

function issueBody(alert, generatedAt) {
  const lines = [
    `<!-- secret-scanning-alert:${alert.number} -->`,
    '# Secret Scanning alert',
    '',
    `- Repository: \`${escapeMarkdown(repository)}\``,
    `- Alert: [#${alert.number}](https://github.com/${owner}/${repo}/security/secret-scanning/${alert.number})`,
    `- Type: ${escapeMarkdown(alert.secret_type_display_name ?? alert.secret_type)}`,
    `- State: ${escapeMarkdown(alert.state)}`,
    `- Created: ${escapeMarkdown(alert.created_at)}`,
    `- Updated: ${escapeMarkdown(alert.updated_at)}`,
    `- Report generated: ${escapeMarkdown(generatedAt)}`,
    '- Locations:',
  ];

  if (alert.locations.length === 0) {
    lines.push('  - No location details available.');
  } else {
    for (const location of alert.locations) {
      const lineRange = location.start_line == null
        ? ''
        : `:${location.start_line}${location.end_line == null || location.end_line === location.start_line ? '' : `-${location.end_line}`}`;
      const path = location.path ? `\`${escapeMarkdown(location.path)}${lineRange}\`` : 'Unknown path';
      lines.push(`  - ${path} (type: ${escapeMarkdown(location.type)})`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function analysisComment(analysis, generatedAt) {
  const lines = [
    `<!-- secret-scanning-analysis:${analysis.alert.number} -->`,
    '## Análisis de Secret Scanning',
    '',
    `- **Clasificación:** \`${analysis.classification}\``,
    `- **Evidencia:** ${analysis.evidence.map(escapeMarkdown).join('; ')}`,
    `- **Motivo:** ${escapeMarkdown(analysis.rationale)}`,
    `- **Acción recomendada:** ${escapeMarkdown(analysis.recommended_action)}`,
    '',
    `_Análisis generado por OpenAI el ${escapeMarkdown(generatedAt)}. No se incluyó el valor del secreto._`,
  ];

  return `${lines.join('\n')}\n`;
}

async function findExistingIssue(alertNumber) {
  const issueListUrl = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, apiBaseUrl);
  issueListUrl.searchParams.set('state', 'all');
  issueListUrl.searchParams.set('per_page', '100');

  const marker = `<!-- secret-scanning-alert:${alertNumber} -->`;
  const issues = await getAllPages(issueListUrl);
  return issues.find((issue) => !issue.pull_request && issue.title === `Secret Scanning Alert ${alertNumber}` && issue.body?.includes(marker));
}

async function findAnalysisComment(issueNumber, alertNumber) {
  const commentsUrl = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
    apiBaseUrl,
  );
  commentsUrl.searchParams.set('per_page', '100');
  const marker = `<!-- secret-scanning-analysis:${alertNumber} -->`;
  const comments = await getAllPages(commentsUrl);
  return comments.find((comment) => comment.body?.includes(marker));
}

async function upsertAnalysisComment(issueNumber, alertAnalysis) {
  const commentUrl = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments`,
    apiBaseUrl,
  );
  const existingComment = await findAnalysisComment(issueNumber, alertAnalysis.alert.number);
  const body = analysisComment(alertAnalysis, analysisReport.generated_at);

  if (existingComment) {
    await request(new URL(`${commentUrl.pathname}/${existingComment.id}`, apiBaseUrl), {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    return;
  }

  const issueCommentsUrl = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
    apiBaseUrl,
  );
  await request(issueCommentsUrl, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

const analysisByAlertNumber = new Map(
  analysisReport.analyses.map((item) => [item.alert?.number, item]),
);
let createdCount = 0;
let existingCount = 0;

for (const alert of report.alerts.filter((item) => item.state === 'open')) {
  if (!Number.isInteger(alert.number) || !Array.isArray(alert.locations)) {
    throw new Error('The alert report contains an invalid alert entry.');
  }

  const alertAnalysis = analysisByAlertNumber.get(alert.number);
  if (
    !alertAnalysis
    || alertAnalysis.classification !== 'NO_DISMISS'
    || !Array.isArray(alertAnalysis.evidence)
    || !alertAnalysis.evidence.every((item) => typeof item === 'string')
    || typeof alertAnalysis.rationale !== 'string'
    || typeof alertAnalysis.recommended_action !== 'string'
  ) {
    throw new Error(`No valid conservative analysis was returned for alert ${alert.number}.`);
  }

  let issue = await findExistingIssue(alert.number);
  if (!issue) {
    const issueUrl = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, apiBaseUrl);
    const response = await request(issueUrl, {
      method: 'POST',
      body: JSON.stringify({
        title: `Secret Scanning Alert ${alert.number}`,
        body: issueBody(alert, report.generated_at),
      }),
    });
    issue = response.data;
    createdCount += 1;
  } else {
    existingCount += 1;
  }

  await upsertAnalysisComment(issue.number, alertAnalysis);
}

console.log(`Created ${createdCount} issue(s), reused ${existingCount}, and published analysis for ${analysisByAlertNumber.size} alert(s).`);
