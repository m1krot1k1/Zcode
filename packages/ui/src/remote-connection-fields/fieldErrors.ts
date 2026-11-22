import type { RemoteFormField, RemoteFormFieldError } from "@/lib/remoteConnectionWizard.js";

export interface RemoteFieldErrorHelpers {
  errorOf: (field: RemoteFormField) => string | undefined;
  errorId: (field: RemoteFormField) => string;
  invalidProps: (
    field: RemoteFormField,
    flagged?: boolean,
  ) => {
    "aria-invalid": boolean | undefined;
    "aria-describedby": string | undefined;
  };
}

/**
 * 内联字段错误的统一查询与 aria 关联：各连接类型子组件只拿到 fieldId 与提交错误，
 * 保持原有的 aria-invalid / aria-describedby 语义。
 */
export function createRemoteFieldErrorHelpers(
  fieldId: string,
  fieldErrors: RemoteFormFieldError[],
): RemoteFieldErrorHelpers {
  const errorOf = (field: RemoteFormField) =>
    fieldErrors.find((error) => error.field === field)?.message;
  const errorId = (field: RemoteFormField) => `${fieldId}-${field}-error`;
  const invalidProps = (field: RemoteFormField, flagged = false) => ({
    "aria-invalid": errorOf(field) || flagged ? true : undefined,
    "aria-describedby": errorOf(field) ? errorId(field) : undefined,
  });

  return { errorOf, errorId, invalidProps };
}
