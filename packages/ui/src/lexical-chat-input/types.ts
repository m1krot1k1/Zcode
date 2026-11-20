/**
 * LexicalChatInput 的公开类型与内部选项。
 *
 * 从 LexicalChatInput.tsx 提取，导出路径仍由 `@/LexicalChatInput.js` 统一收口。
 */
import type { MentionItemData } from "@/mentions/mentionTypes.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import type { EditorState } from "lexical";

/** 旧 useChatComposer 已删；粘贴事件收口为最小结构类型（ClipboardEvent 结构兼容）。 */
export interface ChatComposerPasteEvent {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export interface LexicalChatInputHandle {
  clear: () => void;
  focus: () => void;
  getEditorState: () => EditorState;
  getMarkdown: () => string;
  getText: () => string;
  appendText: (text: string) => void;
  beginVoiceDictation: () => void;
  applyVoiceDictation: (text: string, final?: boolean) => void;
  cancelVoiceDictation: () => void;
  appendFileMention: (
    label: string,
    value: string,
    markdown: string,
    data?: MentionItemData,
    trailingText?: string,
  ) => void;
  prependMentionIfMissing: (mention: ComposerMentionPrefill) => boolean;
  setMention: (mention: ComposerMentionPrefill, trailingText?: string) => void;
  insertMention: (mention: ComposerMentionPrefill, selectionState?: EditorState) => void;
  setText: (text: string) => void;
  setTextWithPluginMentions: (text: string) => void;
  setEditorStateJson: (editorStateJson: string) => void;
  setSkillMention: (skillName: string, markdown?: string, trailingText?: string) => void;
  setSlashCommandMention: (commandName: string, markdown?: string, trailingText?: string) => void;
}

export interface LexicalEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  enterSubmits: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  text: string;
}

export interface LexicalModifiedEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  modifiedEnterSubmits: boolean;
  shiftKey?: boolean;
  text: string;
}

export type LexicalSubmitResult = boolean | void;

export interface LeadingChineseSlashAliasInputOptions {
  data: string | null;
  inputType: string;
  isAtEditorStart: boolean;
  isComposing?: boolean;
}

export interface LexicalChatInputProps {
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  onChange?: (text: string) => void;
  onFocus?: () => void;
  triggerPanelContainer?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** 仅影响 Skill 引用目录；草稿可使用 prewarm Session runtime。 */
  skillCatalogSessionId?: string | null;
  inputTestId?: string;
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
  promptHistory?: readonly string[];
  avoidIosInputFocusZoom?: boolean;
  compactPlaceholder?: boolean;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  excludedSlashCommandNames?: readonly string[];
  /** App 层本地斜杠命令（如 `/side`），选中即执行 UI 行为，不发送。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** mention（@/#）面板开关。v4 数据面未就绪时显式关闭，入口保留。 */
  enableMentionPanel?: boolean;
}
