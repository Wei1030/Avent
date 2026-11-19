import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerRecord, McpToolSummary } from "../shared/types.js";

export async function probeMcpServer(
  server: McpServerRecord,
  cwd: string
): Promise<{ ok: boolean; tools: McpToolSummary[]; errorMessage?: string }> {
  const client = new Client(
    { name: "avent-mcp-inspector", version: "0.2.0" },
    { capabilities: {} }
  );

  let transport:
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport
    | null = null;

  try {
    if (server.transport === "stdio") {
      if (!server.command) {
        return { ok: false, tools: [], errorMessage: "未配置可执行命令 (command)" };
      }
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        cwd,
        env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
        stderr: "ignore",
      });
    } else if (server.transport === "http") {
      if (!server.url) {
        return { ok: false, tools: [], errorMessage: "未配置 HTTP 服务地址 (url)" };
      }
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });
    } else {
      if (!server.url) {
        return { ok: false, tools: [], errorMessage: "未配置 SSE 服务地址 (url)" };
      }
      transport = new SSEClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      });
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("连接超时（8 秒内未响应 initialize）")), 8000);
    });

    await Promise.race([client.connect(transport), timeoutPromise]);
    const listRes = await Promise.race([client.listTools(), timeoutPromise]);

    const tools: McpToolSummary[] = (listRes.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: Boolean(t.annotations?.readOnlyHint),
      destructive: Boolean(t.annotations?.destructiveHint),
    }));

    return { ok: true, tools };
  } catch (err) {
    return {
      ok: false,
      tools: [],
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await client.close();
    } catch {
      // ignore close error
    }
  }
}
