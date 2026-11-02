import { readFile, writeFile } from 'node:fs/promises'

const [vulnerabilityRawPath, secretRawPath, outputPath, image, platform, vulnerabilityExitCodeText, secretExitCodeText] = process.argv.slice(2)
if (!vulnerabilityRawPath || !secretRawPath || !outputPath || !image || !/^linux\/(amd64|arm64)$/u.test(platform ?? '') ||
  !/^\d+$/u.test(vulnerabilityExitCodeText ?? '') || !/^\d+$/u.test(secretExitCodeText ?? '')) {
  throw new Error('Usage: node sanitize-trivy-report.mjs VULNERABILITY_RAW SECRET_RAW OUTPUT IMAGE linux/ARCH VULN_EXIT SECRET_EXIT')
}

const vulnerabilityExitCode = Number(vulnerabilityExitCodeText)
const secretExitCode = Number(secretExitCodeText)
async function readResults(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.Results)) throw new Error('schema')
    return { results: raw.Results, valid: true }
  } catch {
    return { results: [], valid: false }
  }
}
const vulnerabilityReport = await readResults(vulnerabilityRawPath)
const secretReport = await readResults(secretRawPath)

const vulnerabilities = vulnerabilityReport.results.flatMap(result => Array.isArray(result?.Vulnerabilities) ? result.Vulnerabilities : [])
  .map(row => ({
    cve: typeof row.VulnerabilityID === 'string' ? row.VulnerabilityID : 'UNKNOWN',
    component: typeof row.PkgName === 'string' ? row.PkgName : 'UNKNOWN',
    version: typeof row.InstalledVersion === 'string' ? row.InstalledVersion : 'UNKNOWN',
    severity: typeof row.Severity === 'string' ? row.Severity.toUpperCase() : 'UNKNOWN',
    fixed_version: typeof row.FixedVersion === 'string' ? row.FixedVersion : '',
  }))
  .sort((left, right) => [left.cve, left.component, left.version, left.severity, left.fixed_version]
    .join('\0').localeCompare([right.cve, right.component, right.version, right.severity, right.fixed_version].join('\0')))
const secretFindings = secretReport.results.flatMap(result => Array.isArray(result?.Secrets) ? result.Secrets : [])
  .map(row => ({
    rule_id: typeof row.RuleID === 'string' ? row.RuleID : 'UNKNOWN',
    category: typeof row.Category === 'string' ? row.Category : 'UNKNOWN',
    severity: typeof row.Severity === 'string' ? row.Severity.toUpperCase() : 'UNKNOWN',
  }))
  .sort((left, right) => [left.rule_id, left.category, left.severity].join('\0')
    .localeCompare([right.rule_id, right.category, right.severity].join('\0')))

const highCriticalCount = vulnerabilities.filter(row => row.severity === 'HIGH' || row.severity === 'CRITICAL').length
const scannerErrors = []
if (!vulnerabilityReport.valid) scannerErrors.push('Trivy vulnerability scan did not emit valid JSON; raw scanner output is intentionally omitted.')
if (!secretReport.valid) scannerErrors.push('Trivy secret scan did not emit valid JSON; raw scanner output is intentionally omitted.')
if (vulnerabilityExitCode !== 0) scannerErrors.push(`Trivy vulnerability scan exited with status ${vulnerabilityExitCode}.`)
if (secretExitCode !== 0) scannerErrors.push(`Trivy secret scan exited with status ${secretExitCode}.`)
const gate = scannerErrors.length || highCriticalCount || secretFindings.length ? 'blocked' : 'passed'

await writeFile(outputPath, `${JSON.stringify({
  schema_version: 1,
  scanner: 'trivy',
  image,
  platform,
  gate,
  scanner_errors: scannerErrors,
  high_critical_count: highCriticalCount,
  secret_finding_count: secretFindings.length,
  vulnerabilities,
  secret_findings: secretFindings,
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
