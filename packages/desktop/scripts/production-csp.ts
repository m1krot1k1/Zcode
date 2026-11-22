/**
 * Продакшн-CSP главного окна.
 *
 * Причина: meta-CSP общая для dev и production, а `'unsafe-inline'` в `script-src`
 * нужен только Vite dev (React Fast Refresh вставляет inline-модуль). В собранном
 * бандле inline-скриптов нет, поэтому production обязан работать без него — иначе
 * любая инъекция в renderer исполняется как скрипт и получает доступ к preload API.
 *
 * Политика остальных директив не меняется: renderer действительно ходит в
 * внешние https-источники (проверка MCP, удалённые изображения/медиа, share-страницы).
 */
const SCRIPT_SRC_DIRECTIVE = /script-src [^;]*;/u;

export function hardenProductionCsp(html: string): string {
  return html.replace(SCRIPT_SRC_DIRECTIVE, (directive) => {
    return directive.replace(" 'unsafe-inline'", "");
  });
}
