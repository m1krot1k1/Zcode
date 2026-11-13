// PreviewPane 拆分（max-lines）：子 hook 之间共享的最小类型。
/** 预览各读取通道共用的错误状态写入器（统一由一个 useEffect 所有者持有）。 */
export type PreviewPaneErrorSetter = (error: string | null) => void;
