import { descriptorForName, type LanguageId } from "./languageRegistry.js";
import { acquireParser, type TsParser } from "./parserPool.js";

export interface ParserAcquisition {
  parser: TsParser;
  languageId: LanguageId;
}

const acquisitions = new Map<string, Promise<ParserAcquisition | null>>();

/**
 * Возвращает парсер для языка или `null`, если `.wasm`-грамматика недоступна.
 * Результат (включая `null`) кешируется: одна неудачная грамматика не должна
 * повторять `Language.load` на каждом файле.
 */
export function acquisitionFor(languageName: string): Promise<ParserAcquisition | null> {
  const cached = acquisitions.get(languageName);
  if (cached) return cached;
  const descriptor = descriptorForName(languageName);
  if (!descriptor?.wasm) {
    const resolved = Promise.resolve<ParserAcquisition | null>(null);
    acquisitions.set(languageName, resolved);
    return resolved;
  }
  const pending = acquireParser(descriptor.wasm).then((parser) =>
    parser ? { parser, languageId: descriptor.id } : null,
  );
  acquisitions.set(languageName, pending);
  return pending;
}

/** Сброс кеша нужен тестам и перезапуску воркера. */
export function resetParserAccess(): void {
  acquisitions.clear();
}
