# Отключение reasoning у вспомогательных вызовов

Статус: реализовано 2026-11-23.

## Проблема

`prompt-enhancer` выбирает самый дешёвый reasoning level модели. Для
`opencode-go-inference/deepseek-v4.1-flash` site-правило провайдера объявляло только
`["low", "high", "max"]` и отправляло `reasoning_effort: reasoningLevel` без ветки
`disabled`. Улучшение промпта уходило с `low`, модель тратила весь бюджет
`maxOutputTokens = 4096` на рассуждение и возвращала пустой `content`:

```
[prompt-enhancer] Prompt enhancement failed
{"code":"empty_result","error":"Empty model output"}
```

## Продуктовое правило

1. Вспомогательные вызовы (улучшение промпта, autocomplete, proactive suggestions)
   должны иметь возможность полностью отключить reasoning, если модель это поддерживает.
2. Для OpenAI-совместимых site-правил OpenCode Go `deepseek-v4.1-flash`,
   `deepseek-v4.1-flash-free`, `deepseek-v4-pro`, `deepseek-v4-flash` и
   `deepseek-v4-flash-vision-exp` допускается уровень `disabled`.
3. `disabled` маппится в `{"reasoning_effort": "none"}`; явные уровни (`low`, `high`,
   `max`) передаются как раньше.
4. Основной turn не меняет поведение: авто-выбор по-прежнему берёт верхний уровень,
   а явный выбор пользователя не переопределяется.

## Владелец и порядок

Владелец маппинга — `config/provider/zcode-builtin.json` и
`config/provider/zcode-builtin.test.json` (Preview собирается с `ZCODE_ENV=test`),
`modelConfigRules.providerSiteRules`. Prompt enhancer только передаёт выбранный
`reasoningLevel`; provider adapter применяет CEL-map к телу запроса.

```text
prompt-enhancer
  pickLowestReasoningLevel(values) -> "disabled"
        │
        ▼
provider site rule deepseek-v4.1-flash
  reasoningLevel == "disabled"
        │
        ▼
request body: {"reasoning_effort": "none"}
        │
        ▼
OpenCode Go returns content, no reasoning budget
```

## Acceptance

1. `compileModelOptionMaps` для `deepseek-v4.1-flash` с `disabled` даёт
   `{"reasoning_effort":"none","max_tokens":4096}`.
2. С `high` даёт `{"reasoning_effort":"high","max_tokens":4096}` — основной turn не
   деградирует.
3. В живом приложении Enhance Prompt возвращает текст за разумное время и не пишет
   `empty_result`.

## Проверки

- `packages/provider-node/test/opencode-go.test.ts` — маппинг `disabled`/`high` и
  объявленные уровни моделей.
- `packages/provider-node/test/zcode-builtin-integrity.test.ts`,
  `zcode-builtin-reasoning-map.test.ts`, `new-model-catalog-round2.test.ts`.
