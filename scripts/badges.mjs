#!/usr/bin/env node
// Writes the README's computed badges as shields.io endpoint JSON, one file
// each, into <dir>. CI's numbers come from the GitHub API through `gh api`
// (GH_TOKEN), the rest from the checkout itself.
//
//   node scripts/badges.mjs <dir>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/badges.mjs <dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })
const repo = process.env.GITHUB_REPOSITORY || 'declanshanaghy/claude-todo'
const WINDOW = 50 // CI runs on main the pass rate and median look back over
// Badge file and label for each of ci.yml's check jobs, by the job's name.
const CHECKS = {
  'Lint (ESLint)': ['check-lint', 'lint'],
  'Typecheck (strict tsc)': ['check-typecheck', 'typecheck'],
  'Plugin validate': ['check-validate', 'plugin validate'],
  Tests: ['check-test', 'tests'],
  'Behaviour coverage': ['check-coverage', 'coverage check'],
}

const badge = (name, label, message, color) => {
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ schemaVersion: 1, label, message: String(message), color })}\n`)
  console.log(`${name}: ${label} | ${message}`)
}
const api = (path) => JSON.parse(execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], { encoding: 'utf8' }))
const seconds = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))
const duration = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`)
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}
const rateColor = (pct) => (pct >= 95 ? 'brightgreen' : pct >= 85 ? 'green' : pct >= 70 ? 'yellow' : 'red')

// CI on main: pass rate, streak, durations, and each check of the latest run.
const recent = api(`repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=${WINDOW}`).workflow_runs
const runs = recent.filter((r) => r.conclusion !== 'cancelled' && r.conclusion !== 'skipped')
if (runs.length) {
  const passed = runs.filter((r) => r.conclusion === 'success')
  const pct = Math.round((passed.length / runs.length) * 1000) / 10
  badge('ci-pass-rate', 'CI pass rate', `${pct}% of last ${runs.length}`, rateColor(pct))

  let streak = 0
  while (streak < runs.length && runs[streak].conclusion === 'success') streak++
  badge('ci-streak', 'green streak', `${streak}${streak === runs.length && recent.length === WINDOW ? '+' : ''} runs`, streak >= 10 ? 'brightgreen' : streak > 0 ? 'green' : 'red')

  const last = runs[0]
  badge('ci-last-duration', 'last CI run', duration(seconds(last.run_started_at, last.updated_at)), 'blue')
  if (passed.length) badge('ci-median-duration', 'median CI run', duration(median(passed.map((r) => seconds(r.run_started_at, r.updated_at)))), 'blue')

  const jobs = api(`repos/${repo}/actions/runs/${last.id}/jobs?per_page=100`).jobs
  for (const [name, [file, label]] of Object.entries(CHECKS)) {
    const job = jobs.find((j) => j.name === name)
    if (!job) badge(file, label, 'not run', 'lightgrey')
    else if (job.conclusion === 'success') badge(file, label, `passing · ${duration(seconds(job.started_at, job.completed_at))}`, 'brightgreen')
    else badge(file, label, job.conclusion || job.status, 'red')
  }

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
      badge('tests', 'plugin tests', failing ? `${pass} passed · ${failing} failed` : `${pass} passed`, failing ? 'red' : 'brightgreen')
    }
  }
}

// Every CI run, any branch or event, started in the last 7 days.
const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)
const week = api(`repos/${repo}/actions/workflows/ci.yml/runs?created=>=${since}&per_page=1`).total_count
badge('ci-runs-week', 'CI runs this week', week, week ? 'blue' : 'lightgrey')

// The checkout: strictness, dependencies, audit, size.
const tsconfig = readFileSync('tsconfig.json', 'utf8').replace(/^\s*\/\/.*$/gm, '')
// Each option set the strict way: a check on, or an allow* off.
const flags = Object.entries(JSON.parse(tsconfig).compilerOptions).filter(([k, v]) => v === !k.startsWith('allow')).length
badge('tsc-strict', 'tsc strict', `${flags} flags on`, 'blue')

const sets = [...new Set([...readFileSync('eslint.config.js', 'utf8').matchAll(/tseslint\.configs\.(\w+TypeChecked)\b/g)].map((m) => m[1]))]
  .filter((s) => s !== 'disableTypeChecked')
  .map((s) => s.replace(/TypeChecked$/, '-type-checked').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
badge('eslint', 'typescript-eslint', sets.join(' + '), 'blueviolet')

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const runtime = Object.keys(pkg.dependencies ?? {}).length
badge('deps', 'dependencies', `${runtime} runtime · ${Object.keys(pkg.devDependencies ?? {}).length} dev`, runtime ? 'blue' : 'brightgreen')

let audit
try {
  audit = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8' })
} catch (e) {
  audit = e.stdout // npm audit exits non-zero when it finds any
}
const vulns = JSON.parse(audit).metadata?.vulnerabilities
if (vulns) {
  const found = ['critical', 'high', 'moderate', 'low'].filter((k) => vulns[k]).map((k) => `${vulns[k]} ${k}`)
  badge('npm-audit', 'npm audit (dev)', found.length ? found.join(' · ') : 'clean', vulns.critical || vulns.high ? 'red' : found.length ? 'yellow' : 'brightgreen')
}

const lines = (dir, test) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.tsx?$/.test(f) && /\.test\.tsx?$/.test(f) === test && statSync(join(dir, f)).isFile())
    .reduce((n, f) => n + readFileSync(join(dir, f), 'utf8').split('\n').length, 0)
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
badge('loc', 'TypeScript lines', `${k(lines('hooks', false))} mod · ${k(lines('hooks', true))} tests`, 'blue')

badge('node', 'node (CI)', process.version, 'green')
