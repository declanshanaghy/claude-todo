#!/usr/bin/env node
// Writes the README's computed badges as shields.io endpoint JSON, one file
// each, into <dir>: the tests tally and coverage gate of CI's latest run on
// main and CI's pass rate, from the GitHub API through `gh api` (GH_TOKEN),
// and `npm audit` of the checkout. Behaviour coverage comes from
// `scripts/coverage.mjs --badge`.
//
//   node scripts/badges.mjs <dir>
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/badges.mjs <dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })
const repo = process.env.GITHUB_REPOSITORY || 'declanshanaghy/claude-todo'
const WINDOW = 50 // CI runs on main the pass rate looks back over

const badge = (name, label, message, color) => {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ schemaVersion: 1, label, message: String(message), color })}\n`)
  console.log(`${name}: ${label} | ${message}`)
}
const api = (path) => JSON.parse(execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], { encoding: 'utf8' }))
const rateColor = (pct) => (pct >= 95 ? 'brightgreen' : pct >= 85 ? 'green' : pct >= 70 ? 'yellow' : 'red')

// CI on main: the pass rate, and the coverage gate and tests of the latest run.
const recent = api(`repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=${WINDOW}`).workflow_runs
const runs = recent.filter((r) => r.conclusion !== 'cancelled' && r.conclusion !== 'skipped')
if (runs.length) {
  const passed = runs.filter((r) => r.conclusion === 'success').length
  const pct = Math.round((passed / runs.length) * 1000) / 10
  badge('ci-pass-rate', 'CI pass rate', `${pct}% of last ${runs.length}`, rateColor(pct))

  const jobs = api(`repos/${repo}/actions/runs/${runs[0].id}/jobs?per_page=100`).jobs
  const gate = jobs.find((j) => j.name === 'Behaviour coverage')
  if (!gate) badge('check-coverage', 'coverage gate', 'not run', 'lightgrey')
  else if (gate.conclusion === 'success') badge('check-coverage', 'coverage gate', 'passing', 'brightgreen')
  else badge('check-coverage', 'coverage gate', gate.conclusion || gate.status, 'red')

  // The kit's own tally from the Tests job's log: "N pass" and "N fail".
  const tests = jobs.find((j) => j.name === 'Tests')
  if (tests) {
    // Fetched directly: newer gh refuses to print a log's colour codes, and
    // older gh has no flag to allow them.
    const token = process.env.GH_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${tests.id}/logs`, { headers: { Authorization: `Bearer ${token}` } })
    const log = res.ok ? await res.text() : ''
    const pass = /\s(\d+) pass\s*$/m.exec(log)?.[1]
    const fail = /\s(\d+) fail\s*$/m.exec(log)?.[1]
    if (pass !== undefined) {
      const failing = Number(fail ?? 0)
      badge('tests', 'tests', failing ? `${pass} passed · ${failing} failed` : `${pass} passed`, failing ? 'red' : 'brightgreen')
    }
  }
}

// The checkout's dependencies, all of them dev-only.
let audit
try {
  audit = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8' })
} catch (e) {
  audit = e.stdout // npm audit exits non-zero when it finds any
}
const vulns = JSON.parse(audit).metadata?.vulnerabilities
if (vulns) {
  const found = ['critical', 'high', 'moderate', 'low'].filter((k) => vulns[k]).map((k) => `${vulns[k]} ${k}`)
  badge('npm-audit', 'npm audit', found.length ? found.join(' · ') : 'clean', vulns.critical || vulns.high ? 'red' : found.length ? 'yellow' : 'brightgreen')
}
