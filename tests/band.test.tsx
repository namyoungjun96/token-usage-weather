import { expect, test } from 'claude-code/testing'

const SUMMARY = {
  today: 140_000,
  week: [{ date: '2026-11-11', tokens: 140_000 }],
  total: 2_770_000,
  since: '2026-05-28',
}

const band = (bodyColumns: number) => ({
  plugin: 'token-usage-weather',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 10 },
  },
} as const)

const measure = (fiveHour: number, weekly: number) => ({
  context: { windowTokens: 200_000 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour },
    { kind: 'seven_day', percentUsed: weekly },
  ],
  changed: ['rateLimits' as const],
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`limits show as rain chance and moon (${surface})`, async ($, on) => {
    on('state.get', (_, e, next) => e.key === 'summary'
      ? { value: { value: SUMMARY, version: 1 } }
      : next(e))
    on('session.measure', (_, e) => ({ changed: e.changed }))

    await $.session.measure(measure(38, 54) as never)
    const ui = await $.ui.mount({ ...band(120), surface } as never)
    expect((await ui.find({ type: 'Text', text: /강수/ }))?.text).toBe('강수 38%')
    expect((await ui.find({ type: 'Text', text: /주간/ }))?.text).toBe('◑ 주간 54%')
    await ui.unmount()
  })

  test(`past 80% the band raises an advisory (${surface})`, async ($, on) => {
    on('state.get', (_, e, next) => e.key === 'summary'
      ? { value: { value: SUMMARY, version: 1 } }
      : next(e))
    on('session.measure', (_, e) => ({ changed: e.changed }))

    await $.session.measure(measure(84, 97) as never)
    const ui = await $.ui.mount({ ...band(40), surface } as never)
    expect((await ui.find({ type: 'Text', text: /호우/ }))?.text).toBe('⚠ 호우주의보 84%')
    expect((await ui.find({ type: 'Text', text: /97%/ }))?.text).toBe('⚠ ● 97%')
    await ui.unmount()
  })
}

test('no limits, no limit section', async ($, on) => {
  on('state.get', (_, e, next) => e.key === 'summary'
    ? { value: { value: SUMMARY, version: 1 } }
    : next(e))

  const ui = await $.ui.mount({ ...band(120), surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /강수|주간/ })).toBeUndefined()
  await ui.unmount()
})

// 집계 스크립트가 실패하면 디버그 로그에 남기고, 띠는 직전 요약에 오류 표시를 붙인다
test('a failed tally is logged and marked on the band', async ($, on) => {
  const logs: string[] = []
  on('state.get', (_, e, next) => e.key === 'summary'
    ? { value: { value: SUMMARY, version: 1 } }
    : next(e))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 집계는 session.start 뒤에 기다리지 않고 돈다: 띠에 표시가 붙을 때까지 다시 그려 본다
  let marker
  for (let i = 0; i < 50 && marker === undefined; i++) {
    const ui = await $.ui.mount({ ...band(120), surface: 'terminal' } as never)
    marker = await ui.find({ type: 'Text', text: /집계 오류/ })
    await ui.unmount()
  }
  expect(marker?.text).toBe('  (집계 오류)')
  expect(logs.some(l => l.includes('boom'))).toBe(true)
})

test('a successful tally shows no error marker', async ($, on) => {
  on('state.get', (_, e, next) => e.key === 'summary'
    ? { value: { value: SUMMARY, version: 1 } }
    : next(e))

  const ui = await $.ui.mount({ ...band(120), surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /집계 오류/ })).toBeUndefined()
  await ui.unmount()
})
