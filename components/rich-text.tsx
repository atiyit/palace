import type { ReactNode } from "react";

// 这里只实现了刻意精简的 Markdown 子集，所有模型文本都变为 React 文本节点；
// HTML、链接和图片不会被解析或加载——主人，请容我只呈上纯净的文字内容呀。
function inline(text: string): ReactNode[] {
  const pieces: ReactNode[] = [];
  const tokens = /\*\*([^\n]+?)\*\*|`([^`\n]+)`/g;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    const index = match.index ?? 0;
    if (index > offset) pieces.push(text.slice(offset, index));
    pieces.push(match[1] !== undefined
      ? <strong key={`b-${index}`}>{match[1]}</strong>
      : <code key={`c-${index}`}>{match[2]}</code>);
    offset = index + match[0].length;
  }
  if (offset < text.length) pieces.push(text.slice(offset));
  return pieces;
}

const LIST = /^\s*(?:([-+*])\s+|(\d+)[.)]\s+)(.+)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*$/;
const FENCE = /^\s*```/;
const QUOTE = /^\s*>\s?/;
const beginsBlock = (line: string) => !line.trim() || FENCE.test(line) || HEADING.test(line) || LIST.test(line) || QUOTE.test(line);

export function RichText({ children }: { children: string }) {
  const lines = children.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const start = i;
    if (FENCE.test(lines[i])) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<pre key={start}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = lines[i].match(HEADING);
    if (heading) {
      blocks.push(<h4 key={start} className="rich-heading">{inline(heading[1])}</h4>);
      i++; continue;
    }
    const list = lines[i].match(LIST);
    if (list) {
      const ordered = !!list[2];
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const item = lines[i].match(LIST);
        if (!item || !!item[2] !== ordered) break;
        items.push(<li key={i}>{inline(item[3])}</li>);
        i++;
      }
      blocks.push(ordered
        ? <ol key={start} start={Math.min(9999, Math.max(1, Number(list[2])))}>{items}</ol>
        : <ul key={start}>{items}</ul>);
      continue;
    }
    if (QUOTE.test(lines[i])) {
      const quote: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quote.push(lines[i++].replace(QUOTE, ""));
      blocks.push(<blockquote key={start}>{inline(quote.join("\n"))}</blockquote>);
      continue;
    }
    const paragraph = [lines[i++]];
    while (i < lines.length && !beginsBlock(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={start}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="rich-text">{blocks}</div>;
}
