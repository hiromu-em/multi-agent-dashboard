// エージェントの質問文から選択肢らしい行を抜き出す。
//
// 対話待ち（waiting）のレーンは、エージェントがターンを終えて質問文を返した状態。
// 「1. 案A」「A) 案B」のような列挙で選択肢を示すことが多いので、それをボタン化する。
// 構造化されたデータではなく自由文からの推測なので、拾えないときは無理に作らない
// （本文のボタンを出さず、自由入力欄だけになる）。
//
// 素の `-` `*` 箇条書き（`・` 変換後も含む）は選択肢の合図に使わない。
// かつては使っていたが、実際には「作業内容の説明」のような、選ばせる意図の無い
// 普通の箇条書きにまで反応していた（例: 「- ○○を追加した」「- △△を直した」という
// 作業報告の4行が、そのままボタン化されて選択肢のように見えてしまった）。番号・記号
// 付きの列挙（`1.` `A)` など）は「選ばせる」意図がはっきりしているのに対し、素の
// 箇条書きは地の文の一部として使われる頻度のほうが圧倒的に高く、見分けが付かない。

import { splitMarkdownBlocks } from "@/lib/markdown";

export interface ReplyOption {
  /** ボタンに出す短いラベル（「1」「A」など）。 */
  label: string;
  /** 選んだときに実際に送る本文。 */
  text: string;
}

// 行頭の `1.` `1)` `A.` `A)` だけを選択肢の合図とみなす。
const OPTION_LINE = /^\s*(?:(\d{1,2})[.)]|([A-Za-z])[.)])\s+(.+)$/;

// 誤検出（本文中のただの箇条書き・番号付き手順）を避けるため、これ未満の候補数なら
// 「選択肢」として扱わない。
const MIN_OPTIONS = 2;

function extractLineOptions(text: string): ReplyOption[] {
  const options: ReplyOption[] = [];

  for (const line of text.split("\n")) {
    const match = line.match(OPTION_LINE);
    if (!match) continue;
    // OPTION_LINE は数字・英字どちらかの捕捉グループが必ず埋まる（`match[1]` と
    // `match[2]` のどちらかは常に一致する）ので、フォールバックのラベル生成は要らない。
    const label = (match[1] ?? match[2])!;
    const body = match[3]?.trim();
    if (body) options.push({ label, text: body });
  }

  return options;
}

// 案をMarkdownの表で示すこともある（「案」「X」「Y」のような短い記号を左端の列に置き、
// 残りの列で内容を説明する形）。列挙の行が見つからないときだけ、表の先頭列を選択肢として
// 拾い直す。`splitMarkdownBlocks`（表示側と同じ表パーサー）に任せるので、パース自体は
// 二重実装しない。先頭列がラベルらしい短い記号（英数字1〜4文字）の行だけを候補にする。
const TABLE_OPTION_LABEL = /^[A-Za-z0-9]{1,4}$/;

function extractTableOptions(text: string): ReplyOption[] {
  const options: ReplyOption[] = [];

  for (const block of splitMarkdownBlocks(text)) {
    if (block.kind !== "table") continue;
    for (const row of block.rows) {
      const label = row[0]?.trim();
      if (!label || !TABLE_OPTION_LABEL.test(label)) continue;
      const body = row
        .slice(1)
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" / ");
      if (body) options.push({ label, text: `${label}: ${body}` });
    }
  }

  return options;
}

export function extractOptions(text: string): ReplyOption[] {
  const lineOptions = extractLineOptions(text);
  if (lineOptions.length >= MIN_OPTIONS) return lineOptions;

  const tableOptions = extractTableOptions(text);
  if (tableOptions.length >= MIN_OPTIONS) return tableOptions;

  return [];
}
