// 집계 스크립트 테스트. 실행: node --test tests/
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  RECENT_IDS, emptyState, listTranscripts, localDate, readNew, summarize, tally, utcOffsetMs,
} from '../scripts/tally-core.mjs'

const KST = 9 * 60 * 60 * 1000
const SCRIPT = fileURLToPath(new URL('../scripts/tally.mjs', import.meta.url))

const line = (id, input, output, timestamp = '2026-11-20T03:00:00Z', type = 'assistant') =>
  JSON.stringify({ type, timestamp, message: { id, usage: { input_tokens: input, output_tokens: output } } }) + '\n'

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-test-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const fresh = () => ({ offset: 0, ids: [] })

describe('utcOffsetMs', () => {
  test('defaults to KST when unset, blank or invalid', () => {
    for (const v of [undefined, '', '  ', 'abc', '15', '-20']) assert.equal(utcOffsetMs(v), KST, String(v))
  })
  test('accepts whole and fractional hours', () => {
    assert.equal(utcOffsetMs('0'), 0)
    assert.equal(utcOffsetMs('-5'), -5 * 3_600_000)
    assert.equal(utcOffsetMs('5.5'), 5.5 * 3_600_000)
  })
})

describe('KST date boundary', () => {
  test('14:59Z is still the same KST day, 15:00Z is the next', () => {
    assert.equal(localDate(Date.parse('2026-11-20T14:59:59Z'), KST), '2026-11-20')
    assert.equal(localDate(Date.parse('2026-11-20T15:00:00Z'), KST), '2026-11-21')
  })
  test('readNew buckets lines by KST day, or by a configured offset', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, line('m1', 10, 1, '2026-11-20T14:59:59Z') + line('m2', 20, 2, '2026-11-20T15:00:00Z'))
    const kst = {}
    readNew(f, fresh(), kst)
    assert.deepEqual(kst, { '2026-11-20': 11, '2026-11-21': 22 })
    const utc = {}
    readNew(f, fresh(), utc, { offsetMs: 0 })
    assert.deepEqual(utc, { '2026-11-20': 33 })
  })
})

describe('dedup by message.id', () => {
  test('the same response stored on several lines counts once', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, line('m1', 100, 5) + line('m1', 100, 5) + line('m2', 1, 1))
    const daily = {}
    readNew(f, fresh(), daily)
    assert.deepEqual(daily, { '2026-11-20': 107 })
  })

  test('a repeat appended in a later run is still skipped (ids kept across runs)', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, line('m1', 100, 5))
    const rec = fresh()
    const daily = {}
    readNew(f, rec, daily)
    fs.appendFileSync(f, line('m1', 100, 5) + line('m2', 1, 1))
    readNew(f, rec, daily)
    assert.deepEqual(daily, { '2026-11-20': 107 })
  })

  test(`only the last ${RECENT_IDS} ids are remembered between runs`, () => {
    const f = path.join(dir, 'a.jsonl')
    let text = ''
    for (let i = 0; i <= RECENT_IDS; i++) text += line(`m${i}`, 1, 0)
    fs.writeFileSync(f, text)
    const rec = fresh()
    const daily = {}
    readNew(f, rec, daily)
    assert.equal(rec.ids.length, RECENT_IDS)
    assert.equal(rec.ids[0], 'm1')
    assert.equal(daily['2026-11-20'], RECENT_IDS + 1)
    // m0 fell out of the window, so it counts again; m1 is still inside
    fs.appendFileSync(f, line('m0', 1, 0) + line('m1', 1, 0))
    readNew(f, rec, daily)
    assert.equal(daily['2026-11-20'], RECENT_IDS + 2)
  })

  test('non-assistant lines, missing usage and zero tokens are ignored', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, line('u1', 50, 50, undefined, 'user') + line('m1', 0, 0) + '{"usage": broken\n' + line('m2', 3, 4))
    const daily = {}
    readNew(f, fresh(), daily)
    assert.deepEqual(daily, { '2026-11-20': 7 })
  })
})

describe('offset', () => {
  test('a trailing unfinished line is left for the next run', () => {
    const f = path.join(dir, 'a.jsonl')
    const first = line('m1', 10, 0)
    const second = line('m2', 20, 0)
    fs.writeFileSync(f, first + second.slice(0, 15))
    const rec = fresh()
    const daily = {}
    readNew(f, rec, daily)
    assert.equal(rec.offset, Buffer.byteLength(first))
    assert.deepEqual(daily, { '2026-11-20': 10 })
    fs.appendFileSync(f, second.slice(15))
    readNew(f, rec, daily)
    assert.equal(rec.offset, Buffer.byteLength(first + second))
    assert.deepEqual(daily, { '2026-11-20': 30 })
  })

  test('a rewritten (shorter) file is read again from the start', () => {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, line('m1', 1000, 0) + line('m2', 1000, 0))
    const rec = fresh()
    const daily = {}
    readNew(f, rec, daily)
    fs.writeFileSync(f, line('m1', 5, 0))
    readNew(f, rec, daily)
    assert.equal(rec.offset, Buffer.byteLength(line('m1', 5, 0)))
    assert.deepEqual(rec.ids, ['m1'])
    assert.deepEqual(daily, { '2026-11-20': 2005 })
  })
})

describe('chunked reading', () => {
  test('lines split across chunk boundaries (including inside a multibyte char) are joined', () => {
    const f = path.join(dir, 'a.jsonl')
    const lines = []
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ type: 'assistant', timestamp: '2026-11-20T03:00:00Z', note: '한글'.repeat(i), message: { id: `m${i}`, usage: { input_tokens: i + 1, output_tokens: 0 } } }) + '\n')
    }
    const text = lines.join('')
    fs.writeFileSync(f, text)
    const expected = (20 * 21) / 2
    for (const chunkSize of [1, 7, 64, 100, 4096]) {
      const rec = fresh()
      const daily = {}
      readNew(f, rec, daily, { chunkSize })
      assert.deepEqual(daily, { '2026-11-20': expected }, `chunkSize ${chunkSize}`)
      assert.equal(rec.offset, Buffer.byteLength(text), `chunkSize ${chunkSize}`)
    }
  })

  test('offset stops at the last complete line even when the tail spans chunks', () => {
    const f = path.join(dir, 'a.jsonl')
    const done = line('m1', 10, 0)
    fs.writeFileSync(f, done + line('m2', 20, 0).slice(0, -1)) // no final newline
    const rec = fresh()
    const daily = {}
    readNew(f, rec, daily, { chunkSize: 8 })
    assert.equal(rec.offset, Buffer.byteLength(done))
    assert.deepEqual(daily, { '2026-11-20': 10 })
  })
})

describe('tally', () => {
  test('entries for deleted transcripts are dropped, daily totals stay', () => {
    const a = path.join(dir, 'a.jsonl')
    const b = path.join(dir, 'b.jsonl')
    fs.writeFileSync(a, line('m1', 10, 0))
    fs.writeFileSync(b, line('m2', 20, 0))
    const state = emptyState()
    tally(state, listTranscripts(dir))
    assert.deepEqual(Object.keys(state.files).sort(), [a, b])
    fs.rmSync(b)
    tally(state, listTranscripts(dir))
    assert.deepEqual(Object.keys(state.files), [a])
    assert.deepEqual(state.daily, { '2026-11-20': 30 })
  })

  test('an entry not listed but still on disk is kept (no re-count later)', () => {
    const a = path.join(dir, 'a.jsonl')
    fs.writeFileSync(a, line('m1', 10, 0))
    const state = emptyState()
    tally(state, [a])
    tally(state, []) // e.g. its folder could not be listed this time
    assert.ok(state.files[a])
    tally(state, [a])
    assert.deepEqual(state.daily, { '2026-11-20': 10 })
  })

  test('a file that fails to read is reported and the rest still counts', () => {
    const a = path.join(dir, 'a.jsonl')
    fs.writeFileSync(a, line('m1', 10, 0))
    const state = emptyState()
    const errors = tally(state, [path.join(dir, 'missing.jsonl'), a])
    assert.equal(errors.length, 1)
    assert.match(errors[0], /missing\.jsonl/)
    assert.deepEqual(state.daily, { '2026-11-20': 10 })
  })
})

test('summarize gives today, the last 7 days, total and first day', () => {
  const state = { ...emptyState(), daily: { '2026-11-01': 5, '2026-11-20': 7, '2026-11-21': 3 } }
  const s = summarize(state, Date.parse('2026-11-21T01:00:00Z'), KST)
  assert.equal(s.today, 3)
  assert.equal(s.total, 15)
  assert.equal(s.since, '2026-11-01')
  assert.deepEqual(s.week.map(d => d.date), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'])
  assert.deepEqual(s.week.map(d => d.tokens), [0, 0, 0, 0, 0, 7, 3])
})

test('the script reads ~/.claude/projects, saves state and prints a summary', () => {
  const projects = path.join(dir, '.claude', 'projects', 'p')
  fs.mkdirSync(projects, { recursive: true })
  const now = new Date().toISOString()
  fs.writeFileSync(path.join(projects, 's.jsonl'), line('m1', 10, 2, now) + line('m1', 10, 2, now))
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, TOKEN_USAGE_WEATHER_UTC_OFFSET: '0' }
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' }))
  assert.equal(out.today, 12)
  assert.equal(out.total, 12)
  assert.equal(out.isStale, false)
  assert.equal(out.week.at(-1).date, now.slice(0, 10))
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'token-usage-weather', 'state.json'), 'utf8'))
  assert.equal(Object.keys(state.files).length, 1)
})
