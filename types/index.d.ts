export type DayUsage = { date: string; tokens: number }

export type Summary = {
  today: number
  week: DayUsage[]
  total: number
  since: string
}

declare module 'claude-code' {
  interface PluginState {
    'token-usage-weather': { summary: Summary | null }
  }
}
