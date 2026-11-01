#!/usr/bin/env node
// hooks/transitions.json is the one table of allowed Todo.status moves. A
// hooks module can't import JSON (`claude plugin validate` refuses a file not
// named like code), so the mod's guard reads a mirror of it, TABLE in
// hooks/transitions.ts, which this script writes from the JSON.
//
//   node scripts/transitions.mjs           checks the mirror is the JSON, as written
//   node scripts/transitions.mjs --write   writes the mirror from the JSON
//
// Exits 1 when the check finds them apart.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const json = fileURLToPath(new URL('../hooks/transitions.json', import.meta.url))
const mirror = fileURLToPath(new URL('../hooks/transitions.ts', import.meta.url))

export function mirrorText() {
  const table = JSON.parse(readFileSync(json, 'utf8'))
  return `// Written by \`node scripts/transitions.mjs --write\` from hooks/transitions.json,
// the one table of allowed Todo.status moves; never edit it by hand. That
// script, run without --write, checks the two are identical (CI runs it).
import type { TodoStatus } from '../types'

// [*] is before the todo exists (from) or after it is removed (to).
export type End = TodoStatus | '[*]'
export type Move = { from: End; to: End; by: string; at: string }

export const TABLE: { about: string; transitions: Move[] } = ${JSON.stringify(table, null, 2)}
`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const want = mirrorText()
  if (process.argv.includes('--write')) {
    writeFileSync(mirror, want)
    console.log('hooks/transitions.ts written from hooks/transitions.json')
  } else {
    let have = ''
    try {
      have = readFileSync(mirror, 'utf8')
    } catch {
      // missing: reported below
    }
    if (have !== want) {
      console.error('hooks/transitions.ts is not hooks/transitions.json: run node scripts/transitions.mjs --write')
      process.exit(1)
    }
    console.log('hooks/transitions.ts mirrors hooks/transitions.json')
  }
}
