# PRISM ∞ 10.0 — Recursive Research Execution System

**Состояние:** текстовая спецификация + компилятор инструкций + **исполняемый локальный шлюз сравнения предоставленных результатов**. Это НЕ готовый рой агентов и не доказательство роста интеллекта. Прямых испытаний на LLM в пакете не проводилось.

## Выбор файла

- `PRISM_10.0_CORE_RU.md` — **рекомендуемый** компактный универсальный системный промпт (под любую задачу).
- `PRISM_INFINITY_10.0_FULL_MASTER_RU.md` — архивная полная совместимая редакция, включая 9.0, для глубокого изучения и диагностики.
- `NEW_10.0_RESEARCH_PROTOCOL.md` — новые механизмы и экспериментальная рекурсия без старого архива.
- `modules/recursive_research.md` — подключаемый специализированный модуль на задачи самоулучшения.
- `generated/` — собранные рабочие профили.
- `scripts/experiment_gate.py` — проверяет парные результаты, но **не запускает модели и не подтверждает подлинность логов**.

## Как собрать специализированный промпт

Python 3.10+; дополнительных пакетов нет.

```bash
python scripts/compile_prompt.py --profile fast --output generated/fast.md
python scripts/compile_prompt.py --profile swarm --output generated/swarm.md
python scripts/compile_prompt.py --profile discovery --output generated/discovery.md
python scripts/compile_prompt.py --profile full --output generated/full.md
```

Профили: `fast`, `research`, `coding`, `swarm`, `evolution`, `discovery`, `all`, `full`. Выбор текстового профиля не создаёт отсутствующий runtime.

## Как сравнить версии честно

1. Выбери 20–50 **реальных** разнородных задач на старте, с внешней проверкой конечного результата. Зафиксируй одинаковые модели, доступ к инструментам, параметры, лимиты, права и версии grader. Держи отдельный закрытый holdout, который не использовался при доработке кандидатов.
2. Выполни каждую задачу baseline и candidate в эквивалентных условиях несколько раз. Изолируй побочные эффекты. Получи отчёты и внешние `receipt` — команда+exit code, CI test, ссылка на исправленный тикет, воспроизводимая проверка, экспертная проверка и т.п.
3. Приведи результаты к формату `JSONL` — **одна строка на пару case_id/trial**. Обе стороны должны использовать одинаковые `environment_id` и `grader_id`; `split` = `protected_holdout`. Не меняй оценщик после просмотра результатов.
4. Запусти шлюз:

```bash
python scripts/experiment_gate.py --input fixtures/example_SYNTHETIC_no_valid_promotion.jsonl --objective success
```

Выше пример намеренно *синтетический* и возвратит `INSUFFICIENT_EVIDENCE`. Для настоящего сравнения передай свои измерения; отметка `synthetic` у результатов должна честно соответствовать происхождению данных. Шлюз технически **не способен удостоверить**, что JSONL не сфабрикован: внешний владелец или независимый аудит обязателен.

Формат записи:

```json
{
  "case_id": "task-0001",
  "trial": 0,
  "split": "protected_holdout",
  "environment_id": "runtime:locked-v1+model:locked-v1",
  "grader_id": "objective-grader-v1",
  "synthetic": false,
  "critical": true,
  "baseline": {"success": 0, "confirmed_discoveries": 0, "cost_usd": 0.1, "latency_s": 30, "safety_violations": 0, "receipt": "external-run-001"},
  "candidate": {"success": 1, "confirmed_discoveries": 0, "cost_usd": 0.1, "latency_s": 30, "safety_violations": 0, "receipt": "external-run-002"}
}
```

`confirmed_discoveries` допускается учитывать только при **независимом подтверждении** новых возможностей/ошибок, а не за количество высказанных предложений. Схема `--objective discovery` предназначена для отдельной проверки способности к открытию.

### Значение статусов

- `PROMOTE_CANDIDATE`: кандидат прошёл **локальные формальные правила шлюза**; требуется ручное подтверждение оригинальных внешних receipts, неизменности holdout, статистики и разрешений; это **не автоматический релиз**.
- `INSUFFICIENT_EVIDENCE`: данных не хватает, статистика неубедительна или данные отмечены как примерные.
- `REJECT`: нарушена критическая безопасность, обнаружена недопустимая регрессия/стоимость или не показана направленная польза.
- `INVALID_INPUT`: ошибка схемы или несовместимые условия.

Для сравнения используется односторонний точный парный sign test **на уровне разных задач**, повторы одной задачи предварительно агрегируются; он не учитывает полностью неоднородность задач и не устраняет загрязнение holdout. При последовательном многократном просмотре одного holdout p-value не является корректным доказательством (multiple testing); выделяй новые внешние задачи и применяй заранее зафиксированный план. Сам шлюз не проводит целевых запусков на моделях и не проверяет статистическую применимость к конкретной популяции пользователей.

## Проверки

```bash
python -m unittest discover -s tests -v
```

Тесты проверяют код, компиляцию, структуру и защитные отказы, **не поведение базовой LLM**.

## Что считать «последней» версией

Не последнюю существующую инструкцию во Вселенной, а **последний обязательный монолит**: компактное доверенное ядро + подключаемые навыки/инструменты + внешние evals + инструментальное обучение/поиск и регистр доказанных переходов. Версию ядра менять только при доказанной необходимости.

## Первичные источники (архитектурные ориентиры, не доказательство PRISM)

- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 2026.
- Google Research, [Towards a science of scaling agent systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/), 2026.
- Zhang et al., [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954), 2025.
- DSPy, [GEPA optimization](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/getting-started/gepa-optimization.md).
- OpenAI, [Why we no longer evaluate SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/), 2026.
