import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const maxFileSize = 2 * 1024 * 1024;
const outputJsonPath = process.env.CODE_SCAN_JSON_PATH ?? 'secret-scanning-code-report.json';
const outputMarkdownPath = process.env.CODE_SCAN_MARKDOWN_PATH ?? 'secret-scanning-code-report.md';
const textExtensions = new Set([
  '.c', '.cc', '.cfg', '.conf', '.cpp', '.cs', '.go', '.groovy', '.h', '.hpp',
  '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.md', '.mjs', '.php', '.properties',
  '.py', '.rb', '.sh', '.sql', '.tf', '.ts', '.tsx', '.xml', '.yaml', '.yml',
]);
const configExtensions = new Set(['.cfg', '.conf', '.ini', '.json', '.properties', '.tf', '.yaml', '.yml']);
const credentialAssignment = /(?:password|passwd|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|(?<!version-)secret(?:[_-]?key)?)\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|(\$\{\{[^}]*\}\}|\$\{[^}]+\}|[^\s,;#<]+))/ig;
const xmlCredential = /<(?:password|passwd|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|secret(?:[_-]?key)?)\b[^>]*>([^<]+)<\//ig;
const knownTokenPatterns = [
  { type: 'AWS access key identifier', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'GitHub access token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { type: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'PEM private key', regex: /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/g },
];
const ignoredValuePattern = /^(?:\$\{\{[\s\S]*\}\}|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|<[^>]+>|process\.env(?:\.[A-Z0-9_]+)*|System\.(?:getenv|getProperty)\(.+\)|getenv\(.+\)|(?:[A-Z_$][\w$]*\.)*(?:getSecret\w*|getPassword\w*|getToken\w*)\(.+\)|secretmanager:\/\/.+)$/i;
const placeholderPattern = /^(?:example|sample|dummy|placeholder|changeme|change[_-]?me|replace[_-]?me|todo|none|null|undefined|test|fake|esteEsElSecret|esteEsElClientId|your[_-]?(?:api[_-]?key|token|password|secret|client[_-]?id))$/i;
const isTextSourceFile = (file) => (
  textExtensions.has(path.extname(file).toLowerCase())
  || path.basename(file) === 'Jenkinsfile'
  || path.basename(file) === 'Dockerfile'
  || path.basename(file) === 'Makefile'
  || path.basename(file) === 'Procfile'
  || path.basename(file) === 'Gemfile'
  || path.basename(file).startsWith('.env')
);

function isPlaceholder(value) {
  const normalized = value.trim().replace(/^['"`]|['"`]$/g, '');
  return !normalized
    || ignoredValuePattern.test(normalized)
    || placeholderPattern.test(normalized);
}

function addFinding(findings, seen, relativePath, line, type, value) {
  if (isPlaceholder(value)) {
    return;
  }

  const key = `${relativePath}:${line}:${type}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  findings.push({
    type,
    path: relativePath.split(path.sep).join('/'),
    line,
    classification: 'NO_DISMISS',
    rationale: 'Se detectó un patrón que podría corresponder a una credencial; el análisis local no verifica si es válido, activo, revocado o exclusivo de pruebas.',
    recommended_action: 'Verificar con el propietario autorizado; si es una credencial real y activa, revocarla o rotarla y trasladarla a un gestor de secretos.',
  });
}

const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const fileList = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repositoryRoot,
  encoding: 'buffer',
}).toString('utf8');
const files = [...new Set(fileList.split('\0').filter(Boolean))]
  .filter(isTextSourceFile);

const findings = [];
const seen = new Set();
let scannedFileCount = 0;

for (const relativePath of files) {
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile() || fileStat.size > maxFileSize) {
    continue;
  }

  const content = await readFile(absolutePath, 'utf8');
  if (content.includes('\u0000')) {
    continue;
  }

  scannedFileCount += 1;
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    credentialAssignment.lastIndex = 0;
    for (const match of line.matchAll(credentialAssignment)) {
      const value = match.slice(1).find((part) => part !== undefined) ?? '';
      const extension = path.extname(relativePath).toLowerCase();
      const isUnquotedExpression = match[4] !== undefined
        && (!configExtensions.has(extension) && !path.basename(relativePath).startsWith('.env')
          || /[.(]/.test(value));
      if (isUnquotedExpression) {
        continue;
      }

      addFinding(findings, seen, relativePath, index + 1, 'Literal de configuración sensible', value);
    }

    xmlCredential.lastIndex = 0;
    for (const match of line.matchAll(xmlCredential)) {
      addFinding(findings, seen, relativePath, index + 1, 'Literal de configuración sensible', match[1]);
    }

    for (const { type, regex } of knownTokenPatterns) {
      regex.lastIndex = 0;
      if (regex.test(line)) {
        addFinding(findings, seen, relativePath, index + 1, type, 'detected-token');
      }
    }
  }
}

findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
const report = {
  repository: process.env.GITHUB_REPOSITORY ?? path.basename(repositoryRoot),
  generated_at: new Date().toISOString(),
  scan_mode: process.env.GITHUB_ACTIONS ? 'push' : 'local',
  scanned_file_count: scannedFileCount,
  finding_count: findings.length,
  findings,
};

function escapeMarkdown(value) {
  return String(value).replace(/[\\`|*_{}\[\]<>]/g, '\\$&');
}

function renderReport() {
  const lines = [
    '# Reporte local de análisis de código',
    '',
    `- Repositorio: \`${escapeMarkdown(report.repository)}\``,
    `- Modo: ${report.scan_mode}`,
    `- Archivos analizados: ${report.scanned_file_count}`,
    `- Hallazgos: ${report.finding_count}`,
    '- El reporte omite los valores detectados y no los envía a servicios externos.',
    '',
  ];

  if (findings.length === 0) {
    lines.push('No se detectaron patrones de credenciales en los archivos examinados.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    '| # | Tipo | Clasificación | Ubicación | Acción recomendada |',
    '|---|---|---|---|---|',
  );
  for (const [index, finding] of findings.entries()) {
    lines.push(
      `| ${index + 1} | ${escapeMarkdown(finding.type)} | ${finding.classification} | \`${escapeMarkdown(finding.path)}:${finding.line}\` | ${escapeMarkdown(finding.recommended_action)} |`,
    );
  }

  lines.push('', '## Criterio de análisis', '', 'Todos los patrones detectados se clasifican conservadoramente como `NO_DISMISS`: la búsqueda local no confirma validez, actividad, revocación ni uso exclusivo en pruebas. Los valores se excluyen del JSON y del Markdown.');
  return `${lines.join('\n')}\n`;
}

await writeFile(outputJsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await writeFile(outputMarkdownPath, renderReport(), { mode: 0o600 });
console.log(`Scanned ${scannedFileCount} source/config files; found ${findings.length} potential credential(s).`);
