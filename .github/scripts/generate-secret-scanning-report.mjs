import { writeFile } from 'node:fs/promises';

const apiBaseUrl = 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.SECRET_SCANNING_READ_TOKEN;
const reportPath = 'secret-scanning-alerts.json';

if (!token) {
  throw new Error('Set the repository secret SECRET_SCANNING_READ_TOKEN before running this workflow.');
}

if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error('GITHUB_REPOSITORY must have the owner/repository format.');
}

const [owner, repo] = repository.split('/');
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
};

async function getJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with status ${response.status}.`);
  }

  return {
    data: await response.json(),
    nextPage: response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1],
  };
}

async function getAllPages(url) {
  const results = [];
  let nextPage = url;

  while (nextPage) {
    const page = await getJson(nextPage);
    if (!Array.isArray(page.data)) {
      throw new Error('GitHub API returned an unexpected response while listing alerts.');
    }

    results.push(...page.data);
    nextPage = page.nextPage;
  }

  return results;
}

function safeLocation(location) {
  const details = location?.details ?? {};

  return {
    type: location?.type ?? null,
    path: details.path ?? null,
    start_line: details.start_line ?? null,
    end_line: details.end_line ?? null,
    commit_sha: details.commit_sha ?? null,
  };
}

async function getAlertLocations(alertNumber) {
  const url = new URL(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/secret-scanning/alerts/${alertNumber}/locations`,
    apiBaseUrl,
  );
  url.searchParams.set('per_page', '100');

  const locations = await getAllPages(url);
  return locations.map(safeLocation);
}

const alertsUrl = new URL(
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/secret-scanning/alerts`,
  apiBaseUrl,
);
alertsUrl.searchParams.set('state', 'open');
alertsUrl.searchParams.set('per_page', '100');

const alerts = await getAllPages(alertsUrl);
const reportAlerts = [];

for (const alert of alerts) {
  if (!Number.isInteger(alert.number)) {
    throw new Error('GitHub API returned an alert without a valid alert number.');
  }

  reportAlerts.push({
    number: alert.number,
    state: alert.state,
    secret_type: alert.secret_type,
    secret_type_display_name: alert.secret_type_display_name,
    created_at: alert.created_at,
    updated_at: alert.updated_at,
    html_url: alert.html_url,
    locations: await getAlertLocations(alert.number),
  });
}

const report = {
  repository,
  generated_at: new Date().toISOString(),
  alert_count: reportAlerts.length,
  alerts: reportAlerts,
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`Generated report for ${report.alert_count} open alert(s).`);
