// エージェントの質問文から選択肢らしい行を抜き出す。
//
// 対話待ち（waiting）のレーンは、エージェントがターンを終えて質問文を返した状態。
// 「1. 案A」「A) 案B」のような列挙で選択肢を示すことが多いので、それをボタン化する。
// 構造化されたデータではなく自由文からの推測なので、拾えないときは無理に作らない
// （本文のボタンを出さず、自由入力欄だけになる）。

export interface ReplyOption {
  /** ボタンに出す短いラベル（「1」「A」など）。 */
  label: string;
  /** 選んだときに実際に送る本文。 */
  text: string;
}

// 行頭の `1.` `1)` `A.` `A)`、生のMarkdown箇条書き `- ` `* `、または箇条書き変換後の
// `・` を選択肢の合図とみなす。ここで見るのは表示前の生テキスト（entry.text）なので、
// 変換後の `・` だけでなく変換前の `-` `*` も拾わないと取りこぼす。
const OPTION_LINE = /^\s*(?:(\d{1,2})[.)]|([A-Za-z])[.)]|[-*](?!\*)|・)\s+(.+)$/;

// 誤検出（本文中のただの箇条書き・番号付き手順）を避けるため、これ未満の候補数なら
// 「選択肢」として扱わない。
const MIN_OPTIONS = 2;

export function extractOptions(text: string): ReplyOption[] {
  const options: ReplyOption[] = [];

  for (const line of text.split("\n")) {
    const match = line.match(OPTION_LINE);
    if (!match) continue;
    const label = match[1] ?? match[2] ?? String(options.length + 1);
    const body = match[3]?.trim();
    if (body) options.push({ label, text: body });
  }

  return options.length >= MIN_OPTIONS ? options : [];
}
