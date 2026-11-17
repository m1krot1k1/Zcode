# services-cua-linux-host

Нативный Computer Use на Linux. Владелец состояния — `LinuxCuaHost`: он держит открытый
`Display*`, сессию портала RemoteDesktop и кэш `probe()`. Снаружи видны только снимки.

## Инварианты

1. **Проба реальна и кэширована.** `probe()` проверяет каждое звено фактически:
   наличие бинарника (`grim`, `gnome-screenshot`, `import`, `scrot`, `ffmpeg`),
   доступность `libX11.so.6`/`libXtst.so.6`, ответ портала. Результат живёт
   `probeCacheMs` (30 с) и перепроверяется по `refresh: true`.
2. **`grim` не считается доступным только из-за PATH.** На X11 он установлен, но
   падает с `failed to create display`; провайдер требует `WAYLAND_DISPLAY` и
   подтверждается вызовом `grim -h` (`--version` не поддерживается).
3. **Недоступность структурна.** Нет графического хоста → `cua_unavailable` с
   `reason: "no-display-server"`. Нет ни одного захвата → `no-screen-capture-provider`.
   Нет ввода → `no-input-provider`. Исключения наружу не летят.
4. **Ввод реален.** X11-путь вызывает `XTestFakeMotionEvent`/`XTestFakeButtonEvent`/
   `XTestFakeKeyEvent` через koffi, затем `XSync` — чтобы чтение позиции сразу после
   движения было верным. Wayland-путь вызывает `Notify*` портала RemoteDesktop.
5. **Политики гранулярны.** `screenshot`/`pointer`/`keyboard`/`clipboard` проверяются
   до действия; запрет возвращает `permission_denied`, а не «тихо ничего не делает».
6. **Модификаторы не залипают.** `pressKey` отпускает нажатые модификаторы в `finally`;
   `dispose()` дополнительно вызывает `releaseModifiers()`.
7. **Ограничения честны.** Wheel-события и произвольный Unicode на чистом Wayland
   через портал не поддержаны (нет стандартного метода) — вместо «тихого no-op»
   возвращается ошибка с объяснением.
8. **`dispose()` идемпотентен** и закрывает `Display*` и портал-сессию.

## Пересечения

- `packages/services/src/node/cua-helpers.ts`: гейт платформы расширен на Linux.
- CUA Permission Broker: источник политик; хост их только исполняет.
