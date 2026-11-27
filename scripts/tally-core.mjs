// Claude Code 기록 파일(~/.claude/projects/**/*.jsonl)을 이어 읽어 토큰 사용량을 날짜별로 누적한다.
// 경험치 = input_tokens + output_tokens (캐시 생성·캐시 읽기는 제외), 같은 응답이 여러 줄로 저장되므로 message.id로 중복 제거.
// 상태: ~/.claude/token-usage-weather/state.json (파일별 읽은 위치 + 날짜별 합계). 출력: 요약 JSON 한 줄.
// 날짜 경계는 기본 한국 시간(UTC+9). TOKEN_USAGE_WEATHER_UTC_OFFSET(시간 단위, 예: 0, -5, 5.5)으로 바꿀 수 있다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
export const DEFAULT_UTC_OFFSET_HOURS = 9
export const RECENT_IDS = 64
export const CHUNK_SIZE = 1024 * 1024
const LOCK_STALE_MS = 10 * 60 * 1000

// 환경변수 값(시간)을 밀리초로. 비었거나 숫자가 아니거나 범위(-14~+14) 밖이면 기본값.
export function utcOffsetMs(value) {
  const hours = value === undefined || value.trim() === '' ? NaN : Number(value)
  if (!Number.isFinite(hours) || hours < -14 || hours > 14) return DEFAULT_UTC_OFFSET_HOURS * HOUR_MS
  return Math.round(hours * HOUR_MS)
}

export const localDate = (ms, offsetMs) => new Date(ms + offsetMs).toISOString().slice(0, 10)

export const emptyState = () => ({ version: 1, files: {}, daily: {} })

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (s.version === 1) return s
  } catch {}
  return emptyState()
}

function saveState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
}

export function listTranscripts(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listTranscripts(p, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

// 한 줄을 해석해 assistant 응답의 사용량이면 daily에 더한다.
function countLine(line, seen, rec, daily, offsetMs) {
  if (!line.includes('"usage"')) return
  let j
  try { j = JSON.parse(line) } catch { return }
  const u = j.message?.usage
  const id = j.message?.id
  if (j.type !== 'assistant' || !u || !id || seen.has(id)) return
  seen.add(id)
  rec.ids.push(id)
  const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
  const ms = Date.parse(j.timestamp)
  if (!tokens || Number.isNaN(ms)) return
  const day = localDate(ms, offsetMs)
  daily[day] = (daily[day] ?? 0) + tokens
}

// 파일의 offset 이후 새로 붙은 완결된 줄만 chunkSize 단위로 읽어 daily에 더한다.
// 청크 경계에 걸친 줄은 다음 청크와 이어 붙이고, offset은 완결된 줄 끝까지만 전진한다.
export function readNew(file, rec, daily, { offsetMs = DEFAULT_UTC_OFFSET_HOURS * HOUR_MS, chunkSize = CHUNK_SIZE } = {}) {
  const size = fs.statSync(file).size
  if (size < rec.offset) { rec.offset = 0; rec.ids = [] } // 파일이 다시 쓰였으면 처음부터
  if (size === rec.offset) return
  const fd = fs.openSync(file, 'r')
  const seen = new Set(rec.ids)
  try {
    const chunk = Buffer.allocUnsafe(chunkSize)
    let pos = rec.offset // 다음에 읽을 파일 위치
    let carry = Buffer.alloc(0) // 아직 줄바꿈을 만나지 못한 앞 청크의 꼬리
    while (pos < size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunkSize, size - pos), pos)
      if (n <= 0) break // 읽는 사이 파일이 줄었다
      pos += n
      const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n)
      let start = 0
      for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, start)) {
        countLine(data.toString('utf8', start, nl), seen, rec, daily, offsetMs)
        start = nl + 1
      }
      // data는 offset 위치부터 시작하므로(carry 포함) 완결된 줄의 끝 = offset + start
      rec.offset += start
      carry = Buffer.from(data.subarray(start)) // chunk는 재사용되므로 복사
    }
  } finally {
    if (rec.ids.length > RECENT_IDS) rec.ids = rec.ids.slice(-RECENT_IDS)
    fs.closeSync(fd)
  }
}

// 지금 있는 기록 파일을 모두 이어 읽고, 사라진 파일의 항목은 state.files에서 지운다.
// 날짜별 합계(daily)는 그대로 둔다. 목록에 없더라도 파일이 실제로 남아 있으면(하위 폴더를 못 읽은 경우 등) 지우지 않는다.
export function tally(state, files, opts = {}) {
  const errors = []
  for (const file of files) {
    const rec = (state.files[file] ??= { offset: 0, ids: [] })
    try { readNew(file, rec, state.daily, opts) } catch (err) { errors.push(`${file}: ${err.message}`) }
  }
  const listed = new Set(files)
  for (const file of Object.keys(state.files)) {
    if (listed.has(file)) continue
    try { fs.statSync(file) } catch (err) {
      if (err.code === 'ENOENT') delete state.files[file]
    }
  }
  return errors
}

export function summarize(state, now, offsetMs) {
  const today = localDate(now, offsetMs)
  const week = []
  for (let i = 6; i >= 0; i--) {
    const date = localDate(now - i * DAY_MS, offsetMs)
    week.push({ date, tokens: state.daily[date] ?? 0 })
  }
  const days = Object.keys(state.daily).sort()
  const total = days.reduce((sum, d) => sum + state.daily[d], 0)
  return { today: state.daily[today] ?? 0, week, total, since: days[0] ?? today }
}

function acquireLock(lock) {
  try {
    fs.closeSync(fs.openSync(lock, 'wx'))
    return true
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true })
        fs.closeSync(fs.openSync(lock, 'wx'))
        return true
      }
    } catch {}
    return false
  }
}

// scripts/tally.mjs가 실행하는 진입점. 테스트는 위의 함수들을 직접 부른다.
export function main() {
  const projects = path.join(os.homedir(), '.claude', 'projects')
  const dir = path.join(os.homedir(), '.claude', 'token-usage-weather')
  const stateFile = path.join(dir, 'state.json')
  const lock = path.join(dir, 'lock')
  const offsetMs = utcOffsetMs(process.env.TOKEN_USAGE_WEATHER_UTC_OFFSET)

  fs.mkdirSync(dir, { recursive: true })
  const isLocked = acquireLock(lock)
  const state = loadState(stateFile)
  if (isLocked) {
    try {
      for (const error of tally(state, listTranscripts(projects), { offsetMs })) {
        process.stderr.write(`tally: ${error}\n`)
      }
      saveState(stateFile, state)
    } finally {
      fs.rmSync(lock, { force: true })
    }
  }
  process.stdout.write(JSON.stringify({ ...summarize(state, Date.now(), offsetMs), isStale: !isLocked }))
}
