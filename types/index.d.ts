export type DayUsage = { date: string; tokens: number }

export type Summary = {
  today: number
  week: DayUsage[]
  total: number
  since: string
}

// 구독 한도 사용률(0~100). 값이 없으면 null (API 키 사용, 첫 응답 전).
export type Limits = {
  fiveHour: number | null
  weekly: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-usage-weather': { summary: Summary | null; limits: Limits | null }
  }
}
