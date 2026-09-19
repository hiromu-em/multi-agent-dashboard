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

export type MarkdownBlock =
  | { kind: "text"; value: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "heading"; level: number; text: string };

// `| a | b |` のような、両端が `|` の行。テーブルの行はすべてこの形。
const TABLE_ROW = /^[ \t]*\|(.+)\|[ \t]*$/;
// ヘッダの次の区切り行。`-` `:` `|` と空白だけで構成される（`:` は左右揃えの指定）。
const TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

// `# 見出し` 〜 `###### 見出し`。`#` の後に空白が要る（GFM準拠）。7個以上の `#` は見出しに
// しない。ここは会話の表示側の話で、指示の宛先指定（`#B` など）のパースとは別のコードパス
// （`src/lib/dispatch.ts`）なので、この解釈が宛先の判定に影響することはない。
const HEADING_LINE = /^(#{1,6})[ \t]+(.+)$/;

/** `| a | b |` の1行をセルの配列に割る。両端の `|` は先に落としてから `|` で割る。 */
function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

/**
 * テキストを「表」「見出し」「地の文」のブロックに割る。
 *
 * 表として認めるのは「ヘッダ行」→「区切り行（---）」→本体行、が連続して並ぶ形だけ
 * （GFMのテーブル構文の最小構成）。見出しは行頭の `#`〜`######`。それ以外はすべて
 * 地の文として扱い、これまでと同じインラインMarkdown（太字・斜体・コード・箇条書き）で解釈する。
 *
 * `**要設定#7**|**局に拾われた…**|` のように、表がそのまま生の `|` として画面に出て
 * いた（`parseInlineMarkdown` は太字・斜体・コード以外の記号を一切見ないため）ので、
 * ブロック単位で先に見分けてから表・見出しだけ別扱いにする。
 */
export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  let buffer: string[] = [];

  const flushText = () => {
    if (buffer.length > 0) {
      blocks.push({ kind: "text", value: buffer.join("\n") });
      buffer = [];
    }
  };

  for (let i = 0; i < lines.length; ) {
    const header = lines[i];
    const separator = lines[i + 1];
    if (
      header !== undefined &&
      separator !== undefined &&
      TABLE_ROW.test(header) &&
      TABLE_SEPARATOR.test(separator)
    ) {
      flushText();
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      blocks.push({ kind: "table", header: splitTableRow(header), rows });
      i = j;
      continue;
    }

    const headingMatch = header !== undefined ? header.match(HEADING_LINE) : null;
    if (headingMatch) {
      flushText();
      blocks.push({ kind: "heading", level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }

    buffer.push(header);
    i++;
  }
  flushText();
  return blocks;
}
