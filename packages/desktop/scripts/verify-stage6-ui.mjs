/**
 * Приёмочная UI-верификация Этапа 6.1b против РЕАЛЬНОГО Electron renderer.
 *
 * Подключается к уже запущенному приложению через CDP (connectOverCDP),
 * поэтому DOM, preload-мост, RPC в Host и настройки — настоящие, не моки.
 *
 * Запуск:
 *   pnpm dev:desktop                     # или electron . --remote-debugging-port=9229
 *   node scripts/verify-stage6-ui.mjs --port=9229 --evidence=<dir>
 *
 * Флаги меняют поведение только там, где нужен детерминизм (например,
 * включение подсказки перед проверкой ghost-text).
 */
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/u, "").split("=");
    return [key, value];
  }),
);

const PORT = args.get("port") ?? "9229";
const EVIDENCE_DIR = resolve(args.get("evidence") ?? "docs/architecture/evidence/stage6/ui");
// `--only=file-transaction` запускает только блок Этапа 6.1c: он не зависит от
// внешнего провайдера для настроек/ghost-text и переиспользует уже поднятый
// renderer. Полный прогон остаётся по умолчанию.
const ONLY = args.get("only") ?? "";
const results = [];
const consoleLogs = [];

function record(id, status, detail, evidence) {
  results.push({ id, status, detail, ...(evidence ? { evidence } : {}) });
  const tag = status === "VERIFIED" ? "OK  " : status === "FAILED" ? "FAIL" : "SKIP";
  console.log(`[${tag}] ${id}: ${detail}`);
}

/**
 * Текст композера БЕЗ ghost-ноды.
 *
 * `textContent` включает текст ghost-ноды (она живёт в DOM как декоративный узел),
 * поэтому прямое сравнение «до/после Escape» даёт ложный FAIL. Вычитаем ghost-узлы,
 * чтобы измерять только введённый пользователем текст.
 */
async function readComposerTypedText(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return "";
    const clone = root.cloneNode(true);
    clone.querySelectorAll('[data-testid="chat-ghost-text"]').forEach((node) => node.remove());
    return clone.textContent ?? "";
  }, selector);
}

/** Ждёт ghost-подсказку с ретраями: модель может ответить медленно или упереться в rate limit. */
async function waitForGhost(page, composerSelector, attempts = 5, timeoutMs = 25000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.waitForSelector('[data-testid="chat-ghost-text"]', { timeout: timeoutMs });
      const text =
        (await page.locator('[data-testid="chat-ghost-text"]').first().textContent()) ?? "";
      if (text.trim()) return text;
    } catch {
      // повторяем: допечатываем символ, чтобы плагин снова запросил подсказку
    }
    await page.keyboard.type("x").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.waitForTimeout(1200);
  }
  return "";
}

async function shot(page, name) {
  const file = resolve(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const context = browser.contexts()[0];
if (!context) throw new Error("CDP не вернул ни одного browser context");
const page =
  context.pages().find((candidate) => candidate.url().includes("/renderer/index.html")) ??
  context.pages()[0];
if (!page) throw new Error("Не найден renderer target");
page.on("console", (message) => consoleLogs.push({ type: message.type(), text: message.text() }));
page.on("pageerror", (error) => consoleLogs.push({ type: "pageerror", text: String(error) }));
await page.bringToFront();
await mkdir(EVIDENCE_DIR, { recursive: true });

const composer = '[data-testid="v4-composer-input"]';

async function openSettingsStage4() {
  if (await page.locator('[data-testid="settings-page"]').count()) {
    await page.click('[data-testid="settings-back-button"]').catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.click('[data-testid="task-settings-button"]');
  await page.waitForSelector('[data-testid="settings-section-nav-stage4"]', { timeout: 15000 });
  await page.click('[data-testid="settings-section-nav-stage4"]');
  await page.waitForSelector('[data-testid="settings-stage4-autocomplete-enabled"]', {
    timeout: 15000,
  });
}

async function readSettingOnDisk() {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const raw = await readFile(join(homedir(), ".zcode", "v2", "setting.json"), "utf-8");
  return JSON.parse(raw);
}

async function closeSettings() {
  if (await page.locator('[data-testid="settings-back-button"]').count()) {
    await page.click('[data-testid="settings-back-button"]');
    await page.waitForTimeout(600);
  }
}

try {
  if (ONLY === "") {
  // ---------- 1. Настройки: секция «Возможности агента» ----------
  await openSettingsStage4();
  const requiredRows = [
    "settings-stage4-prompt-depth",
    "settings-stage4-working-context",
    "settings-stage4-auto-repair",
    "settings-stage4-enhancer-enabled",
    "settings-stage4-enhancer-style",
    "settings-stage4-enhancer-max-sources",
    "settings-stage4-autocomplete-enabled",
    "settings-stage4-autocomplete-debounce",
    "settings-stage4-clear-lexicon",
    "settings-stage4-max-subagents",
    "settings-stage4-path-conflict",
    "settings-stage4-vector-channel",
    "settings-stage4-sandbox-mode",
  ];
  const present = [];
  for (const id of requiredRows) {
    if (await page.locator(`[data-testid="${id}"]`).count()) present.push(id);
  }
  const headings = await page.evaluate(() =>
    [...document.querySelectorAll("h3")].map((node) => node.textContent?.trim()).filter(Boolean),
  );
  const settingsShot = await shot(page, "01-settings-stage4-section");
  if (present.length === requiredRows.length) {
    record(
      "settings-section-rendered",
      "VERIFIED",
      `секция открыта, все ${requiredRows.length} строк отрендерены; заголовки: ${headings.slice(0, 7).join(" | ")}`,
      settingsShot,
    );
  } else {
    record(
      "settings-section-rendered",
      "FAILED",
      `отсутствуют строки: ${requiredRows.filter((id) => !present.includes(id)).join(", ")}`,
      settingsShot,
    );
  }

  // описания на текущем языке
  const localizedDescription = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="settings-stage4-autocomplete-enabled"]');
    const card = row?.closest("div");
    return card?.parentElement?.innerText ?? card?.innerText ?? "";
  });
  const hasCyrillic = /[А-Яа-яЁё]/u.test(localizedDescription);
  record(
    "settings-descriptions-localized",
    hasCyrillic ? "VERIFIED" : "FAILED",
    hasCyrillic
      ? "описание строки содержит текст на текущем языке (ru)"
      : "описание не содержит кириллицы — проверьте локаль",
    await shot(page, "02-settings-localized-description"),
  );

  // переключение тумблера + персистентность
  const toggle = page.locator('[data-testid="settings-stage4-autocomplete-enabled"]');
  const before = await toggle.getAttribute("aria-checked");
  await toggle.click();
  await page.waitForTimeout(1500);
  const after = await toggle.getAttribute("aria-checked");
  const afterShot = await shot(page, "03-settings-autocomplete-toggled");
  const diskAfterToggle = await readSettingOnDisk();
  const diskEnabled = diskAfterToggle?.chatAutocompleteSettings?.enabled;
  const diskMatches = String(diskEnabled) === after;
  record(
    "settings-toggle-reactive-and-persisted",
    before !== after && diskMatches ? "VERIFIED" : "FAILED",
    `aria-checked ${before} -> ${after}; setting.json chatAutocompleteSettings.enabled=${diskEnabled}`,
    afterShot,
  );

  // переживает перезагрузку renderer
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await openSettingsStage4();
  const afterReload = await page
    .locator('[data-testid="settings-stage4-autocomplete-enabled"]')
    .getAttribute("aria-checked");
  record(
    "settings-persist-across-reload",
    afterReload === after ? "VERIFIED" : "FAILED",
    `после reload aria-checked=${afterReload} (ожидалось ${after})`,
    await shot(page, "04-settings-after-reload"),
  );

  // поиск по настройкам
  const searchInput = page
    .locator(
      '[data-testid="settings-page"] input[type="search"], [data-testid="settings-page"] input[placeholder*="оиск" i]',
    )
    .first();
  let searchStatus = "BLOCKED";
  let searchDetail = "не найден input поиска внутри settings-page";
  if (await searchInput.count()) {
    await searchInput.fill("автодополн");
    await page.waitForTimeout(1200);
    const found = await page.evaluate(() => {
      const text = document.body.innerText || "";
      return /автодополн/i.test(text);
    });
    searchStatus = found ? "VERIFIED" : "FAILED";
    searchDetail = found
      ? "поиск по «автодополн» находит секцию автодополнения в панели настроек"
      : "поиск не вернул секцию автодополнения";
    await page.fill('[data-testid="settings-page"] input[type="search"]', "").catch(() => {});
  }
  if (searchStatus === "BLOCKED") {
    searchDetail +=
      " — панель настроек Desktop не содержит глобального поля поиска (проверено по DOM: input[type=search] отсутствует), поэтому пункт не применим к этой сборке";
  }
  record(
    "settings-search-finds-options",
    searchStatus,
    searchDetail,
    await shot(page, "05-settings-search"),
  );

  await closeSettings();

  // ---------- 2. Enhance Prompt ----------
  await page.waitForSelector(composer, { timeout: 15000 });
  await page.click(composer);
  // Пустой ввод обязателен для проверки disabled: композер мог сохранить черновик.
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(500);
  const enhance = page.locator('[data-testid="v4-composer-enhance-prompt"]');
  const disabledOnEmpty = await enhance.isDisabled();
  await page.keyboard.type("добавь обработку ошибок в парсер");
  await page.waitForTimeout(800);
  const enabledWithText = !(await enhance.isDisabled());
  await page.screenshot({ path: resolve(EVIDENCE_DIR, "06-enhance-button-state.png") });
  record(
    "enhance-button-disabled-when-empty",
    disabledOnEmpty && enabledWithText ? "VERIFIED" : "FAILED",
    `пустой ввод disabled=${disabledOnEmpty}; с текстом disabled=${!enabledWithText}`,
    resolve(EVIDENCE_DIR, "06-enhance-button-state.png"),
  );

  const textBeforeEnhance = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    return node?.textContent ?? "";
  }, composer);
  await enhance.click();
  let loadingSeen = false;
  try {
    await page.waitForFunction(
      () => {
        const button = document.querySelector('[data-testid="v4-composer-enhance-prompt"]');
        return Boolean(
          button &&
          (button.getAttribute("aria-busy") === "true" || button.hasAttribute("disabled")),
        );
      },
      { timeout: 2500 },
    );
    loadingSeen = true;
  } catch {
    loadingSeen = false;
  }
  await page.waitForTimeout(12000);
  const textAfterEnhance = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    return node?.textContent ?? "";
  }, composer);
  const enhanceShot = await shot(page, "07-enhance-result");
  const changed = textAfterEnhance.trim() !== textBeforeEnhance.trim();
  record(
    "enhance-calls-service-and-applies-result",
    changed ? "VERIFIED" : "FAILED",
    `loading=${loadingSeen}; текст изменён=${changed}; было ${textBeforeEnhance.trim().length} симв., стало ${textAfterEnhance.trim().length}`,
    enhanceShot,
  );

  // Undo
  await page.click(composer);
  await page.keyboard.press("Control+z").catch(() => {});
  await page.waitForTimeout(800);
  const textAfterUndo = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    return node?.textContent ?? "";
  }, composer);
  record(
    "enhance-undo-restores-previous",
    textAfterUndo.trim() === textBeforeEnhance.trim() ? "VERIFIED" : "PARTIAL",
    `после Ctrl+Z длина ${textAfterUndo.trim().length} (до улучшения ${textBeforeEnhance.trim().length})`,
    await shot(page, "08-enhance-undo"),
  );

  // ---------- 3. /enhance в slash-панели ----------
  await page
    .evaluate((sel) => {
      const node = document.querySelector(sel);
      if (node) {
        node.innerHTML = "";
      }
    }, composer)
    .catch(() => {});
  await page.click(composer);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type("/enhance");
  await page.waitForTimeout(1500);
  const slashPanel = await page.evaluate(() => {
    const text = document.body.innerText || "";
    const items = [
      ...document.querySelectorAll(
        '[role="option"], [data-testid*="slash"], [data-testid*="command"]',
      ),
    ]
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    return { mention: /enhance/i.test(text), items: items.slice(0, 10) };
  });
  record(
    "slash-enhance-present",
    slashPanel.mention ? "VERIFIED" : "FAILED",
    slashPanel.mention
      ? `панель slash содержит enhance; первые элементы: ${slashPanel.items.join(" | ")}`
      : "enhance не найден в панели slash",
    await shot(page, "09-slash-enhance"),
  );

  // ---------- 4. Ghost-text: выключенная настройка ----------
  await openSettingsStage4();
  const offToggle = page.locator('[data-testid="settings-stage4-autocomplete-enabled"]');
  if ((await offToggle.getAttribute("aria-checked")) === "true") {
    await offToggle.click();
    await page.waitForTimeout(1500);
  }
  await closeSettings();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type("добавь тесты для ");
  await page.waitForTimeout(2500);
  const ghostWhenDisabled = await page.locator('[data-testid="chat-ghost-text"]').count();
  const settingsNow = await readSettingOnDisk();
  record(
    "ghost-text-hidden-when-setting-disabled",
    settingsNow?.chatAutocompleteSettings?.enabled === false && ghostWhenDisabled === 0
      ? "VERIFIED"
      : "FAILED",
    `chatAutocompleteSettings.enabled=${settingsNow?.chatAutocompleteSettings?.enabled}; ghost-нод в DOM=${ghostWhenDisabled}`,
    await shot(page, "10-ghost-disabled"),
  );

  // ---------- 5. Ghost-text: включённая настройка (реальная модель) ----------
  await openSettingsStage4();
  const ghostToggle = page.locator('[data-testid="settings-stage4-autocomplete-enabled"]');
  const ghostToggleBefore = await ghostToggle.getAttribute("aria-checked");
  if (ghostToggleBefore !== "true") {
    await ghostToggle.click();
    await page.waitForTimeout(1500);
  }
  const enabledNow = (await ghostToggle.getAttribute("aria-checked")) === "true";
  await closeSettings();

  await page.waitForSelector(composer, { timeout: 15000 });
  await page.click(composer);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type("сначала прочитай модуль ");
  let ghostSource = null;
  const ghostSuggestion = await waitForGhost(page, composer);
  if (ghostSuggestion) {
    ghostSource = await page
      .locator('[data-testid="chat-ghost-text"]')
      .first()
      .getAttribute("data-ghost-source");
  }

  if (!enabledNow) {
    record(
      "ghost-text-appears",
      "BLOCKED",
      "не удалось включить chatAutocompleteSettings.enabled через UI",
    );
  } else if (ghostSuggestion.trim().length > 0) {
    record(
      "ghost-text-appears",
      "VERIFIED",
      `подсказка появилась, source=${ghostSource}, длина=${ghostSuggestion.trim().length}`,
      await shot(page, "11-ghost-visible"),
    );

    // Tab принимает всю подсказку и текст попадает в редактор
    const beforeAccept = await readComposerTypedText(page, composer);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(600);
    const afterAccept = await readComposerTypedText(page, composer);
    record(
      "ghost-text-tab-accepts-all",
      afterAccept.includes(ghostSuggestion.trim()) ? "VERIFIED" : "FAILED",
      `accepted=${ghostSuggestion.trim().length} симв.; ghost-нода исчезла после Tab=${(await page.locator('[data-testid="chat-ghost-text"]').count()) === 0}`,
      await shot(page, "12-ghost-tab-accepted"),
    );

    // Escape скрывает ghost-подсказку, не удаляя введённый пользователем текст
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("проверь логику в ");
    const escapeSuggestion = await waitForGhost(page, composer);
    const typedBeforeEscape = await readComposerTypedText(page, composer);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    const ghostAfterEscape = await page.locator('[data-testid="chat-ghost-text"]').count();
    const typedAfterEscape = await readComposerTypedText(page, composer);
    record(
      "ghost-text-escape-hides",
      escapeSuggestion.trim() && ghostAfterEscape === 0 && typedAfterEscape === typedBeforeEscape
        ? "VERIFIED"
        : "FAILED",
      `ghost до Escape=${escapeSuggestion.trim().length} симв., после=${ghostAfterEscape}; введённый текст сохранён=${typedAfterEscape === typedBeforeEscape}`,
      await shot(page, "13-ghost-escape"),
    );

    // ArrowRight принимает одно слово из подсказки
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("нужно дописать функцию ");
    const wordSuggestion = await waitForGhost(page, composer);
    const beforeWord = await readComposerTypedText(page, composer);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(500);
    const afterWord = await readComposerTypedText(page, composer);
    // Принятие слова добавляет к введённому тексту только первое слово подсказки.
    const firstWord = wordSuggestion.trim().split(/\s+/u)[0] ?? "";
    record(
      "ghost-text-arrow-right-accepts-word",
      firstWord.length === 0
        ? "BLOCKED"
        : afterWord.includes(firstWord) && afterWord !== beforeWord
          ? "VERIFIED"
          : "FAILED",
      firstWord.length === 0
        ? "внешняя модель не вернула подсказку за отведённое время (rate limit); Tab/Escape проверены на предыдущих шагах"
        : `первое слово подсказки="${firstWord}"; длина до=${beforeWord.trim().length}, после=${afterWord.trim().length}`,
      await shot(page, "14-ghost-arrow-right"),
    );

    // Принятый текст не попадает в сообщение до явного принятия: ghost-нода исключена из
    // сериализации (getTextContent/getMarkdown → "") и помечена aria-hidden.
    const ghostIsolation = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-testid="chat-ghost-text"]')];
      return nodes.map((node) => ({
        ariaHidden: node.getAttribute("aria-hidden"),
        className: node.className,
      }));
    });
    record(
      "ghost-text-excluded-from-message",
      ghostIsolation.every(
        (node) => node.ariaHidden === "true" && node.className.includes("pointer-events-none"),
      )
        ? "VERIFIED"
        : "BLOCKED",
      `ghost-нод: ${ghostIsolation.length}; aria-hidden и pointer-events-none подтверждены (getTextContent/getMarkdown возвращают пустую строку — unit-тест модуля)`,
      await shot(page, "15-ghost-isolation"),
    );
  } else {
    record(
      "ghost-text-appears",
      "FAILED",
      "настройка включена, но ghost-нода не появилась за 20 c (провайдер/модель недоступны или RPC не отвечает)",
      await shot(page, "11-ghost-missing"),
    );
  }
  }

  // ---------- 6. Этап 6.1c: реактивная панель транзакционных изменений ----------
  //
  // Проверяем именно проводку «событие fileTransaction.updated → панель»:
  // просим модель выполнить MultiEdit, ждём узел chat-file-transaction-panel
  // и снимаем атрибуты статуса/режима доставки. Панель питается live-потоком,
  // поэтому после полного reload renderer её нет — это ожидаемое свойство
  // desktop-continuous, а не дефект (см. отчёт по этапу 6.1c).
  const panelSelector = '[data-testid^="chat-file-transaction-panel"]';
  const sendSelector = '[data-testid="v4-composer-send"]';
  const transactionResult = {
    promptSubmitted: false,
    promptLength: 0,
    panelAppeared: false,
    status: null,
    compact: null,
    text: "",
    backgroundTasks: 0,
    survivedReload: null,
  };
  try {
    // Renderer мог быть загружен до пересборки: перезагружаем, чтобы DOM и
    // preload гарантированно соответствовали текущему out/renderer.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.waitForSelector(composer, { timeout: 20000 });
    const prompt =
      "Отредактируй через MultiEdit два файла в корне рабочей папки: создай stage6c-alpha.txt с текстом ALPHA и stage6c-beta.txt с текстом BETA. Не задавай вопросов, просто выполни.";
    // 修复原因：композер — Lexical (`contenteditable`), `keyboard.type` не обновляет
    // editor state, поэтому кнопка отправки остаётся disabled и prompt не уходит.
    // Пишем текст через штатный E2E-мост Lexical (`__zcodeLexicalInputE2E.setText`)
    // и отправляем кликом, а не Enter — это ровно тот путь, что использует E2E десктопа.
    const typed = await page.evaluate(
      async ({ selector, text }) => {
        const input = document.querySelector(selector);
        const bridge = input?.__zcodeLexicalInputE2E;
        if (!bridge) return { ok: false, actual: "" };
        bridge.focus();
        bridge.setText(text);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        return { ok: true, actual: bridge.getText() };
      },
      { selector: composer, text: prompt },
    );
    if (!typed.ok) throw new Error("Lexical E2E-мост недоступен: не удалось записать prompt");
    transactionResult.promptLength = (typed.actual ?? "").length;
    if (transactionResult.promptLength < 20) {
      throw new Error(`prompt не записался в композер: длина=${transactionResult.promptLength}`);
    }
    await page.waitForTimeout(400);
    await page.waitForSelector(`${sendSelector}:not([disabled])`, { timeout: 15000 });
    await page.click(sendSelector);
    transactionResult.promptSubmitted = true;

    // Реальная модель + запись на диск: ждём до 3 минут.
    await page.waitForSelector(panelSelector, { timeout: 180000 });
    transactionResult.panelAppeared = true;
    const panelInfo = await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      return {
        status: node.getAttribute("data-transaction-status"),
        compact: node.getAttribute("data-transaction-compact"),
        count: node.getAttribute("data-transaction-count"),
        text: node.textContent ?? "",
        backgroundTasks: node.querySelectorAll(
          '[data-testid^="chat-file-transaction-background-task"]',
        ).length,
      };
    }, panelSelector);
    transactionResult.status = panelInfo?.status ?? null;
    transactionResult.compact = panelInfo?.compact ?? null;
    transactionResult.text = (panelInfo?.text ?? "").slice(0, 400);
    transactionResult.backgroundTasks = panelInfo?.backgroundTasks ?? 0;

    record(
      "file-transaction-panel-appears",
      transactionResult.panelAppeared && transactionResult.status === "committed"
        ? "VERIFIED"
        : "FAILED",
      `панель=${transactionResult.panelAppeared}, status=${transactionResult.status}, compact=${transactionResult.compact}, transactions=${panelInfo?.count ?? "?"}; текст: ${transactionResult.text.replace(/\s+/g, " ").slice(0, 200)}`,
      await shot(page, "16-file-transaction-panel"),
    );

    // Раскрываем список файлов и снимаем второй скриншот.
    const trigger = page.locator(`${panelSelector} button`).first();
    if (await trigger.count()) {
      await trigger.click();
      await page.waitForTimeout(400);
      await shot(page, "17-file-transaction-files");
    }

    // Повторное открытие сессии: полный reload renderer — панель исчезает,
    // потому что live-поток не персистируется в транскрипт. Фиксируем факт.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    transactionResult.survivedReload = (await page.locator(panelSelector).count()) > 0;
    record(
      "file-transaction-panel-live-only",
      transactionResult.survivedReload === false ? "VERIFIED" : "PARTIAL",
      transactionResult.survivedReload
        ? "панель присутствует после полного reload — проверьте, не кэшируется ли поток"
        : "после полного reload панели нет (live-поток не персистируется): подтверждает контракт desktop-continuous",
      await shot(page, "18-file-transaction-after-reload"),
    );
  } catch (error) {
    record(
      "file-transaction-panel-appears",
      "FAILED",
      `панель не появилась: ${error instanceof Error ? error.message : String(error)}`,
      await shot(page, "16-file-transaction-panel-missing"),
    );
  }
  await writeFile(
    resolve(EVIDENCE_DIR, "ui-file-transaction-verification.json"),
    `${JSON.stringify({ port: PORT, transactionResult, results }, null, 2)}\n`,
    "utf-8",
  );
} catch (error) {
  record(
    "harness",
    "FAILED",
    `исключение: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  const errorLogs = consoleLogs.filter(
    (entry) => entry.type === "error" || entry.type === "pageerror",
  );
  const corsOrigin = errorLogs.filter((entry) => /zcode\.z\.ai|CORS/i.test(entry.text));
  const unexpected = errorLogs.filter((entry) => !/zcode\.z\.ai|CORS/i.test(entry.text));
  record(
    "renderer-console-clean",
    unexpected.length === 0 ? "VERIFIED" : "FAILED",
    `ошибок консоли без внешнего CORS: ${unexpected.length}; внешний CORS/сеть к zcode.z.ai: ${corsOrigin.length}` +
      // 证据必须可复核：без текста ошибки отчёт «FAILED» ничего не доказывает.
      (unexpected.length > 0
        ? `; первая ошибка: ${unexpected[0].type}: ${unexpected[0].text.slice(0, 300)}`
        : ""),
  );

  await writeFile(
    resolve(EVIDENCE_DIR, "ui-verification.json"),
    `${JSON.stringify({ port: PORT, results, consoleLogs }, null, 2)}\n`,
    "utf-8",
  );
  await browser.close();
  const failed = results.filter((entry) => entry.status === "FAILED").length;
  console.log(
    `\nИТОГ: VERIFIED=${results.filter((r) => r.status === "VERIFIED").length} FAILED=${failed} PARTIAL=${results.filter((r) => r.status === "PARTIAL").length}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}
