/** Automations 主视图的 toast 统一挂到页面锚点，避免弹层定位到全局容器。 */
import { toast as showToast, type ToastOptions } from "@/components/ui/toast.js";

export const AUTOMATIONS_TOAST_ANCHOR_ID = "automations-main-toast-anchor";

export function toast(message: string, options?: ToastOptions): number {
  return showToast(message, {
    ...options,
    anchorId: AUTOMATIONS_TOAST_ANCHOR_ID,
  });
}
