# Qwen3.8-27B-pi-adapted в ZCode: перенос, скорость и явный запуск

Дата: 2026-11-20. Ветка: `dev`, HEAD `880ab6fd`. Репозиторий: текущий checkout Zcode.

Метод: сначала первичные источники (карточки модели/адаптера, конфиг LoRA, блог Harness Hub,
исходники pi), затем измерения текущего ZCode (`builtInTools`, `buildIdentitySection`, схемы
инструментов, runtime-контракты). 27B-модель и адаптер **не запускались**: на этой машине
16 ГБ unified memory, а Q4-вес 27B — около 17 ГБ. Все оценки скорости, которые не следуют из
арифметики токенов, помечены как `[оценка]`, а не как измерение.

Обозначения: **[источник]** — факт из внешнего источника; **[код]** — факт из текущего
репозитория; **[измерение]** — число, полученное скриптом на этом checkout; **[вывод]** —
моя интерпретация; **[гипотеза]** — проверяемое утверждение без прямого измерения.

---

## 1. Краткий вердикт

1. **Адаптер сам по себе сильный, но его главные цифры получены в pi.** На SWE-bench Pro
   hard51: 39.2% → 64.7% (+25.5 п.п.), на Terminal-Bench 2.1: 39.5% → 55.8% (+16.3 п.п.).
   Это не результат ZCode и не результат «Qwen3.8-27B вообще»: та же базовая модель в карточке
   Qwen на SWE-bench Pro показывает 61.7% в другом harness (не pi), а в pi — 39.2%.
   Разница между harness здесь сравнима с эффектом адаптера, поэтому переносить абсолютные
   цифры нельзя. **[источник]**

2. **Перенос между harness частичный.** Pi-адаптер под OpenCode на Terminal-Bench 2.1 даёт
   44.8% → 54.0%, под Hermes — 46.3% → 56.1%. Это хороший сигнал: часть навыка
   «меньше шагов, меньше tool calls» переносится. Но на out-of-distribution AutomationBench
   pi-адаптер даёт +4.0 п.п. (23.0% → 27.0%) в пределах шума, а Hermes-адаптер — −5.3 п.п.
   То есть **вне своего распределения эффект исчезает или меняет знак**. **[источник]**

3. **ZCode — не pi, не OpenCode и не Hermes.** У ZCode другой системный промпт, 33–50
   model-visible инструментов вместо 4–7 у pi и другие схемы аргументов. В типовом root-срезе
   ZCode (dynamic workflow off, skill/agent/automation/codeindex ports on) — **33 инструмента,
   75 904 символа, ≈18 976 токенов** только на tool declarations. У pi с 7 инструментами —
   **4 873 символа, ≈1 219 токенов**. Это **15.6×** больше по инструментам и **11.7×** больше
   вместе с identity-промптом. **[измерение]**

4. **Прямой перенос pi-адаптера в ZCode без моста — рискованный эксперимент, а не готовое
   улучшение.** У pi и ZCode различаются даже базовые имена и аргументы: `read.path` vs
   `Read.file_path`, `edit.edits[]` vs `Edit.old_string/new_string`, `bash.timeout` в секундах
   vs в миллисекундах. Модель, обученная на грамматике pi, будет чаще ошибаться на валидации
   ZCode. Это может съесть выигрыш в tool calls. **[код]**

5. **«Быстрая локальная модель» на этой машине невозможна для 27B.** 16 ГБ M1 Pro не вмещают
   Q4-вес 27B (~17 ГБ) вместе с KV-cache и ОС. Даже если запустить Q3 с offload, это будут
   единицы токенов в секунду и минуты на prefill 20–25k токенов. Для 27B нужен минимум
   32 ГБ (Q4, короткий контекст), лучше 64 ГБ или GPU 24 ГБ+. **[оценка]**

6. **Правильная интеграция — не «добавить провайдера при старте», а явный state machine.**
   В ZCode уже есть подходящий владелец: `RuntimeProviderCatalogSnapshot` — in-memory
   провайдеры, которые не пишутся в personal config (так сделан локальный OpenCode CLI).
   Локальная модель должна появляться в каталоге **только после** `/local start` и исчезать
   после `/local stop`; при запуске приложения — пустой snapshot, без spawn, probe, download
   и без записи в `provider_config.json`. **[код]**

7. **Рекомендация:** не делать 27B pi-адаптер локальной моделью по умолчанию. Если локальность
   обязательна — сначала «local-lite» профиль (Read/Bash/Edit/Write/Grep/Glob) + явный
   start-gate + A/B на задачах ZCode. Если нужен максимальный прирост — обучать
   ZCode-специфичный LoRA, а не надеяться на перенос pi. **[вывод]**

---

## 2. Что именно опубликовано

### 2.1 Базовая модель

- `Qwen/Qwen3.8-27B`, Apache-2.0, 27B, 64 слоя, гибридная схема
  `16 × (3 × Gated DeltaNet → FFN) → 1 × Gated Attention`, 262 144 токена нативно,
  расширение до 1M, MTP. **[источник: config.json, model card]**
- Это vision-language модель (`Qwen3_5ForConditionalGeneration`), но адаптер обучен и
  оценён как текстовая: vision tower не подаётся (`--language-model-only`). **[источник]**
- BF16-вес ~54 ГБ; Q8 GGUF ~29 ГБ; Q4_K_XL ~17 ГБ; Q3 ~13 ГБ. **[источник: adapter card,
  GGUF card; размеры квантов — оценка по числу параметров]**

### 2.2 Адаптер

- `harness-hub/Qwen3.8-27B-pi-adapted`, LoRA для pi, Apache-2.0.
- PEFT LoRA: `r=32`, `alpha=64`, target modules `q,k,v,o,gate,up,down`; файл
  `adapter_model.safetensors` — 637 610 624 байта (~608 MiB). **[источник: adapter_config.json,
  HF API]**
- Обучение: AsyncGRPO (TRL), 160 шагов, 2×B200, 750 задач `scale800` + 300 TermGrade,
  8 rollouts на задачу, thinking off, температура 0.8, до 50 agent steps и 1800 с на rollout,
  reward = correctness + 0.1 × tool-efficiency. **[источник: model card]**
- Оценка: pi harness, 1 attempt/task, 100-step budget, 131 072 контекст, thinking off,
  temperature 0.8, top-p 1.0. **[источник]**

### 2.3 Цифры, которые нельзя читать как «ZCode +25 п.п.»

| Бенчмарк                                    | База Qwen3.8-27B | Адаптер |          Разница | Новые/потерянные |
| ------------------------------------------- | ---------------: | ------: | ---------------: | ---------------: |
| SWE-bench Pro hard51                        |            39.2% |   64.7% | +25.5 ±14.2 п.п. | 15 / 2, p=0.0023 |
| Terminal-Bench 2.1                          |            39.5% |   55.8% |  +16.3 ±9.1 п.п. | 16 / 2, p=0.0013 |
| TB 2.1, 68 задач не из checkpoint selection |            39.7% |   55.9% | +16.2 ±10.6 п.п. | 13 / 2, p=0.0074 |

Работа на решённых задачах (медианы, адаптер / база): SWE-bench Pro — 23 / 59 turns,
6.9k / 9.6k generated tokens; TB 2.1 — 8 / 18 turns, 1.5k / 2.9k tokens. **[источник]**

Важная поправка: заголовок «4.5× fewer tokens» — это сравнение с базой **в режиме thinking
xhigh** (48.8k → 9.4k на SWE-bench Pro). Против базы **с thinking off** экономия скромнее:
6.9k vs 9.6k (≈1.4×) на SWE-bench Pro и 1.5k vs 2.9k (≈1.9×) на TB 2.1. **[источник]**
Для локальной скорости это принципиально: ориентироваться на 4.5× нельзя, если сравниваете
с уже выключенным thinking.

С thinking on адаптер достигает 74.5% на SWE-bench Pro (как база xhigh), но генерирует
примерно в 4 раза больше токенов; на TB 2.1 — 56.6% против 54.2% у базы xhigh. **[источник]**

---

## 3. Переносится ли адаптер на другой harness

### 3.1 Прямые измерения авторов

| Сценарий                        |  База | Адаптер |    Разница |
| ------------------------------- | ----: | ------: | ---------: |
| pi-адаптер под OpenCode, TB 2.1 | 44.8% |   54.0% |  +9.2 п.п. |
| OpenCode-специалист, TB 2.1     | 46.4% |   52.4% |  +6.0 п.п. |
| pi-адаптер под Hermes, TB 2.1   | 46.3% |   56.1% |  +9.8 п.п. |
| Hermes-специалист, TB 2.1       | 44.7% |   58.8% | +14.1 п.п. |

Авторы формулируют так: под OpenCode pi-адаптер «matches OpenCode's own specialist», под
Hermes «keeps about two-thirds of the specialist's gain», с тем же сокращением tool calls
(~45%). **[источник: блог, раздел «Does the efficiency and performance ability transfer
across harnesses?»]**

Это сильнее, чем можно было ожидать: pi → OpenCode/Hermes — это другой системный промпт,
другие имена инструментов и другой orchestration. Значит, адаптер выучил не только
«пи-специфичную грамматику», но и некоторую общую политику: меньше лишнего exploration,
меньше повторных команд, короче reasoning. **[вывод]**

### 3.2 Out-of-distribution

300 задач AutomationBench, чужой agent loop (не pi/OpenCode/Hermes):

| Модель       | pass@1 | vs base | partial credit | vs base |
| ------------ | -----: | ------: | -------------: | ------: |
| base         |  23.0% |       — |          62.2% |       — |
| pi 160       |  27.0% |    +4.0 |          66.2% |    +4.0 |
| opencode 150 |  25.3% |    +2.3 |          65.2% |    +3.0 |
| merged       |  23.7% |    +0.7 |          60.6% |    −1.6 |
| hermes 160   |  17.7% |    −5.3 |          56.6% |    −5.6 |

Авторы: «differences are within noise, except perhaps Hermes; RL inside the harnesses neither
transfers clearly to this very different setting nor breaks the model on it». **[источник]**

### 3.3 Что это значит для ZCode

Есть два разных переноса:

- **Harness transfer** (pi → другой coding agent): частично работает, 56–60% эффекта на
  Terminal-Bench 2.1.
- **Task transfer** (SWE/terminal → business automation): почти не работает.

ZCode — это coding agent, как pi/OpenCode/Hermes, поэтому task transfer ближе к первому
случаю. Но ZCode сильнее отличается по **tool surface** и **system prompt**, чем
OpenCode/Hermes. Поэтому нельзя просто взять 56–60% и перенести на ZCode; это верхняя граница,
а не оценка. **[вывод]**

---

## 4. Чем ZCode отличается: измерения, а не впечатления

### 4.1 Tool surface

Скрипт на текущем checkout: `builtInTools` из
`apps/zcode-cli/packages/core/src/tool/handlers/index.ts`, затем `JSON.stringify` от
`{name, description + modelInstructions, inputSchema}`.

| Срез                                                                            | Инструментов | Символов | ≈токенов (4 симв./токен) |
| ------------------------------------------------------------------------------- | -----------: | -------: | -----------------------: |
| ZCode, все built-in                                                             |           50 |  102 779 |                   25 695 |
| ZCode, типовой root (dynamic workflow off, skill/agent/automation/codeindex on) |           33 |   75 904 |                   18 976 |
| ZCode, «core 7» (Read/Bash/Edit/Write/Grep/Glob/ApplyPatch)                     |            7 |   11 433 |                    2 859 |
| pi, все 7 (read/bash/edit/write/grep/find/ls)                                   |            7 |    4 873 |                    1 219 |
| pi, дефолтные 4 (read/bash/edit/write)                                          |            4 |    2 717 |                      680 |

Типовой root-срез — это не «все возможные тулзы», а приближение к реальному interactive root
при выключенных dynamic workflow/off-peak/node-repl/PTY. Точное число зависит от портов и
gate-флагов; 50 — верхняя граница. **[измерение]**

### 4.2 Промпт

`buildIdentitySection(undefined, "compact", "standard")`:

| Компонент                                              | Символов | `estimateTokens` |
| ------------------------------------------------------ | -------: | ---------------: |
| ZCode identity, standard                               |    5 822 |            1 941 |
| ZCode identity, deep                                   |    6 567 |            2 189 |
| ZCode identity, max_reasoning                          |    7 236 |            2 412 |
| pi system prompt (4 tools, без project context/skills) |    2 274 |             ≈569 |

Итого типовой ZCode root: **1 941 + 18 976 = 20 917 токенов** до истории, project context,
skills и памяти. Это **16.0%** контекста 131 072. У pi с 7 tools: **1 788 токенов**,
**1.4%**. У ZCode «core 7»: **4 800 токенов**, **3.7%**. **[измерение; оценка токенов —
эвристика, не BPE]**

### 4.3 Схемы аргументов

| Возможность  | pi                                                          | ZCode                                                                                     | Риск для pi-адаптера                      |
| ------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| Чтение       | `read {path, offset, limit}`                                | `Read {file_path, offset, limit}`                                                         | переименование ключа                      |
| Запись       | `write {path, content}`                                     | `Write {file_path, content}`                                                              | переименование ключа                      |
| Правка       | `edit {path, edits:[{oldText,newText}]}`                    | `Edit {file_path, old_string, new_string, replace_all}`                                   | структурная разница: массив → одна замена |
| Shell        | `bash {command, timeout}`; timeout в **секундах**           | `Bash {command, timeout, description, run_in_background}`; timeout в **миллисекундах**    | семантическая ошибка: 120 → 120 мс        |
| Поиск        | `grep {pattern,path,glob,ignoreCase,literal,context,limit}` | `Grep {pattern,path,glob,output_mode,-B,-A,-C,-n,-i,-o,type,head_limit,offset,multiline}` | другие флаги                              |
| Поиск файлов | `find {pattern,path,limit}`                                 | `Glob {pattern,path}`                                                                     | другое имя, нет limit                     |
| Листинг      | `ls {path,limit}`                                           | нет `Ls`; Bash/Glob                                                                       | отсутствующий инструмент                  |

Имена инструментов в ZCode — с заглавной буквы (`Read`, `Bash`, `Edit`), в pi — строчные.
Точных совпадений имён — 0/7. Это не мелочь: tool-call grammar — часть распределения, на
котором обучался LoRA. **[код]**

Особенно опасен `Bash.timeout`: pi-адаптер, обученный ставить `timeout: 120` в секундах,
в ZCode получит 120 мс и мгновенный timeout. Это не гипотетика, а прямое следствие схем.
**[код]**

### 4.4 Turn loop и orchestration

- Корневой turn ZCode по умолчанию **без maxTurns**: `maxTurns === undefined` — лимита нет;
  явное положительное число — есть. **[код: `turn-loop.ts`, `docs/specs/max-turns-limit.md`]**
- У встроенных субагентов лимиты есть: start 12, orchestrator 60, researcher/debugger 40,
  implementer/coder 50, reviewer 25 и т.д. **[код: `built-in-profiles.ts`]**
- Мягкий `modelAnomalyGuard.toolCallWarningThreshold = 60`: после 60 tool calls turn получает
  reminder, но не прерывается. **[код: `model-anomaly.ts`]**
- ZCode параллелит независимые tool calls (до 10 в группе) и поддерживает фоновые Agent.
  **[код: `docs/specs/2026-11-18-parallel-tools-and-async-agents.md`]**
- pi тоже умеет параллельные tool calls (`toolExecution: "parallel"` по умолчанию), поэтому
  это не такой сильный конфликт, как схемы. Но pi не имеет subagents/plan mode как встроенных
  фич; ZCode имеет `Agent`, `Task`, `Workflow`, `EnterPlanMode`, todo и т.д. **[источник:
  pi README; код ZCode]**

Следствия:

1. Главный источник прироста pi-адаптера на SWE-bench Pro — база упиралась в **100-step
   hard cap** (20 из 31 failed attempts), адаптер заканчивал раньше. В ZCode root такого
   hard cap нет, поэтому этот конкретный механизм прироста **не переносится**. **[источник +
   код]**
2. В субагентах ZCode лимиты 12–60 есть, поэтому там адаптер может помочь не упереться в
   `error_max_turns`. Но это уже другой сценарий, не root. **[вывод]**
3. Мягкое предупреждение на 60 tool calls может сработать у базовой Qwen и подтолкнуть её
   к преждевременной сдаче; адаптер с меньшим числом calls может его избежать. Это
   гипотеза, которую надо измерять. **[гипотеза]**

---

## 5. Скорость: где именно 27B перестаёт быть «быстрой»

### 5.1 Железо

Текущая машина: `MacBookPro18,1`, Apple M1 Pro, 10 ядер, **16 ГБ** unified memory.
`llama-server`/`vllm` не установлены. **[измерение: system_profiler]**

Память:

- BF16 27B ≈ 54 ГБ — не помещается.
- Q8 ≈ 29 ГБ — не помещается.
- Q4_K_XL ≈ 17 ГБ — **больше всей памяти машины**; с KV-cache, ОС и приложением не
  помещается.
- Q3 ≈ 13 ГБ — на границе: ОС, приложение и KV-cache оставляют мало запаса; при 32k+
  контексте это уже риск OOM. С offload скорость падает до единиц токенов в секунду.
  **[оценка]**

Вывод: **на 16 ГБ M1 Pro 27B-адаптер не является практичным локальным вариантом.** Это не
вопрос оптимизации флагов; это вопрос физического объёма памяти. **[вывод]**

### 5.2 Ориентиры по железу

Все числа ниже — `[оценка]` по bandwidth/compute, не замер на этой машине.

| Железо            | Квант        |      Decode |         Prefill | Практический вывод                                |
| ----------------- | ------------ | ----------: | --------------: | ------------------------------------------------- |
| M1 Pro 16 ГБ      | Q3 + offload |   1–3 tok/s |     10–30 tok/s | минуты на первый prompt; не для работы            |
| M2/M3 Pro 32 ГБ   | Q4           |  8–15 tok/s |    80–150 tok/s | 25k prefill ≈ 3–5 мин; только короткие сессии     |
| M3/M4 Max 64 ГБ   | Q4/Q8        | 15–30 tok/s |   150–300 tok/s | 25k prefill ≈ 1.5–3 мин; приемлемо с prefix cache |
| RTX 4090 24 ГБ    | Q4           | 35–55 tok/s | 1000–2000 tok/s | 25k prefill ≈ 13–25 с; уже похоже на работу       |
| 2×B200, vLLM BF16 | BF16/LoRA    |  100+ tok/s |    тысячи tok/s | эталон, но не «локально на ноутбуке»              |

### 5.3 Арифметика промпта

Холодный prefill — главный скрытый налог ZCode. Типовой root: 20 917 токенов до истории.
«Core 7»: 4 800 токенов. Экономия — **16 117 токенов** (77%). При разной скорости prefill:

|    Prefill | Экономия на холодном старте |
| ---------: | --------------------------: |
|  100 tok/s |                       161 с |
|  500 tok/s |                        32 с |
| 1000 tok/s |                        16 с |
| 2000 tok/s |                         8 с |

Если сравнивать полный built-in surface (27 636 токенов) с core 7 (4 800), экономия —
22 836 токенов: 228 / 46 / 23 / 11 с соответственно. **[измерение + арифметика]**

Это важнее, чем «4.5× fewer tokens»: на локальном железе prefill часто доминирует, а
сокращение tool surface даёт гарантированный выигрыш на каждом новом сеансе. **[вывод]**

### 5.4 Что даёт адаптер по скорости

Формула для грубой оценки времени задачи:

```
T ≈ N_steps × (P_shared/N_steps + P_new + D)
```

где `P_shared` — общий prefill (system + tools + история), `P_new` — новый prefill на шаг,
`D` — decode. Адаптер сокращает `N_steps` и `D`, но не `P_shared`. Если `P_shared`
доминирует (локальный 27B с 20k tool-схемой), выигрыш адаптера в wall-clock будет
**10–25%**, а не 4.5×. Если prefill быстрый (vLLM/B200, prefix cache), выигрыш ближе к
**30–50%** за счёт 28–48% меньшего decode и 56–72% меньшего числа tool calls. **[гипотеза,
на основе опубликованных token/turn чисел]**

Ключевой практический вывод: **сначала сокращать tool surface, потом уже надеяться на
адаптер.** Один только core-7 профиль снимает ~16k токенов с каждого холодного prefill.

---

## 6. Ожидаемый эффект в ZCode: только гипотезы

### 6.1 Модель переноса

Пусть `Δ_pi` — прирост адаптера в pi (например, +25.5 п.п. на SWE-bench Pro), а `τ` —
коэффициент переноса в ZCode. Тогда:

```
Δ_zcode ≈ τ × Δ_pi
```

Опубликованные cross-harness данные дают `τ ≈ 0.55–0.60` для pi → OpenCode/Hermes на
Terminal-Bench 2.1 (9.2–9.8 из 16.3 п.п.). OOD AutomationBench даёт `τ ≈ 0.16` для pi
(+4.0 из +25.5), но там другая задача, а не только harness. Для ZCode разумный диапазон
`τ = 0.2–0.5` из-за более сильного расхождения tool surface. **[гипотеза]**

Если базовая Qwen под ZCode даёт 50%, то:

| Вариант                      |                      τ | Ожидаемый pass@1 |     Прирост |
| ---------------------------- | ---------------------: | ---------------: | ----------: |
| Прямой pi-адаптер, без моста |                0.0–0.2 |           50–55% |    0–5 п.п. |
| + local-lite (6–7 tools)     |                0.2–0.4 |           55–60% |   5–10 п.п. |
| + pi-compat мост аргументов  |                0.3–0.5 |           58–63% |   8–13 п.п. |
| ZCode-специфичный LoRA       | 0.8–1.0 от своего gain |          60–70%+ | 10–20+ п.п. |

Это **не прогноз**, а сценарии. Ширина интервала отражает неопределённость; одного A/B на
50 задачах не хватит, чтобы отличить +5 от +10 п.п. (см. §8). **[гипотеза]**

### 6.2 Tool calls и токены

Опубликовано: 56–72% меньше tool calls на решённых задачах, 28–48% меньше generated tokens
против базы thinking off. Если в ZCode переносится половина эффекта, ждите **20–35% меньше
tool calls** и **10–25% меньше токенов**. Если схемы ломаются — эффект может быть нулевым
или отрицательным: повторные попытки после validation error добавляют и calls, и токены.
**[гипотеза]**

### 6.3 Сравнение с текущей облачной моделью

Все таблицы выше — относительно **базовой Qwen3.8-27B под ZCode**, а не относительно
DeepSeek V4.1 Flash или другой облачной модели. Локальный 27B-адаптер может быть быстрее и
приватнее, но не обязан быть точнее текущей облачной модели. Замена дефолта без A/B против
текущей модели — необоснованный риск. **[вывод]**

---

## 7. Варианты интеграции

### Вариант A. Прямой custom provider, сервер вручную

Пользователь сам запускает vLLM/llama.cpp, ZCode подключается как к обычному
OpenAI-compatible provider с `openai-chat-completions`.

- Плюсы: нулевой код в ZCode, можно проверить сегодня.
- Минусы: ручной старт, ручная регистрация, нет гарантии «не стартовать без команды»;
  provider останется в конфиге и будет виден при выключенном сервере.
- Когда: быстрый эксперимент, не продукт.

### Вариант B. Local-lite профиль + pi-compat мост (рекомендуемый zero-training путь)

- Оставить модели 6–7 инструментов: `Read`, `Bash`, `Edit`, `Write`, `Grep`, `Glob`
  (опционально `ApplyPatch`).
- Сократить identity-промпт до локального профиля (не тащить PRISM/полный ZCode preamble).
- Добавить projection-слой: `path → file_path`, `edits[] → old_string/new_string`,
  `timeout seconds → ms`, `find/ls → Glob/Bash`. Это можно сделать в `resolveModelContract`
  или отдельным provider-visible tool set.
- Плюсы: максимально использует обученную грамматику pi, снимает 77% tool-схемы,
  уменьшает вероятность validation errors.
- Минусы: новый слой трансляции, нужно тестировать на всех tool calls; часть ZCode-фич
  (Agent/Workflow/Todo) станет недоступна в локальном профиле.

### Вариант B2. Super-adapter вместо pi-специалиста

Авторы слили три адаптера (pi, Hermes, OpenCode) в один `cat`-LoRA ранга 96 с весом ½.
С thinking off он даёт средний pass@1 39.5% → 49.0% по шести парам harness×benchmark,
53–73% меньше tool calls; под pi он теряет большую часть gain специалиста
(46.0% против 64.0% на SWE-bench Pro), но под OpenCode/Hermes ближе к специалистам.
С thinking on — средний 55.5% → 63.5%, но примерно в 4 раза больше токенов. **[источник]**

Для ZCode это может быть **более безопасной ставкой, чем pi-специалист**: super-adapter
видел три разных harness и меньше привязан к грамматике одного. Но ZCode в обучении не
участвовал, а thinking on убивает локальную скорость. Поэтому B2 — кандидат для A/B, а не
готовое решение. **[вывод]**

### Вариант C. ZCode-специфичный LoRA

Обучить LoRA на ZCode-трассах и ZCode-tools по рецепту Harness Hub: AsyncGRPO, LoRA r=32,
thinking off, reward = verifier + tool-efficiency, 2×B200, 160+ шагов.

- Плюсы: снимает проблему переноса, максимальный ожидаемый gain.
- Минусы: дорого, нужен GPU и 750+ задач; не быстрый путь.
- Когда: если A/B покажет, что B даёт <5 п.п. и <20% экономии calls.

### Вариант D. Облачный хостинг Qwen + адаптер

Если нужна скорость, а не локальность: держать Qwen3.8-27B + adapter на vLLM GPU и
подключаться к нему как к OpenAI-compatible endpoint. Это сохраняет качество адаптера и
убирает проблему 16 ГБ, но не даёт приватности.

### Решение

1. **Сейчас:** не включать 27B локально на 16 ГБ. Оставить текущую облачную модель.
2. **Если локальность нужна:** вариант B (или B2) + явный start-gate (§8), затем A/B (§9).
3. **Если B/B2 не даёт измеримого выигрыша:** вариант C или отказ от 27B в пользу 7B–14B.

---

## 8. Явный запуск: контракт «без команды — ничего не происходит»

Это отдельный spec: `docs/specs/2026-11-20-local-model-explicit-start.md`. Ниже — суть.

### 8.1 Инварианты

- **I1.** До явной команды `/local start` запрещены: spawn процесса, скачивание весов,
  probe `/health` или `/v1/models`, `detectApiFormat`, `discoverProviderModels`,
  `createPersonalProvider`, запись в `provider_config.json`.
- **I2.** Локальный provider существует в каталоге **только** при состоянии `ready`.
  В `stopped`/`starting`/`failed` его нет в model list.
- **I3.** Никакого silent fallback на облако, если локальный сервер умер: пользователь
  видит ошибку и решает, что делать.
- **I4.** Только loopback (`127.0.0.1`/`::1`), эфемерный порт, эфемерный токен.
- **I5.** `/local stop` убивает process tree; restart приложения стартует в `stopped`.
- **I6.** `/start` остаётся существующим gateway-агентом. Локальная команда — `/local start`,
  чтобы не ломать контракт `/start <task>`.

### 8.2 Владелец состояния

В ZCode уже есть правильный механизм: `RuntimeProviderCatalogSnapshot` из
`packages/provider/src/sources.ts`. Это in-memory providers, которые не пишутся в personal
config; так уже сделан `OpenCodeCliProviderCatalogSource`
(`packages/services/src/model-provider/providerRuntime.ts`). Registry мержит их в общий
каталог (`packages/provider/src/registry-service.ts`), а `ProviderSettingsView` видит их как
обычные provider'ы. **[код]**

Предлагаемая схема:

```
LocalModelRuntimeService (host)
  owns: child process, download, health, port, token
  states: stopped -> starting -> ready -> stopping -> stopped
                 \-> failed
  events: onDidChange(reason)

LocalModelProviderCatalogSource implements ProviderSource<RuntimeProviderCatalogSnapshot>
  read():
    if state != ready: return { revision: "local:stopped", providers: [] }
    return { revision: `local:${version}:${model}`, providers: [provider] }
  onDidChange(): subscribe to runtime events
```

`read()` в `stopped` **не делает** network/spawn; это гарантия I1 на уровне кода, а не
соглашение. При `/local start` source emits change, registry пересобирается, provider
появляется в model list. При `/local stop` — исчезает. **[код + вывод]**

### 8.3 Команды

```
/local start [--engine vllm|llama.cpp] [--model qwen3.8-pi] [--yes]
/local stop
/local status
```

`/local start`:

1. Проверяет память/диск/бинарь. На 16 ГБ отказывает с объяснением, а не пытается
   запустить Q4.
2. Если весов нет — показывает размер и просит подтверждение; `--yes` только для
   автоматизации, не по умолчанию.
3. Запускает сервер на loopback с эфемерным портом и токеном.
4. Ждёт `/health` и `/v1/models` с таймаутом.
5. Публикует provider как `openai-chat-completions`, модель `qwen3.8-pi`, контекст
   131 072, max output 32 768, thinking off на сервере.
6. Выбирает модель в текущей сессии (или предлагает выбрать).

`/local stop`:

1. Останавливает процесс и ждёт exit.
2. Публикует пустой snapshot.
3. Снимает выбор модели, если она была локальной.

`/local status`: состояние, порт, модель, health, использование памяти.

### 8.4 Почему не `/start`

`/start` уже занят: `ZCODE_NATIVE_AGENT_COMMANDS.start` маршрутизирует задачу через
профиль `start` и `Task(start)`. Если перегрузить `/start` запуском локальной модели,
сломается существующий контракт. Поэтому явная команда — `/local start`; если нужен
короткий alias, `/local-model start`, но не голый `/start`. **[код:
`builtin-prompt-command.ts`]**

---

## 9. Решающий A/B: что именно мерить

### 9.1 Дизайн

- **Задачи:** 50–100 реальных задач ZCode из этого репозитория (bugfix, feature, refactor),
  3 уровня сложности, одинаковые workspace snapshots и проверки. Не брать задачи из
  обучающего набора, если появится ZCode-адаптер.
- **Руки:**
  1. Base Qwen3.8-27B, thinking off.
  2. Base Qwen3.8-27B, thinking xhigh (референс качества).
  3. Pi-адаптер, thinking off, полный ZCode tool surface.
  4. Pi-адаптер, thinking off, local-lite + pi-compat.
  5. Текущая облачная модель ZCode (референс продукта).
- **Попытки:** 1 attempt/task для pass@1; 3 attempts на 20 задачах для дисперсии.
- **Параметры:** temperature 0.8 для совместимости с обучением адаптера; для base/облака
  дополнительно 0.2, если продукт так работает. Зафиксировать в отчёте.
- **Порядок:** рандомизировать, чтобы прогрев/кэш не благоприятствовал одной руке.

### 9.2 Метрики

Использовать уже существующие таблицы `model_usage`, `turn_usage`, `tool_usage`:
`tool_call_count`, `model_request_count`, `input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `duration_ms`, `time_to_first_token_ms`, `error_type`.

Дополнительно:

- pass@1 по verifier;
- malformed tool calls / validation errors (главный риск схем);
- `error_max_turns` (для субагентов);
- context overflow;
- tool calls per step (не только total): адаптер может выиграть по total, но проиграть
  по параллелизму;
- wall-clock и TTFT;
- стоимость (для облака).

### 9.3 Статистика

50 задач дают примерно ±14 п.п. на 95% интервале для разницы; чтобы уверенно заявить +10 п.п.,
нужно ~100 задач или несколько повторов. Использовать paired bootstrap и exact sign test,
как в карточках Harness Hub. **[источник: методика карточек]**

### 9.4 Критерий принятия

Включать локальный профиль, только если:

- нижняя граница 95% CI для pass@1 > 0;
- tool calls снижены ≥20%;
- malformed tool calls <2%;
- нет роста critical safety violations;
- wall-clock не хуже текущей облачной модели более чем на 30% на типовой задаче.

Иначе — не включать. **[вывод]**

---

## 10. Ограничения этого отчёта

- 27B не запускалась: нет памяти/GPU; все tok/s — оценки, а не замеры.
- Токены tool-схем считаны как 4 символа/токен; `estimateTokens` ZCode — эвристика, не BPE.
  Отношения устойчивы, абсолютные значения — приблизительны.
- 33-инструментный срез — реконструкция типового root, а не реальный provider payload
  конкретной сессии; точное число зависит от gate-флагов и портов.
- Cross-harness числа взяты из блога/карточек, независимо не воспроизведены.
- Перенос на ZCode не измерен; все проценты в §6 — гипотезы.
- Оценки стоимости обучения ZCode-адаптера не делались.

---

## 11. Источники

Дата обращения: 2026-11-20.

- HF model card: `https://huggingface.co/harness-hub/Qwen3.8-27B-pi-adapted`
- HF adapter config: `https://huggingface.co/harness-hub/Qwen3.8-27B-pi-adapted/raw/main/adapter_config.json`
- HF GGUF card: `https://huggingface.co/harness-hub/Qwen3.8-27B-pi-adapted-GGUF`
- HF base model card: `https://huggingface.co/Qwen/Qwen3.8-27B`
- HF base config: `https://huggingface.co/Qwen/Qwen3.8-27B/raw/main/config.json`
- Harness adapters blog: `https://huggingface.co/blog/harness-adapters-at-scale`
  (raw: `https://raw.githubusercontent.com/huggingface/blog/main/harness-adapters-at-scale.md`)
- Super-adapter card: `https://huggingface.co/harness-hub/Qwen3.8-27B-super-adapter`
- OpenCode adapter card: `https://huggingface.co/harness-hub/Qwen3.8-27B-opencode-adapted`
- pi repository: `https://github.com/earendil-works/pi` (clone `main`, commit on 2026-11-20)
- ZCode code:
  - `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
  - `apps/zcode-cli/packages/core/src/context/sections/identity.ts`
  - `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
  - `apps/zcode-cli/packages/core/src/subagent/built-in-profiles.ts`
  - `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts`
  - `packages/provider/src/sources.ts`
  - `packages/services/src/model-provider/providerRuntime.ts`
  - `packages/services/src/model-provider/providerFacadeServices.ts`
  - `packages/shared/src/validationAppSettings.ts`
  - `docs/specs/max-turns-limit.md`
  - `docs/specs/2026-11-18-parallel-tools-and-async-agents.md`
- ZCode docs: `docs/architecture/stage4-4-prompts-benchmark.md`,
  `docs/testing/desktop-local-model-provider-p0-e2e-cases.md`.

---

## Приложение A. Команды запуска (для машины с достаточной памятью)

### vLLM, BF16 + LoRA (эталонный режим)

```sh
vllm serve Qwen/Qwen3.8-27B \
  --enable-lora --max-lora-rank 32 \
  --lora-modules qwen3.8-pi=harness-hub/Qwen3.8-27B-pi-adapted \
  --language-model-only --enable-prefix-caching --mamba-cache-mode align \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  --max-model-len 131072
```

ZCode provider: `openai-chat-completions`, base URL `http://127.0.0.1:8000/v1`,
model id `qwen3.8-pi`, dummy API key. **Не полагаться на auto-detect**: вручную
зафиксировать Chat Completions, потому что адаптер не обучался на Responses API.
**[источник: adapter card]**

### llama.cpp, GGUF + LoRA (компактнее, но не переоценено)

```sh
llama serve -m Qwen3.8-27B-Q8_0.gguf \
  --lora Qwen3.8-27B-pi-lora-F16.gguf \
  --chat-template-kwargs '{"enable_thinking": false}' \
  -c 65536 --port 8080 --alias qwen3.8-pi
```

Карточка GGUF прямо говорит: **GGUF-версия не переоценивалась**, а квантование базы
уводит от обученного BF16-поведения. Q4_K_M — ещё дальше. Для точности — vLLM BF16;
для 16 ГБ — не вариант. **[источник: GGUF card]**

### ZCode provider (концептуально)

- `api.type`: `openai-chat-completions`
- `baseUrl`: loopback URL сервера
- `apiKey`: dummy/локальный токен
- `model.id`: `qwen3.8-pi`
- `contextWindow`: 131072
- `maxOutputTokens`: 32768
- thinking: выключен на сервере, не через клиент

---

## Приложение B. Почему «4.5×» — не про скорость локального ZCode

| Сравнение                               | SWE-bench Pro, generated tokens |                               Отношение |
| --------------------------------------- | ------------------------------: | --------------------------------------: |
| Адаптер vs база, thinking off           |                    6.9k vs 9.6k |                                    1.4× |
| Адаптер vs база, thinking xhigh         |                   9.4k vs 48.8k | ≈4.5–5.2× (карточка округляет до ≈4.5×) |
| Адаптер vs база, TB 2.1, thinking off   |                    1.5k vs 2.9k |                                    1.9× |
| Адаптер vs база, TB 2.1, thinking xhigh |                   3.7k vs 16.5k |                                    4.5× |

Если ZCode уже работает с thinking off, ориентир — 1.4–1.9× по generated tokens, а не 4.5×.
Если сравнивать с thinking xhigh, 4.5× корректен, но тогда и качество базы выше. **[источник +
вывод]**
