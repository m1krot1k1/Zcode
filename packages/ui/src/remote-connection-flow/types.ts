/** 连接完成后要接续的意图；在发起连接前写入，由连接 owner 消费。 */
export interface RemoteConnectionCompletionIntent {
  preferredDirectoryPath?: string;
  options?: {
    directToDirectory?: boolean;
    localWorkspacePath?: string;
    announceReusedConnection?: boolean;
  };
}
