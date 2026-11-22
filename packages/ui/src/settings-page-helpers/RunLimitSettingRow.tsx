/**
 * 运行上限输入行：草稿态、脏检查、保存中与非法值提示。
 *
 * 从 `settingsPageHelpers.tsx` 拆出，`RunLimitSaveResult` 语义与保存流程不变。
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 单次保存结果：empty/invalid 都不写 settings，保证“留空 = 用默认值”。 */
export type RunLimitSaveResult = "saved" | "empty" | "invalid";

export function RunLimitSettingRow({
  labelId,
  descriptionId,
  invalidId,
  placeholder,
  testId: fieldTestId,
  value,
  onSave,
}: {
  labelId: string;
  descriptionId: string;
  invalidId: string;
  placeholder: string;
  testId: string;
  value?: number;
  onSave: (raw: string) => Promise<RunLimitSaveResult>;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(value === undefined ? "" : String(value));
    setInvalid(false);
  }, [value]);
  const saved = value === undefined ? "" : String(value);
  const dirty = draft.trim() !== saved;
  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const result = await onSave(draft);
      setInvalid(result === "invalid");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsRow
      label={intl.formatMessage({ id: labelId })}
      description={intl.formatMessage({ id: descriptionId })}
      detail={
        <div className="space-y-2">
          <Input
            size="lg"
            inputMode="numeric"
            className="max-w-[240px] font-mono"
            value={draft}
            placeholder={placeholder}
            aria-label={intl.formatMessage({ id: labelId })}
            aria-invalid={invalid}
            data-testid={fieldTestId}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSave();
            }}
          />
          {invalid ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {intl.formatMessage({ id: invalidId })}
            </p>
          ) : null}
        </div>
      }
      control={
        <Button
          type="button"
          size="lg"
          disabled={!dirty || saving}
          data-testid={`${fieldTestId}-save`}
          onClick={() => void handleSave()}
        >
          {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
        </Button>
      }
    />
  );
}
