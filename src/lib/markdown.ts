// 会話ログの中の簡易Markdown（インラインのみ）を解釈する。
//
// エージェントの発言は素のMarkdownで返ってくることが多く（**太字** や `コード` など）、
// これまではその記号がそのまま画面に出ていた。
//
// 生のHTMLタグは意図的に対応しない。会話ログは外部（エージェントの出力）から来る文字列なので、
// dangerouslySetInnerHTMLで流し込むと任意のタグ・スクリプトをそのまま描画することになる。
// Markdownの記号だけを拾ってReact要素に変換する分には、値自体はテキストとしてしか扱わないので安全。

export type MarkdownToken =
  | { kind: "text"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "code"; value: string };

// 太字→コード→斜体の順で拾う。コードより先に斜体を拾うと `*` を含むコード片が壊れるため、
// この優先順位を守る。斜体は `*…*` と `_…_` の両方に対応する。
const INLINE_PATTERN = /\*\*([^*]+?)\*\*|`([^`]+?)`|\*([^*]+?)\*|_([^_]+?)_/g;

/** 1行分（または複数行のブロック）のテキストをインラインMarkdownのトークン列に分解する。 */
export function parseInlineMarkdown(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push({ kind: "text", value: text.slice(lastIndex, index) });

    if (match[1] !== undefined) tokens.push({ kind: "bold", value: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "code", value: match[2] });
    else tokens.push({ kind: "italic", value: match[3] ?? match[4] ?? "" });

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) tokens.push({ kind: "text", value: text.slice(lastIndex) });
  return tokens;
}

// 行頭の `- ` `* ` は箇条書きの記号なので `・ ` に変換する。
// `**太字**` の一部である `*` と区別するため、直後にもう1文字 `*` が続く場合は対象外にする。
const BULLET_LINE = /^([ \t]*)[-*](?!\*)[ \t]+/;

/** 行頭の箇条書き記号を `・` に変換する。インラインの解釈（parseInlineMarkdown）の前に通す。 */
export function convertBulletMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(BULLET_LINE, (_match, indent: string) => `${indent}・ `))
    .join("\n");
}
