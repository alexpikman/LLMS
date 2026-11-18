import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
}

const CodeBlock: React.FC<{ lang: string; code: string }> = ({ lang, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be restricted
    }
  };

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-slate-200 bg-slate-900 text-slate-100">
      <div className="flex items-center justify-between px-3.5 py-2 bg-slate-800/90 border-b border-slate-700/80">
        <span className="text-[11px] font-mono text-slate-300">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium text-slate-300 hover:text-white hover:bg-slate-700 transition-colors cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span>Скопировано</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Копировать</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-[12.5px] leading-relaxed font-mono">
        <code>{code}</code>
      </pre>
    </div>
  );
};

function renderInline(text: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const raw = match[0];
    if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push(
        <code
          key={`c-${keyIdx++}`}
          className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono text-[12.5px] text-slate-800"
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push(
        <strong key={`b-${keyIdx++}`} className="font-semibold text-slate-900">
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push(
        <em key={`i-${keyIdx++}`} className="italic">
          {raw.slice(1, -1)}
        </em>
      );
    } else if (raw.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(raw);
      if (linkMatch) {
        tokens.push(
          <a
            key={`a-${keyIdx++}`}
            href={linkMatch[2]}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline underline-offset-2 hover:text-blue-700"
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        tokens.push(raw);
      }
    }
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }

  return tokens;
}

function renderTextSegment(segment: string, baseKey: string): React.ReactNode[] {
  const lines = segment.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Headings
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const cls =
        level === 1
          ? 'text-lg font-bold text-slate-900 mt-4 mb-2'
          : level === 2
          ? 'text-base font-semibold text-slate-900 mt-3.5 mb-1.5'
          : 'text-sm font-semibold text-slate-900 mt-3 mb-1';
      nodes.push(
        <div key={`${baseKey}-h-${blockKey++}`} className={cls}>
          {renderInline(headingMatch[2])}
        </div>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^([-*_]){3,}$/.test(trimmed)) {
      nodes.push(<hr key={`${baseKey}-hr-${blockKey++}`} className="my-3 border-slate-200" />);
      i++;
      continue;
    }

    // Markdown table
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())
    ) {
      const parseCells = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());

      const headers = parseCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseCells(lines[i]));
        i++;
      }

      nodes.push(
        <div
          key={`${baseKey}-tbl-${blockKey++}`}
          className="my-3 overflow-x-auto rounded-lg border border-slate-200"
        >
          <table className="min-w-full text-xs text-left border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {headers.map((h, idx) => (
                  <th key={idx} className="px-3 py-2 font-semibold text-slate-700">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_, cIdx) => (
                    <td key={cIdx} className="px-3 py-2 text-slate-700">
                      {renderInline(r[cIdx] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      nodes.push(
        <blockquote
          key={`${baseKey}-q-${blockKey++}`}
          className="my-2.5 rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700"
        >
          {quoteLines.map((ql, qIdx) => (
            <div key={qIdx}>{renderInline(ql)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      nodes.push(
        <ul
          key={`${baseKey}-ul-${blockKey++}`}
          className="my-2 pl-5 list-disc space-y-1 text-sm leading-relaxed text-slate-800"
        >
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      nodes.push(
        <ol
          key={`${baseKey}-ol-${blockKey++}`}
          className="my-2 pl-5 list-decimal space-y-1 text-sm leading-relaxed text-slate-800"
        >
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4}\s|[-*+]\s|\d+\.\s|>|\||([-*_]){3,}$)/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    nodes.push(
      <p
        key={`${baseKey}-p-${blockKey++}`}
        className="my-2 first:mt-0 last:mb-0 text-sm leading-relaxed text-slate-800 whitespace-pre-wrap"
      >
        {renderInline(paraLines.join('\n'))}
      </p>
    );
  }

  return nodes;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  if (!content) return null;

  const segments: Array<{ type: 'text' | 'code'; lang?: string; body: string }> = [];
  const fenceRegex = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', body: content.slice(lastIndex, match.index) });
    }
    segments.push({
      type: 'code',
      lang: match[1] || 'text',
      body: match[2].replace(/\n$/, ''),
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', body: content.slice(lastIndex) });
  }

  return (
    <div className="min-w-0 break-words">
      {segments.map((seg, idx) =>
        seg.type === 'code' ? (
          <CodeBlock key={`code-${idx}`} lang={seg.lang ?? 'text'} code={seg.body} />
        ) : (
          <React.Fragment key={`txt-${idx}`}>
            {renderTextSegment(seg.body, `seg-${idx}`)}
          </React.Fragment>
        )
      )}
    </div>
  );
};
