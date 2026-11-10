# token-usage-weather

Claude Code 프롬프트 위에 **오늘 토큰 사용량을 날씨로**, 그리고 **전체 누적 사용량**을 한 줄로 보여 주는 모드입니다.

```
☂ 비  오늘 140k  ▃█▂▁▂▄▃  │  누적 2.77M  (D+168)  │  강수 38%  ◑ 주간 54%
```

[Token Weather](https://claude.dev/blog/getting-started-with-claude-code-mods/) 예제는 현재 세션의 컨텍스트 창 점유율만 보여 줍니다. 이 모드는 그 대신 모든 세션의 실제 토큰 사용량을 날짜별로 집계합니다.

## 보여 주는 것

- **날씨**: 오늘(한국 시간 자정 기준) 사용한 토큰으로 정합니다.

  | 오늘 사용량 | 날씨 |
  |---|---|
  | 30k 미만 | ☀ 맑음 |
  | 30k ~ 100k | ☁ 구름 |
  | 100k ~ 200k | ☂ 비 |
  | 200k ~ 300k | ☇ 폭풍 |
  | 300k 이상 | ↯ 태풍 |

- **그래프**: 최근 7일 사용량
- **누적**: 기록이 남아 있는 첫날부터의 총 사용량과 경과 일수(`D+n`)
- **강수확률**: 5시간 한도 사용률
- **달**: 주간 한도 사용률. 많이 쓸수록 달이 찹니다 (`○ ◔ ◑ ◕ ●`).
- 한도 사용률이 50% 이상이면 노랑, 80% 이상이면 빨강으로 바뀝니다. 80%를 넘은 5시간 한도는 `⚠ 호우주의보`, 95%를 넘으면 `⚠ 호우경보`로 표시하고, 80%를 넘은 주간 한도 앞에는 `⚠`를 붙입니다.
- 한도 값은 Claude Code가 응답마다 받아 오는 수치이며 구독(Pro/Max) 계정에서만 있습니다. 값이 없으면(API 키 사용, 세션의 첫 응답 전) 이 칸을 숨깁니다.
- 터미널 폭이 64칸보다 좁으면 그래프와 `D+n`, `주간` 글자를 생략합니다.

## 어떻게 세나

- Claude Code가 남기는 대화 기록(`~/.claude/projects/**/*.jsonl`)을 읽습니다. 그래서 모드를 설치하기 전의 사용량도 포함됩니다.
- 토큰 = `input_tokens + output_tokens`. 캐시 생성·캐시 읽기 토큰은 제외합니다.
- 같은 응답이 기록에 여러 줄로 저장되므로 `message.id`로 중복을 제거합니다.
- 세션이 시작될 때와 메인 턴이 끝날 때마다 `scripts/tally.mjs`를 실행해 새로 추가된 줄만 이어서 읽습니다.
- 집계 상태는 `~/.claude/token-usage-weather/state.json`에 저장됩니다. 이 파일을 지우면 처음부터 다시 셉니다.

## 설치

Node.js가 PATH에 있어야 합니다 (`node` 명령으로 집계 스크립트를 실행합니다).

터미널 세션의 프롬프트에서:

```
/plugin install token-usage-weather --marketplace namyoungjun96/token-usage-weather
```

`Add marketplace?`에 `y`를 누르고 범위를 고르면 바로 적용됩니다.

셸에서:

```
claude plugin install token-usage-weather --marketplace namyoungjun96/token-usage-weather
```

데스크톱 앱에서는 프롬프트 옆 **+** → **Plugins** → **Add marketplace**에 `namyoungjun96/token-usage-weather`를 입력한 뒤 **Add plugin**을 누르세요.

## 날씨 기준 바꾸기

`hooks/register.tsx`의 `FORECASTS` 배열에서 기준값과 아이콘을 고치면 됩니다.
