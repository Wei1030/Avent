import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiUrl = process.env.AVENT_API_URL || "http://127.0.0.1:4320";
const taskId = process.env.AVENT_TASK_ID || "";
const pulseId = process.env.AVENT_PULSE_ID || "";

async function postInternal<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Avent kernel error (${res.status}): ${errText}`);
  }
  return (await res.json()) as T;
}

const mcp = new McpServer({
  name: "avent",
  version: "0.2.0",
});

mcp.tool(
  "avent_commit_state",
  "Commit the structured Task State brief to Avent. Call this tool as soon as you finish answering/solving the current request (status='COMPLETED'), need human input/follow-up (status='WAITING_HUMAN'), or need another bounded round (status='CONTINUE'). You may also set/refine taskTitle, taskObjective (leave empty if user only greeted without a concrete goal), and newDirectives for any durable rules the user specified.",
  {
    status: z
      .enum(["CONTINUE", "WAITING_HUMAN", "COMPLETED", "FAILED"])
      .describe(
        "COMPLETED if the user's request/objective is satisfied; WAITING_HUMAN if you answered a greeting/question and await follow-up OR need human clarification; CONTINUE if autonomous steps remain for the next round."
      ),
    taskTitle: z
      .string()
      .optional()
      .describe(
        "Concise 6-24 char human-readable title for this task in the user's language (e.g. '排查登录接口 500 错误'). Omit if title is already accurate or if user only said hello."
      ),
    taskObjective: z
      .string()
      .optional()
      .describe(
        "Clear, distilled task objective once the user states a concrete request/goal. IMPORTANT: Leave omitted/empty if the user only sent a greeting (e.g. '你好', 'hi') or has not yet stated a concrete task objective!"
      ),
    newDirectives: z
      .array(z.string())
      .default([])
      .describe(
        "Any NEW durable constraints, preferences, or standing rules expressed by the user in this turn that must apply across future rounds (e.g. '始终使用 npm.cmd', '不要修改迁移文件', '回复尽量简洁'). Omit temporary one-off instructions and avoid duplicating existing persistent directives."
      ),
    deliverableSummary: z
      .string()
      .min(1)
      .describe(
        "Clear, natural response or progress report shown directly to the user in the Avent UI (use Markdown; write in the user's language)."
      ),
    establishedFacts: z
      .array(
        z.object({
          fact: z.string().describe("Verified observation, value, or architectural fact (never unverified guesses)."),
          sourcePointer: z
            .string()
            .describe("Exact file path and line numbers, command, or spill path, e.g. 'src/index.ts#L10-L35'."),
        })
      )
      .default([]),
    openHypotheses: z
      .array(z.string())
      .default([])
      .describe("Unverified ideas or hypotheses that still need checking."),
    appliedChanges: z
      .array(
        z.object({
          filePath: z.string(),
          summary: z.string(),
          verified: z.boolean(),
        })
      )
      .default([]),
    verificationChecks: z
      .array(
        z.object({
          command: z.string(),
          outcome: z.enum(["PASS", "FAIL", "PARTIAL", "N/A"]),
          keyOutputOrPointer: z.string(),
        })
      )
      .default([]),
    deadEnds: z
      .array(
        z.object({
          approach: z.string(),
          reasonFailed: z.string(),
        })
      )
      .default([])
      .describe("Failed approaches that future rounds MUST NOT repeat."),
    remainingPlan: z
      .array(z.string())
      .default([])
      .describe("Ordered list of remaining subgoals (empty if COMPLETED)."),
    immediateNextAction: z
      .string()
      .default("")
      .describe("Exact next command or edit for the next round if status='CONTINUE', or empty if done."),
    humanQuestion: z
      .string()
      .optional()
      .describe("Specific question for the user when status='WAITING_HUMAN'."),
  },
  async (args) => {
    const result = await postInternal<{ ok: boolean; version: number; message: string }>(
      `/api/internal/pulses/${encodeURIComponent(pulseId)}/commit-state`,
      { taskId, ...args }
    );
    return {
      content: [
        {
          type: "text",
          text: `State v${result.version} committed (${args.status}). ${result.message} Stop calling any further tools and end your turn now.`,
        },
      ],
    };
  }
);

mcp.tool(
  "avent_doc_read",
  "Bounded selective file reader (max 6000 chars per call). Prefer this over dumping whole large files into context.",
  {
    filePath: z.string().describe("Relative or absolute path to read."),
    startLine: z.number().int().min(1).optional().describe("1-based start line (default 1)."),
    endLine: z.number().int().min(1).optional().describe("1-based inclusive end line."),
    maxChars: z.number().int().min(500).max(8000).optional().describe("Character cap (default 6000)."),
  },
  async (args) => {
    const result = await postInternal<{ text: string }>(`/api/internal/selective/read`, {
      taskId,
      pulseId,
      ...args,
    });
    return { content: [{ type: "text", text: result.text }] };
  }
);

mcp.tool(
  "avent_doc_grep",
  "Fast regex search across workspace files or spilled tool outputs. Locate relevant line numbers first, then read surrounding lines with avent_doc_read.",
  {
    pattern: z.string().describe("Case-insensitive regex pattern to search for."),
    targetPath: z.string().optional().describe("Optional sub-path or spill file path."),
    maxMatches: z.number().int().min(1).max(80).optional(),
  },
  async (args) => {
    const result = await postInternal<{ text: string }>(`/api/internal/selective/grep`, {
      taskId,
      pulseId,
      ...args,
    });
    return { content: [{ type: "text", text: result.text }] };
  }
);

mcp.tool(
  "avent_history_grep",
  "Search lossless raw transcripts of prior rounds for this task if you ever need an exact detail omitted from Task State.",
  {
    query: z.string().describe("Keyword or regex to search across archived rounds."),
    maxMatches: z.number().int().min(1).max(50).optional(),
  },
  async (args) => {
    const result = await postInternal<{ text: string }>(`/api/internal/selective/history`, {
      taskId,
      pulseId,
      ...args,
    });
    return { content: [{ type: "text", text: result.text }] };
  }
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
