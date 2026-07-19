import { AgentWorkflow } from "agents/workflows";
import type {
  AgentWorkflowEvent,
  AgentWorkflowStep
} from "agents/workflows";
import type { AssistantDirectory } from "./agent";

export type DocumentIngestParams = {
  documentId: string;
};

export type DocumentIngestProgress = {
  documentId: string;
  stage: "parsing" | "indexing" | "ready" | "failed";
  percent: number;
  message: string;
};

/** Durable parse/index pipeline. The heavy text never becomes Workflow state. */
export class DocumentIngestWorkflow extends AgentWorkflow<
  AssistantDirectory,
  DocumentIngestParams,
  DocumentIngestProgress,
  Env
> {
  async run(
    event: AgentWorkflowEvent<DocumentIngestParams>,
    step: AgentWorkflowStep
  ): Promise<{ documentId: string; chunkCount: number }> {
    const { documentId } = event.payload;
    await this.reportProgress({
      documentId,
      stage: "parsing",
      percent: 0.1,
      message: "正在解析原始文件"
    });

    try {
      const chunkCount = await step.do(
        "解析并建立全文索引",
        {
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "15 minutes"
        },
        async () => this.agent.processStoredDocument(documentId)
      );

      await this.reportProgress({
        documentId,
        stage: "ready",
        percent: 1,
        message: `索引完成，共 ${chunkCount} 个文本块`
      });
      const result = { documentId, chunkCount };
      await step.reportComplete(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.agent.failDocumentIngest(documentId, message);
      await this.reportProgress({
        documentId,
        stage: "failed",
        percent: 1,
        message
      });
      await step.reportError(message);
      throw error;
    }
  }
}
