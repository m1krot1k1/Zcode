import { useToolPresentationHostCapabilities } from "@/hooks/useToolPresentationHostCapabilities.js";
import { ToolPresentationCapabilitiesProvider } from "@/ToolCallBlocks/presentationCapabilities.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodeProvider,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import {
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import {
  getPermissionOptionDisplayKind,
  getPermissionRequestPreview,
  sortPermissionOptions,
} from "@/lib/permissionRequest.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/shared.js";
import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { WebFetchToolCallBlock } from "@/ToolCallBlocks/renderers/web-fetch.js";
import { SearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import { SkillToolCallBlock } from "@/ToolCallBlocks/renderers/skill.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import { WorkflowPermissionBlock } from "@/WorkflowPermissionBlock.js";
import {
  focusLastWorkflowSettingsControl,
  isWorkflowSettingsCarrier,
  usePermissionWorkflowSettings,
} from "@/permissionWorkflowSettings.js";
import { SaveWorkflowPermissionBlock } from "@/SaveWorkflowPermissionBlock.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { LoaderIcon } from "lucide-react";
import { McpPermissionBlock } from "./permission-dialog/McpPermissionBlock.js";
import { PermissionDialogFooter } from "./permission-dialog/PermissionDialogFooter.js";
import { PermissionFeedbackRow } from "./permission-dialog/PermissionFeedbackRow.js";
import { PermissionOptionList } from "./permission-dialog/PermissionOptionList.js";
import {
  buildPermissionBlockContext,
  buildPermissionToolCall,
  focusLastSaveWorkflowControl,
  getPermissionDisplayReason,
  isWorkflowRefineOption,
  resolvePermissionBlockKind,
} from "./permission-dialog/permissionDialogModel.js";

export function PermissionDialog({
  request,
  onRespond,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  workflowSessionModel,
  provider,
  isWebRemoteControl = false,
  responding = false,
  responseError,
}: {
  request: ZCodePermissionRequest;
  responding?: boolean;
  responseError?: string;
  /**
   * `content` 只在工作流确认窗的放行应答上出现：用户在窗里改过的设置（docs/dynamic-workflow/launch.md
   * 「Adjusting the settings in the window」）。没改过即不传。
   */
  onRespond: (
    requestId: string,
    option: ZCodePermissionOption,
    feedback?: string,
    content?: Record<string, unknown>,
  ) => void;
  workspacePath: string;
  /** 工作流确认窗的模型清单作用域与会话模型（宿主给）。 */
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workflowSessionModel?: { providerId: string; modelId: string };
  provider?: ZCodeProvider;
  isWebRemoteControl?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const presentationCapabilities = useToolPresentationHostCapabilities(workspacePath);
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  // Bug 根因：反馈输入也会渲染在手机 Web 远控的 PermissionDialog 中，14px 输入框聚焦时会触发 iOS 页面放大。
  // 与 composer 复用同一套视口判断和 16px 兼容 token，桌面和非远控 Web 保持原有字号。
  const avoidIosInputFocusZoom = shouldAvoidIosInputFocusZoom({
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // M5②.5 store 耦合剥离：主题/代码预览设置在宿主处取 store，向下走 props/render context。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // 工作流确认窗的 Refine 选项不进按钮列表：它就是这个窗的反馈行（见 feedbackOption）。
  const refineOption = useMemo(
    () => request.options.find(isWorkflowRefineOption),
    [request.options],
  );
  const orderedOptions = useMemo(
    () =>
      sortPermissionOptions(request.options).filter((option) => !isWorkflowRefineOption(option)),
    [request.options],
  );
  const preview = useMemo(() => getPermissionRequestPreview(request), [request]);
  const toolCall = useMemo(() => buildPermissionToolCall(request, preview), [preview, request]);
  const rawFileSummaries = useMemo(
    () =>
      // 权限弹窗之前只认 preview.fileChanges，Write 请求如果只带 file_path/content，
      // 这里就会丢失文件摘要；改成复用聊天区同一套 edit 解析，避免两个入口展示结果不一致。
      readRawToolCallFileSummaries(toolCall.raw, {
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [toolCall],
  );
  const blockKind = useMemo(
    () => resolvePermissionBlockKind(preview, toolCall, rawFileSummaries),
    [preview, rawFileSummaries, toolCall],
  );
  const blockContext = useMemo(
    () =>
      buildPermissionBlockContext(
        toolCall,
        rawFileSummaries,
        workspacePath,
        blockKind,
        intl.formatMessage({ id: "chat.permission.awaitingApproval" }),
        theme,
        codePreviewSettings,
      ),
    [blockKind, codePreviewSettings, intl, rawFileSummaries, theme, toolCall, workspacePath],
  );
  const displayReason = useMemo(() => getPermissionDisplayReason(request), [request]);
  // 工作流确认窗的两项 run 设置（WorkflowPermissionBlock 画，这里只存改过的值与「模型不可用」）。
  const isWorkflowAsk = blockKind === "workflow";
  const workflowSettings = usePermissionWorkflowSettings(request.requestId);
  const workflowSettingsContent = isWorkflowAsk ? workflowSettings.content : undefined;
  const isOptionBlocked = useCallback(
    (option: ZCodePermissionOption) =>
      isWorkflowAsk && workflowSettings.blocked && isWorkflowSettingsCarrier(option),
    [isWorkflowAsk, workflowSettings.blocked],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState("");
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const feedbackInputRef = useRef<HTMLTextAreaElement | null>(null);
  const feedbackCompositionActiveRef = useRef(false);
  const feedbackInputFocusedRef = useRef(false);
  const denyOption = useMemo(
    () =>
      orderedOptions.find((option) =>
        getPermissionOptionDisplayKind(option.kind).startsWith("reject"),
      ),
    [orderedOptions],
  );
  // 反馈行的应答目标：工作流确认窗是 Refine（拒绝 + 修改意见升级为真实 user message），
  // 其他确认窗是 Deny（拒绝 + 反馈）。两种确认窗共用同一行输入，只换应答目标与文案，
  // 不再各画一套输入框——同一停靠区里两种反馈输入长得不一样是设计债。
  // 原因：复用 Deny 索引会让拒绝按钮和输入框同时高亮；输入行独立导航，提交才用目标选项。
  const feedbackOption = refineOption ?? (request.freeText === true ? denyOption : undefined);
  const hasFeedbackInput = Boolean(feedbackOption);
  const feedbackIndex = orderedOptions.length;
  const selectableCount = orderedOptions.length + (hasFeedbackInput ? 1 : 0);
  const isFeedbackSelected = hasFeedbackInput && selectedIndex === feedbackIndex;

  useEffect(() => {
    setSelectedIndex(0);
    // 草稿按 requestId 归零，避免一个请求的反馈（或工作流修改意见）泄漏进下一个确认窗。
    setFeedback("");
  }, [request.requestId]);

  useEffect(() => {
    if (orderedOptions.length === 0) {
      return;
    }
    if (feedbackInputFocusedRef.current) {
      return;
    }

    // 反馈输入框新增后，旧的 RAF 可能在用户获得输入焦点后才回调，重新抢回选项焦点。
    // 回调执行时再次确认焦点状态，避免打断用户输入。
    const frameId = requestAnimationFrame(() => {
      if (!feedbackInputFocusedRef.current) {
        if (isFeedbackSelected) feedbackInputRef.current?.focus();
        else optionRefs.current[selectedIndex]?.focus();
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [isFeedbackSelected, orderedOptions.length, request.requestId, selectedIndex]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (selectableCount === 0) {
        return;
      }

      feedbackInputFocusedRef.current = false;
      setSelectedIndex(
        (currentIndex) => (currentIndex + direction + selectableCount) % selectableCount,
      );
    },
    [selectableCount],
  );

  const respondWithOption = useCallback(
    (option: ZCodePermissionOption) => {
      // 所选子代理模型已不可用：放行要等用户换一个，与「配置」弹层的 Apply 同一条规则。
      if (responding || isOptionBlocked(option)) return;
      const selectedKind = getPermissionOptionDisplayKind(option.kind);
      // 通用确认窗里 Deny 顺带把反馈行草稿作为拒绝理由发出；工作流确认窗的草稿属于 Refine，
      // 点 Deny 就是普通拒绝——否则一段修改意见会以普通拒绝理由的身份发出，
      // 模型收不到 workflow_refine_feedback 的升级递送。
      const trimmedFeedback =
        !refineOption && selectedKind.startsWith("reject") ? feedback.trim() : "";
      const content =
        workflowSettingsContent !== undefined && isWorkflowSettingsCarrier(option)
          ? { ...workflowSettingsContent }
          : undefined;
      if (content === undefined) {
        onRespond(request.requestId, option, trimmedFeedback || undefined);
      } else {
        onRespond(request.requestId, option, trimmedFeedback || undefined, content);
      }
    },
    [
      feedback,
      isOptionBlocked,
      onRespond,
      refineOption,
      request.requestId,
      responding,
      workflowSettingsContent,
    ],
  );

  const submitFeedback = useCallback(() => {
    // 提交前 trim：CLI broker 对空白 freeText 落普通 deny，不能把纯空白当反馈。
    const trimmedFeedback = feedback.trim();
    if (responding || !feedbackOption || !trimmedFeedback) {
      return;
    }
    onRespond(request.requestId, feedbackOption, trimmedFeedback);
  }, [feedback, feedbackOption, onRespond, request.requestId, responding]);

  const confirmSelection = useCallback(() => {
    if (isFeedbackSelected) {
      submitFeedback();
      return;
    }
    const selectedOption = orderedOptions[selectedIndex];
    if (selectedOption) respondWithOption(selectedOption);
  }, [isFeedbackSelected, orderedOptions, respondWithOption, selectedIndex, submitFeedback]);

  const handleFeedbackKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (
        isImeComposingKeyEvent({
          compositionActive: feedbackCompositionActiveRef.current,
          nativeEvent: event.nativeEvent,
        })
      ) {
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Tab") {
        event.preventDefault();
        moveSelection(event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        submitFeedback();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        feedbackInputRef.current?.blur();
      }
    },
    [moveSelection, submitFeedback],
  );

  const handleOptionKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (hasFeedbackInput && event.key === String(feedbackIndex + 1)) {
        event.preventDefault();
        setSelectedIndex(feedbackIndex);
        return;
      }
      if (event.key === "1" || event.key === "2" || event.key === "3") {
        const shortcutIndex = Number(event.key) - 1;
        const shortcutOption = orderedOptions[shortcutIndex];
        if (!shortcutOption) {
          return;
        }

        event.preventDefault();
        setSelectedIndex(shortcutIndex);
        respondWithOption(shortcutOption);
        return;
      }

      switch (event.key) {
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(-1);
          return;
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          moveSelection(1);
          return;
        case "Tab":
          // 长命令新增了阅读按钮，旧的选项循环会困住焦点；第一项反向 Tab 交还浏览器，
          // 按 DOM 顺序进入上方命令按钮，其正向 Tab 自然回到当前第一项，不触发授权。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            rootRef.current?.querySelector("[data-command-preview-toggle]")
          ) {
            return;
          }
          // 工作流确认窗：第一个选项上的 Shift+Tab 离开列表、回到上方的设置控件（阅读次序即焦点次序）。
          // 按事件落在哪个按钮上判，不读 selectedIndex：聚焦与按键可能在同一帧，状态还没提交。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            isWorkflowAsk &&
            focusLastWorkflowSettingsControl(rootRef.current)
          ) {
            event.preventDefault();
            return;
          }
          // 保存确认窗同理：第一个选项上的 Shift+Tab 回到上方滚动区的最后一个控件，正向 Tab 再按 DOM
          // 次序走回当前选项。Bugfix：这里原先没有出口，选项循环困住焦点，折叠起来的说明、参数与脚本
          // 只能用鼠标展开。
          if (
            event.shiftKey &&
            optionRefs.current.indexOf(event.currentTarget) === 0 &&
            blockKind === "saveWorkflow" &&
            focusLastSaveWorkflowControl(rootRef.current)
          ) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          moveSelection(event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          confirmSelection();
          return;
        default:
          return;
      }
    },
    [
      blockKind,
      confirmSelection,
      feedbackIndex,
      hasFeedbackInput,
      isWorkflowAsk,
      moveSelection,
      orderedOptions,
      respondWithOption,
    ],
  );

  const PermissionBlock =
    blockKind === "edit"
      ? EditToolCallBlock
      : blockKind === "mcp"
        ? McpPermissionBlock
        : blockKind === "skill"
          ? SkillToolCallBlock
          : blockKind === "web-fetch"
            ? WebFetchToolCallBlock
            : blockKind === "search"
              ? SearchToolCallBlock
              : blockKind === "execute"
                ? ExecuteToolCallBlock
                : FallbackToolCallBlock;
  // 当前 ZCode Agent 的 ExitPlanMode 权限请求不再传 legacy switch_mode。
  // 这里复用 tool identity，避免审批弹窗和聊天区的计划模式工具分流再次漂移。
  const shouldUseSwitchModePlaceholder = resolveToolCallIdentity(toolCall).family === "switch-mode";
  // 工作流确认窗自带本地化标题（「运行此工作流？」）和图主体，走独立块而不是通用预览块。
  const shouldUseWorkflowBlock = isWorkflowAsk;
  // 保存确认窗同理，但问句、内容与选项都不同：没有图、没有 Refine，主体是落点 + 元数据 + 脚本。
  const shouldUseSaveWorkflowBlock = blockKind === "saveWorkflow";
  // 限高布局目前只给保存确认窗（docs/dynamic-workflow/launch.md「`SaveWorkflow`」第 4 步）：窗口上限与
  // 问答窗（ElicitationDialog）相同；选项以上全部内容是**唯一**的纵向滚动区，选项、反馈行与确认
  // 隔一条细线钉在下面。滚动区用负外边距铺满窗宽，滚动条贴窗口边缘、细线横贯整窗。
  // Bugfix：上一版问句钉顶、中段滚动、段内三块各自滚动、窗口再兜底滚动，最多五层滚动容器叠在
  // 一起，一次滚轮手势的去向取决于指针恰好在哪个框上；块内的长内容改为折叠后，这里只剩一层。
  // 钉底只在屏幕够高（≥36rem）时成立：选项、最多 5 行的反馈、错误行与确认栏本身就有约 320px，
  // 矮屏（如横屏手机）上它们会高过上限、被窗口裁掉，确认按钮跟着消失。所以基础布局是整窗一个
  // 滚动区（选项随内容滚动），够高才切到「选项以上滚、选项钉底」；两种高度下都只有一个滚动容器。
  const bounded = shouldUseSaveWorkflowBlock;
  const confirmDisabled =
    responding ||
    (isFeedbackSelected
      ? !feedback.trim()
      : orderedOptions[selectedIndex] === undefined ||
        isOptionBlocked(orderedOptions[selectedIndex]));
  return (
    <div ref={rootRef} className="w-full shrink-0 relative z-1">
      <div
        className={cn(
          "w-full rounded-2xl border border-border bg-popover shadow-xs",
          bounded
            ? "max-h-[min(72dvh,42rem)] overflow-y-auto overscroll-contain [@media(min-height:36rem)]:flex [@media(min-height:36rem)]:flex-col [@media(min-height:36rem)]:overflow-hidden"
            : "overflow-hidden",
        )}
        {...(bounded ? { "data-permission-dialog-bounded": "true" } : {})}
      >
        <div
          className={cn(
            "flex flex-col gap-3 p-3",
            bounded && "[@media(min-height:36rem)]:min-h-0 [@media(min-height:36rem)]:flex-1",
          )}
        >
          <div
            className={cn(
              "space-y-4",
              bounded &&
                "-mx-3 -mt-3 border-b border-border p-3 [@media(min-height:36rem)]:min-h-0 [@media(min-height:36rem)]:overflow-y-auto [@media(min-height:36rem)]:overscroll-contain",
            )}
            {...(bounded ? { "data-permission-dialog-scroll": "true" } : {})}
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-ui-base font-medium leading-tight text-foreground-subtle">
                {intl.formatMessage({ id: "chat.permission.title" })}
              </p>
              <InteractionRequestOriginBadge origin={request.origin} />
            </div>
            {!shouldUseSwitchModePlaceholder &&
            !shouldUseWorkflowBlock &&
            !shouldUseSaveWorkflowBlock &&
            displayReason ? (
              <p className="text-ui-base leading-5 text-foreground">{displayReason}</p>
            ) : null}
            {shouldUseSwitchModePlaceholder ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground">
                <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
                <span className="animated-gradient-text font-medium">
                  {intl.formatMessage({
                    id: "chat.permission.switchMode.placeholder",
                  })}
                </span>
              </div>
            ) : shouldUseWorkflowBlock ? (
              // CLI 侧的 reason 是给协议诊断用的（"createWorkflow.runConfirmation: ..."），
              // 这里刻意不渲染 displayReason：块内的本地化标题才是给用户看的那句问句。
              <WorkflowPermissionBlock
                onSettingsBlockedChange={workflowSettings.onBlockedChange}
                onSettingsChange={workflowSettings.onContentChange}
                request={request}
                settingsDisabled={responding}
                workspacePath={workspacePath}
                {...(workspaceIdentity === undefined ? {} : { workspaceIdentity })}
                {...(remoteSessionId === undefined ? {} : { remoteSessionId })}
                {...(workflowSessionModel === undefined
                  ? {}
                  : { sessionModel: workflowSessionModel })}
              />
            ) : shouldUseSaveWorkflowBlock ? (
              // 同上：保存 gate 的问句（保存 / 覆盖两句）由块自己给出，不复用协议 reason。
              <SaveWorkflowPermissionBlock request={request} />
            ) : (
              // 审批直接使用 renderer，绕过 ToolCallBlock 时也必须提供宿主展示能力。
              <ToolPresentationCapabilitiesProvider value={presentationCapabilities}>
                <PermissionBlock {...blockContext} />
              </ToolPresentationCapabilitiesProvider>
            )}
          </div>

          {/* 反馈行曾被外层 gap-3 隔开；用同一 4px 视觉分组，保留 listbox 的权限选项边界。 */}
          <div className="shrink-0 space-y-1">
            <PermissionOptionList
              options={orderedOptions}
              selectedIndex={selectedIndex}
              {...(provider === undefined ? {} : { provider })}
              scope={preview.scope}
              workflowSettingsContent={workflowSettingsContent}
              isOptionBlocked={isOptionBlocked}
              optionRefs={optionRefs}
              onSelectIndex={setSelectedIndex}
              onActivateOption={respondWithOption}
              onOptionKeyDown={handleOptionKeyDown}
            />

            {feedbackOption ? (
              <PermissionFeedbackRow
                feedback={feedback}
                feedbackIndex={feedbackIndex}
                feedbackOption={feedbackOption}
                refine={refineOption !== undefined}
                isSelected={isFeedbackSelected}
                avoidIosInputFocusZoom={avoidIosInputFocusZoom}
                inputRef={feedbackInputRef}
                onChange={setFeedback}
                onFocus={() => {
                  feedbackInputFocusedRef.current = true;
                  setSelectedIndex(feedbackIndex);
                }}
                onBlur={() => {
                  feedbackInputFocusedRef.current = false;
                }}
                onCompositionStart={() => {
                  feedbackCompositionActiveRef.current = true;
                }}
                onCompositionEnd={() => {
                  feedbackCompositionActiveRef.current = false;
                }}
                onKeyDown={handleFeedbackKeyDown}
              />
            ) : null}
          </div>

          <PermissionDialogFooter
            {...(responseError === undefined ? {} : { responseError })}
            confirmDisabled={confirmDisabled}
            onConfirm={confirmSelection}
          />
        </div>
      </div>
    </div>
  );
}
