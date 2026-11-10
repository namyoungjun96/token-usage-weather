// Claude Code 기록 파일(~/.claude/projects/**/*.jsonl)을 이어 읽어 토큰 사용량을 날짜별로 누적한다.
// 경험치 = input_tokens + output_tokens (캐시 생성·캐시 읽기는 제외), 같은 응답이 여러 줄로 저장되므로 message.id로 중복 제거.
// 상태: ~/.claude/token-usage-weather/state.json (파일별 읽은 위치 + 날짜별 합계). 출력: 요약 JSON 한 줄.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const DIR = path.join(os.homedir(), '.claude', 'token-usage-weather')
const STATE = path.join(DIR, 'state.json')
const LOCK = path.join(DIR, 'lock')
const KST_MS = 9 * 60 * 60 * 1000
const RECENT_IDS = 64
const LOCK_STALE_MS = 10 * 60 * 1000

const kstDate = ms => new Date(ms + KST_MS).toISOString().slice(0, 10)

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    if (s.version === 1) return s
  } catch {}
  return { version: 1, files: {}, daily: {} }
}

function saveState(state) {
  const tmp = `${STATE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, STATE)
}

function listTranscripts(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listTranscripts(p, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

// 파일의 offset 이후 새로 붙은 완결된 줄만 읽어 daily에 더한다.
function readNew(file, rec, daily) {
  const size = fs.statSync(file).size
  if (size < rec.offset) { rec.offset = 0; rec.ids = [] } // 파일이 다시 쓰였으면 처음부터
  if (size === rec.offset) return
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - rec.offset)
    fs.readSync(fd, buf, 0, buf.length, rec.offset)
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) return // 아직 줄이 끝나지 않음
    const seen = new Set(rec.ids)
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.includes('"usage"')) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      const u = j.message?.usage
      const id = j.message?.id
      if (j.type !== 'assistant' || !u || !id || seen.has(id)) continue
      seen.add(id)
      rec.ids.push(id)
      const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
      const ms = Date.parse(j.timestamp)
      if (!tokens || Number.isNaN(ms)) continue
      const day = kstDate(ms)
      daily[day] = (daily[day] ?? 0) + tokens
    }
    if (rec.ids.length > RECENT_IDS) rec.ids = rec.ids.slice(-RECENT_IDS)
    rec.offset += end + 1
  } finally {
    fs.closeSync(fd)
  }
}

function acquireLock() {
  try {
    fs.closeSync(fs.openSync(LOCK, 'wx'))
    return true
  } catch {
    try {
      if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(LOCK, { force: true })
        fs.closeSync(fs.openSync(LOCK, 'wx'))
        return true
      }
    } catch {}
    return false
  }
}

function summarize(state) {
  const now = Date.now()
  const today = kstDate(now)
  const week = []
  for (let i = 6; i >= 0; i--) {
    const date = kstDate(now - i * 24 * 60 * 60 * 1000)
    week.push({ date, tokens: state.daily[date] ?? 0 })
  }
  const days = Object.keys(state.daily).sort()
  const total = days.reduce((sum, d) => sum + state.daily[d], 0)
  return { today: state.daily[today] ?? 0, week, total, since: days[0] ?? today }
}

fs.mkdirSync(DIR, { recursive: true })
const isLocked = acquireLock()
const state = loadState()
if (isLocked) {
  try {
    for (const file of listTranscripts(PROJECTS)) {
      const rec = (state.files[file] ??= { offset: 0, ids: [] })
      try { readNew(file, rec, state.daily) } catch {}
    }
    saveState(state)
  } finally {
    fs.rmSync(LOCK, { force: true })
  }
}
process.stdout.write(JSON.stringify({ ...summarize(state), isStale: !isLocked }))
