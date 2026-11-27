export type DayUsage = { date: string; tokens: number }

export type Summary = {
  today: number
  week: DayUsage[]
  total: number
  since: string
  // 다른 세션이 집계 중이어서 저장된 값만 읽었으면 true (값이 조금 늦을 수 있음)
  // (이 필드가 생기기 전 버전이 남긴 값에는 없다)
  isStale?: boolean
}

// 구독 한도 사용률(0~100). 값이 없으면 null (API 키 사용, 첫 응답 전).
export type Limits = {
  fiveHour: number | null
  weekly: number | null
}

declare module 'claude-code' {
  interface PluginState {
    // refreshError: 마지막 집계가 실패했으면 그 이유, 성공했으면 null
    'token-usage-weather': { summary: Summary | null; limits: Limits | null; refreshError: string | null }
  }
}
