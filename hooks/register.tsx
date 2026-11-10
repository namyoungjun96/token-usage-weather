import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Summary } from '../types'

const summary = atom({ plugin: 'token-usage-weather', key: 'summary' } as const, null)

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
    return result
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

    const { Box, Text } = $.ui.resolve(e)
    const f = forecast(s.today)
    const today = s.week.at(-1)?.date ?? s.since
    const isWide = e.props.bodyColumns >= WIDE

    return (
      <Box>
        <Text color={f.color} bold>{f.icon} {f.word}</Text>
        <Text>{'  '}오늘 {compact(s.today)}</Text>
        {isWide ? <Text color={f.color}>{'  '}{sparkline(s.week.map(d => d.tokens))}</Text> : null}
        <Text dimColor>{'  │  '}</Text>
        <Text>누적 {compact(s.total)}</Text>
        {isWide ? <Text dimColor>{'  '}(D+{daysSince(s.since, today)})</Text> : null}
      </Box>
    )
  })
}
