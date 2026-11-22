import { isValidWslUser } from "@zcode/shared";
import { TID_WSL_DISTRO_SELECT, TID_WSL_USER_INPUT } from "@zcode/shared/test-ids";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createRemoteFieldErrorHelpers } from "./fieldErrors.js";
import { FieldError, FieldHint, FieldLabel } from "./FieldPrimitives.js";
import type { RemoteConnectionFieldsProps } from "./types.js";

interface WslConnectionFieldsProps extends RemoteConnectionFieldsProps {
  fieldId: string;
}

/** WSL 连接字段：发行版与登录用户，附带检测结果与 root 提醒。 */
export function WslConnectionFields({
  fieldId,
  fieldErrors = [],
  wslDistro,
  wslUser = "",
  wslDistros,
  runtimeOptionsError = "",
  runtimeOptionsLoading,
  setWslDistro,
  setWslUser,
}: WslConnectionFieldsProps) {
  const { intl } = useZCodeIntl();
  const { errorId, invalidProps } = createRemoteFieldErrorHelpers(fieldId, fieldErrors);
  const wslUserIsRoot = wslUser.trim().toLowerCase() === "root";
  const wslUserIsInvalid = wslUser.trim().length > 0 && !isValidWslUser(wslUser);

  return (
    <div className="space-y-4">
      <div>
        <FieldLabel htmlFor={`${fieldId}-wsl-distro`}>
          {intl.formatMessage({ id: "wsl.distro" })}
        </FieldLabel>
        <Input
          id={`${fieldId}-wsl-distro`}
          size="lg"
          className="h-9 text-ui-base"
          value={wslDistro}
          onChange={(event) => setWslDistro(event.target.value)}
          placeholder={intl.formatMessage({ id: "wsl.defaultDistro" })}
          data-testid={TID_WSL_DISTRO_SELECT}
          list={`${fieldId}-wsl-options`}
        />
        <datalist id={`${fieldId}-wsl-options`}>
          {wslDistros.map((distro) => (
            <option key={distro.name} value={distro.name} />
          ))}
        </datalist>
        <FieldHint>
          {runtimeOptionsLoading
            ? intl.formatMessage({ id: "wsl.loading" })
            : runtimeOptionsError
              ? intl.formatMessage({ id: "remote.optionsLoadFailed" })
              : wslDistros.length > 0
                ? intl.formatMessage(
                    { id: "wsl.detectedCount" },
                    {
                      count: String(wslDistros.length),
                    },
                  )
                : intl.formatMessage({ id: "wsl.noDistros" })}
        </FieldHint>
      </div>
      <div>
        <FieldLabel htmlFor={`${fieldId}-wsl.user`}>
          {intl.formatMessage({ id: "wsl.user" })}
        </FieldLabel>
        <Input
          size="lg"
          className="h-9 text-ui-base"
          value={wslUser}
          onChange={(event) => setWslUser?.(event.target.value)}
          placeholder={intl.formatMessage({ id: "wsl.defaultUser" })}
          autoCapitalize="none"
          spellCheck={false}
          {...invalidProps("wslUser", wslUserIsInvalid)}
          id={`${fieldId}-wsl.user`}
          data-testid={TID_WSL_USER_INPUT}
        />
        {wslUserIsInvalid ? (
          <FieldError
            id={errorId("wslUser")}
            message={intl.formatMessage({ id: "wsl.validation.invalidUser" })}
          />
        ) : (
          <FieldHint>{intl.formatMessage({ id: "wsl.userDescription" })}</FieldHint>
        )}
        {wslUserIsRoot ? (
          <FieldHint tone="warning">{intl.formatMessage({ id: "wsl.rootWarning" })}</FieldHint>
        ) : null}
      </div>
    </div>
  );
}
