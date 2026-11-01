#!/usr/bin/env node
// Behaviour coverage: counts the cases in docs/test-cases.md, covered against
// "not covered", and checks the ratio the doc states at its top.
//
//   node scripts/coverage.mjs [--badge <file>]
//
// Fails when the stated ratio is off, an ID repeats, or coverage is under the
// floor. Writes a summary to $GITHUB_STEP_SUMMARY when set, and with --badge a
// shields.io endpoint JSON for the README.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FLOOR = 95
const doc = fileURLToPath(new URL('../docs/test-cases.md', import.meta.url))
const text = readFileSync(doc, 'utf8')

const cases = []
const errors = []
for (const line of text.split('\n')) {
  if (!line.startsWith('|') || /^\|\s*(ID\s*\||-)/.test(line)) continue
  // A case row: | ID | Behaviour | Covered by |, its ID a letter or two, a
  // number and maybe a lowercase suffix (E1a). Any other row would go
  // uncounted, so it fails.
  const cells = /^\|\s*([A-Z]{1,2}\d+[a-z]?)\s*\|(.*)\|\s*$/.exec(line)
  if (!cells) {
    errors.push(`a table row has no case ID: ${line.slice(0, 60)}`)
    continue
  }
  const by = cells[2].split('|').at(-1).trim()
  cases.push({ id: cells[1], covered: by !== '' && !/^not covered\b/i.test(by) })
}

const seen = new Set()
for (const { id } of cases) {
  if (seen.has(id)) errors.push(`case ${id} appears twice`)
  seen.add(id)
}

const total = cases.length
const covered = cases.filter((c) => c.covered).length
const pct = total ? Math.round((covered / total) * 1000) / 10 : 0
const uncovered = cases.filter((c) => !c.covered).map((c) => c.id)

const stated = /\*\*Coverage: (\d+) of (\d+) cases \(([\d.]+)%\)\*\*/.exec(text)
if (!stated) errors.push('the "**Coverage: X of Y cases (Z%)**" line is missing')
else if (Number(stated[1]) !== covered || Number(stated[2]) !== total || Number(stated[3]) !== pct) {
  errors.push(`the doc states ${stated[1]} of ${stated[2]} (${stated[3]}%); the rows count ${covered} of ${total} (${pct}%)`)
}
if (pct < FLOOR) errors.push(`coverage ${pct}% is under the ${FLOOR}% floor`)

const line = `Coverage: ${covered} of ${total} cases (${pct}%)`
console.log(line)
if (uncovered.length) console.log(`Not covered: ${uncovered.join(', ')}`)

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Behaviour coverage\n\n**${line}**${uncovered.length ? `, not covered: ${uncovered.join(', ')}` : ''}\n\n` +
      (errors.length ? errors.map((e) => `- :x: ${e}`).join('\n') + '\n' : ''),
  )
}

const badge = process.argv.indexOf('--badge')
if (badge !== -1) {
  const file = process.argv[badge + 1]
  if (!file) errors.push('--badge needs a file')
  else {
    const color = errors.length ? 'red' : pct >= 99 ? 'brightgreen' : 'green'
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, label: 'behaviour coverage', message: `${pct}% (${covered}/${total})`, color })}\n`)
  }
}

const mark = process.env.GITHUB_ACTIONS ? '::error file=docs/test-cases.md::' : 'error: '
for (const e of errors) console.error(mark + e)
process.exit(errors.length ? 1 : 0)
