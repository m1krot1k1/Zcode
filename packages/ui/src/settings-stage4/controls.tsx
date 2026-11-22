import type { ReactNode } from "react";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * Общие контролы секций Этапа 4.
 *
 * Все контролы реактивные: значение приходит из `AppSettings`, а изменение сразу
 * уходит в `settingService` через `onChange`. Кнопки «Сохранить» нет.
 */

export function SwitchSettingRow({
  label,
  description,
  detail,
  checked,
  disabled,
  testId,
  onChange,
}: {
  label: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <SettingsRow
      label={label}
      {...(description !== undefined ? { description } : {})}
      {...(detail !== undefined ? { detail } : {})}
      control={
        <Switch
          checked={checked}
          disabled={disabled}
          aria-label={typeof label === "string" ? label : undefined}
          {...(testId ? { "data-testid": testId } : {})}
          onCheckedChange={onChange}
        />
      }
    />
  );
}

export function NumberSettingRow({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  unit,
  disabled,
  testId,
  onChange,
}: {
  label: ReactNode;
  description?: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  testId?: string;
  onChange: (next: number) => void;
}) {
  return (
    <SettingsRow
      label={label}
      {...(description !== undefined ? { description } : {})}
      control={
        <span className="flex items-center gap-2">
          <Input
            type="number"
            size="lg"
            className="w-28"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            {...(testId ? { "data-testid": testId } : {})}
            onChange={(event) => {
              const parsed = Number(event.target.value);
              // Пустое/битое значение не пишем: schema отклонит его и рантайм останется старым.
              if (!Number.isFinite(parsed)) return;
              onChange(Math.min(max, Math.max(min, Math.trunc(parsed))));
            }}
          />
          {unit ? <span className="text-ui-sm text-foreground-subtle">{unit}</span> : null}
        </span>
      }
    />
  );
}

export function SelectSettingRow<T extends string>({
  label,
  description,
  value,
  options,
  disabled,
  testId,
  onChange,
}: {
  label: ReactNode;
  description?: ReactNode;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  disabled?: boolean;
  testId?: string;
  onChange: (next: T) => void;
}) {
  return (
    <SettingsRow
      label={label}
      {...(description !== undefined ? { description } : {})}
      control={
        <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as T)}>
          <SelectTrigger size="lg" className="w-56 min-w-0 justify-between" {...(testId ? { "data-testid": testId } : {})}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

export function TextSettingRow({
  label,
  description,
  value,
  placeholder,
  disabled,
  testId,
  onChange,
}: {
  label: ReactNode;
  description?: ReactNode;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
  onChange: (next: string) => void;
}) {
  return (
    <SettingsRow
      label={label}
      {...(description !== undefined ? { description } : {})}
      controlLayout="wide"
      control={
        <Input
          size="lg"
          className="w-full"
          value={value}
          disabled={disabled}
          {...(placeholder ? { placeholder } : {})}
          {...(testId ? { "data-testid": testId } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
      }
    />
  );
}
