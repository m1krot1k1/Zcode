# Changelog

## [3.17.123](https://github.com/m1krot1k1/Zcode/compare/v3.17.122...v3.17.123) (2026-11-17)

### Features

* **code-index:** v3 с Tree-sitter AST, графом символов и гибридным поиском (этап 4.3) ([f9e0ff9](https://github.com/m1krot1k1/Zcode/commit/f9e0ff966eac25f4521a09d55a527a511807c9bd))

* **core:** детерминированный автомат сессий, самовосстановление вызовов инструментов и кэширование промптов (этап 4.1) ([47daa22](https://github.com/m1krot1k1/Zcode/commit/47daa22bed3137807e8a7d5c4cf9051deece7de7))

* **exec:** песочница bwrap/Seatbelt, PTY-сессии, Computer Use и auto-repair (этап 4.5) ([4be5c50](https://github.com/m1krot1k1/Zcode/commit/4be5c5027126ad78e55ebe70196f3d5041d1557d))

* **prompts:** промпты v2, когнитивные протоколы и сервис улучшения промптов (этап 4.4) ([b5d7b91](https://github.com/m1krot1k1/Zcode/commit/b5d7b91f848993018b9f73d18445f71890c30eb4))

* **shared:** нотификация мутаций код-индекса, сервисные порты и архитектурная политика этапов 4-5 ([3b84379](https://github.com/m1krot1k1/Zcode/commit/3b84379eb6190669cbaa770779601385c0c364ef))

* **tools:** транзакционное мультифайловое редактирование, движок диффов и фоновые задачи (этап 4.2) ([16c1df2](https://github.com/m1krot1k1/Zcode/commit/16c1df2eff4945daafe66daf3e58f7fe9a8dbcd8))

* **ui:** ghost-text автодополнение, кнопка/команда enhance и единые настройки (этап 4.6) ([0181824](https://github.com/m1krot1k1/Zcode/commit/0181824e16d0a589d0a71e248568ab0505532fd5))

* **zcode-cli:** добавление атомарных файловых транзакций и MultiEdit ([1896ba1](https://github.com/m1krot1k1/Zcode/commit/1896ba1d417ac0d08e67d302470473786cc56957))

* **zcode-cli:** усиление контроля за выполнением вызовов инструментов ([46e96d8](https://github.com/m1krot1k1/Zcode/commit/46e96d8b4d29e9b2b604deb7bef6d9c394290230))
  * восстановление усеченных аргументов вызова инструмента, когда finishReason имеет значение length,
  * добавление детерминированного конвейера самовосстановления для некорректных входных данных JSON/Zod
  * сериализация записи файлов между родительскими и дочерними агентами с помощью общего реестра блокировок файлов и волнового планирования DAG для перекрывающихся путей записи
  * внедрение точек останова для кэша подсказок Anthropic/OpenRouter и нормализация
  * запись переходов между состояниями и пошаговой диагностики в сохраняемые
  * ограничение рабочего контекста и бюджета вывода с учетом рассуждений, чтобы большие


### Documentation

* **architecture:** аудит, целевая архитектура, бенчмарки и приёмочные отчёты (этапы 1-6) ([f14af28](https://github.com/m1krot1k1/Zcode/commit/f14af289d2966ccf7e9bdb81ee6492a0f65dd6f0))
