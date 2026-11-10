import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Limits, Summary } from '../types'

const summary = atom({ plugin: 'token-usage-weather', key: 'summary' } as const, null)
const limits = atom({ plugin: 'token-usage-weather', key: 'limits' } as const, null)

// 오늘 사용량(캐시 제외 input + output) 기준 날씨
const FORECASTS = [
  { below: 30_000, icon: '☀', word: '맑음', color: '#f2c94c' },
  { below: 100_000, icon: '☁', word: '구름', color: '#9aa5b1' },
  { below: 200_000, icon: '☂', word: '비', color: '#56a3e8' },
  { below: 300_000, icon: '☇', word: '폭풍', color: '#a78bfa' },
  { below: Infinity, icon: '↯', word: '태풍', color: '#f2685c' },
]
const SPARKS = '▁▂▃▄▅▆▇█'
const WIDE = 64

// 한도 사용률: 50% 미만 기본색, 80% 미만 노랑, 그 이상 빨강 + 특보
const WARN = 80
const ALERT = 95
const MOONS = ['○', '◔', '◑', '◕', '●']

const forecast = (tokens: number) => FORECASTS.find(f => tokens < f.below)!

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `${Math.round(n / 1_000)}k`
      : `${n}`

const sparkline = (values: number[]) => {
  const max = Math.max(...values, 1)
  return values.map(v => SPARKS[Math.min(SPARKS.length - 1, Math.floor((v / max) * SPARKS.length))]).join('')
}

const daysSince = (since: string, today: string) =>
  Math.round((Date.parse(today) - Date.parse(since)) / 86_400_000) + 1

const levelColor = (pct: number) =>
  pct >= WARN ? '#f2685c' : pct >= 50 ? '#f2c94c' : undefined

// 주간 한도는 달 모양: 많이 쓸수록 달이 찬다
const moon = (pct: number) =>
  MOONS[Math.max(0, Math.min(MOONS.length - 1, Math.round((pct / 100) * (MOONS.length - 1))))]

const percent = (pct: number) => `${Math.round(pct)}%`

const toLimits = (windows: SessionRateLimit[]): Limits => ({
  fiveHour: windows.find(w => w.kind === 'five_hour')?.percentUsed ?? null,
  weekly: windows.find(w => w.kind === 'seven_day')?.percentUsed ?? null,
})

let isRefreshing = false

// 기록 파일을 집계하는 스크립트를 돌려 요약을 세션 상태에 넣는다. 실패하면 직전 값을 둔다.
async function refresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const script = `${$.plugin.root}/scripts/tally.mjs`
    const { exitCode, stdout } = await $.process.run(['node', script], { timeoutMs: 120_000 })
    if (exitCode !== 0) return
    const { today, week, total, since } = JSON.parse(stdout) as Summary
    await update($, summary, () => ({ today, week, total, since }))
  } catch {
  } finally {
    isRefreshing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    try {
      const { rateLimits } = await $.session.usage()
      if (rateLimits.length > 0) await update($, limits, () => toLimits(rateLimits))
    } catch {
    }
    return result
  })

  // 한도 사용률은 응답마다 엔진이 알려 준다
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => toLimits(e.rateLimits))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) void refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, summary)
    if (e.props.hasSurvey || s === null) {
      return next(e)
    }
    const l = await read($, limits)

    const { Box, Text } = $.ui.resolve(e)
    const f = forecast(s.today)
    const today = s.week.at(-1)?.date ?? s.since
    const isWide = e.props.bodyColumns >= WIDE
    const fiveHour = l?.fiveHour ?? null
    const weekly = l?.weekly ?? null

    return (
      <Box>
        <Text color={f.color} bold>{f.icon} {f.word}</Text>
        <Text>{'  '}오늘 {compact(s.today)}</Text>
        {isWide ? <Text color={f.color}>{'  '}{sparkline(s.week.map(d => d.tokens))}</Text> : null}
        <Text dimColor>{'  │  '}</Text>
        <Text>누적 {compact(s.total)}</Text>
        {isWide ? <Text dimColor>{'  '}(D+{daysSince(s.since, today)})</Text> : null}
        {fiveHour !== null || weekly !== null ? <Text dimColor>{'  │  '}</Text> : null}
        {fiveHour === null ? null
          : fiveHour >= WARN
            ? <Text color={levelColor(fiveHour)} bold>⚠ {fiveHour >= ALERT ? '호우경보' : '호우주의보'} {percent(fiveHour)}</Text>
            : <Text color={levelColor(fiveHour)}>강수 {percent(fiveHour)}</Text>}
        {fiveHour !== null && weekly !== null ? <Text>{'  '}</Text> : null}
        {weekly === null ? null
          : <Text color={levelColor(weekly)} bold={weekly >= WARN}>
              {weekly >= WARN ? '⚠ ' : ''}{moon(weekly)} {isWide ? '주간 ' : ''}{percent(weekly)}
            </Text>}
      </Box>
    )
  })
}
