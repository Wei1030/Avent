import { Fragment, memo, useMemo, type ReactNode } from "react";
import { useApp } from "../store/app-context.js";

type Block =
  | { t: "code"; lang: string; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "hr" }
  | { t: "quote"; text: string }
  | {
      t: "table";
      head: string[];
      rows: string[][];
      align: Array<"left" | "center" | "right" | undefined>;
    }
  | {
      t: "list";
      ordered: boolean;
      start: number;
      items: Array<{ text: string; task?: boolean; done?: boolean }>;
    }
  | { t: "p"; text: string };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
        body.push(lines[i++]);
      }
      i += 1;
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1].length, text: h[2] });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ t: "hr" });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i++].replace(/^\s*>\s?/, ""));
      }
      out.push({ t: "quote", text: body.join("\n") });
      continue;
    }
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])
    ) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":")
          ? ("center" as const)
          : c.endsWith(":")
            ? ("right" as const)
            : c.startsWith(":")
              ? ("left" as const)
              : undefined
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(cells(lines[i++]));
      }
      out.push({ t: "table", head, rows, align });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: Array<{ text: string; task?: boolean; done?: boolean }> = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m && /\d/.test(m[2]) === ordered) {
          const task = /^\[([ xX])\]\s+/.exec(m[3]);
          items.push({
            text: task ? m[3].slice(task[0].length) : m[3],
            ...(task ? { task: true, done: task[1] !== " " } : {}),
          });
          i += 1;
          continue;
        }
        break;
      }
      out.push({
        t: "list",
        ordered,
        start: ordered ? Number(/\d+/.exec(li[2])![0]) : 1,
        items,
      });
      continue;
    }
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) &&
      !LIST.test(lines[i])
    ) {
      body.push(lines[i++]);
    }
    if (!body.length) body.push(lines[i++]);
    out.push({ t: "p", text: body.join("\n") });
  }
  return out;
}

function renderInline(
  text: string,
  onOpenFile?: (fileUri: string) => void
): ReactNode {
  const parts: ReactNode[] = [];
  const re =
    /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\n/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) {
      parts.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    }
    if (m[2] !== undefined) {
      parts.push(<code key={k++}>{m[2]}</code>);
    } else if (m[3] !== undefined) {
      parts.push(<b key={k++}>{renderInline(m[3], onOpenFile)}</b>);
    } else if (m[4] !== undefined) {
      parts.push(<i key={k++}>{renderInline(m[4], onOpenFile)}</i>);
    } else if (m[5] !== undefined) {
      const href = m[6];
      if (href.startsWith("file://") && onOpenFile) {
        parts.push(
          <a
            key={k++}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenFile(href);
            }}
          >
            {renderInline(m[5], onOpenFile)}
          </a>
        );
      } else {
        parts.push(
          <a key={k++} href={href} target="_blank" rel="noreferrer">
            {renderInline(m[5], onOpenFile)}
          </a>
        );
      }
    } else if (m[7] !== undefined) {
      parts.push(
        <a key={k++} href={m[7]} target="_blank" rel="noreferrer">
          {m[7]}
        </a>
      );
    } else {
      parts.push(<br key={k++} />);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  }
  return parts;
}

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { activeWorkspace, openFilePreview } = useApp();
  const blocks = useMemo(() => parse(text), [text]);

  const handleFileUri = (uri: string) => {
    if (!activeWorkspace) return;
    let decoded = decodeURIComponent(uri.replace(/^file:\/\/\/?/i, ""));
    if (/^[A-Za-z]:\//.test(decoded)) {
      decoded = decoded.replace(/\//g, "\\");
    }
    openFilePreview(activeWorkspace.id, decoded);
  };

  return (
    <div className={className ?? "md"}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "code":
            return (
              <pre key={i} className="md-code" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "h": {
            const Tag = `h${Math.min(6, b.level + 2)}` as "h3";
            return (
              <Tag key={i} className="md-h">
                {renderInline(b.text, handleFileUri)}
              </Tag>
            );
          }
          case "hr":
            return <hr key={i} />;
          case "quote":
            return <blockquote key={i}>{renderInline(b.text, handleFileUri)}</blockquote>;
          case "table":
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} style={{ textAlign: b.align[j] }}>
                          {renderInline(c, handleFileUri)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {b.head.map((_, x) => (
                          <td key={x} style={{ textAlign: b.align[x] }}>
                            {renderInline(r[x] ?? "", handleFileUri)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const items = b.items.map((it, j) => (
              <li key={j} style={it.task ? { listStyle: "none", marginLeft: -18 } : undefined}>
                {it.task && (
                  <input
                    type="checkbox"
                    checked={it.done}
                    readOnly
                    style={{ marginRight: 6, verticalAlign: -1 }}
                  />
                )}
                {renderInline(it.text, handleFileUri)}
              </li>
            ));
            return b.ordered ? (
              <ol key={i} start={b.start}>
                {items}
              </ol>
            ) : (
              <ul key={i}>{items}</ul>
            );
          }
          default:
            return <p key={i}>{renderInline(b.text, handleFileUri)}</p>;
        }
      })}
    </div>
  );
});
