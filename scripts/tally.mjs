// Claude Code 기록 파일(~/.claude/projects/**/*.jsonl)을 이어 읽어 토큰 사용량을 날짜별로 누적하고 요약 JSON 한 줄을 출력한다.
// 집계 로직은 tally-core.mjs에 있다 (테스트: tests/tally.test.mjs).
import { main } from './tally-core.mjs'

main()
