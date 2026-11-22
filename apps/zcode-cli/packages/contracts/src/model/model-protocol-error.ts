import { ModelErrorCode } from "./index.js";

/**
 * Ошибка протокола модели вынесена из model/index.ts (файл перешёл порог 800 строк).
 * Зависимость от enum-а — значение, поэтому index ре-экспортирует класс, а не импортирует
 * его обратно в момент инициализации: цикла на уровне исполнения нет.
 */
export class ModelProtocolError extends Error {
  readonly code: ModelErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: ModelErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ModelProtocolError";
    this.code = code;
    this.context = context;
  }
}
