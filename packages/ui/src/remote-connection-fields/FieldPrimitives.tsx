import type { ReactNode } from "react";
import { AlertCircleIcon, AlertTriangleIcon, CheckIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

export function FieldLabel({
  htmlFor,
  id,
  children,
}: {
  htmlFor?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      id={id}
      className="mb-1.5 block text-ui-sm text-remote-foreground-muted"
    >
      {children}
    </label>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 flex items-start gap-1 text-ui-sm text-destructive">
      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** 字段下方提示：限制信息用 warning 卡片，粘贴识别用 success，其余中性。 */
export function FieldHint({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning" | "success";
  children: ReactNode;
}) {
  return (
    <p
      data-remote-field-hint={tone}
      className={cn(
        "mt-1.5 flex items-start gap-1.5 text-pretty text-ui-sm",
        tone === "muted" && "text-remote-foreground-muted",
        tone === "success" && "text-success",
        tone === "warning" &&
          "rounded-lg bg-warning-surface px-3 py-2 text-warning-surface-foreground",
      )}
    >
      {tone === "warning" ? <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
      {tone === "success" ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
      <span>{children}</span>
    </p>
  );
}
