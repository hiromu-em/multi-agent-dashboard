import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// エージェントの作業ディレクトリで何が変わったかを集める。
//
// 引数なしの `git diff` は「作業ツリーとステージの差」しか出さない。
// エージェントは新しいファイルを作り、区切りで `git add` するので、
// それだけを見ていると「真面目に作業しているほど差分が消える」ことになる。
// 実際には大量に変更されているのに「変更なし」と表示されてしまう。
//
// そこで3つを合わせて出す:
//   1. 追跡済みファイルの未コミット変更（ステージ済みも含む）
//   2. 新規ファイル（どの diff にも現れない）
//   3. エージェントが自分でコミットした分（分岐元との差）

// 差分に含める新規ファイルの上限。多すぎるとパネルが埋まって読めない。
const MAX_UNTRACKED_FILES = 20;

// 差分全体の上限。巨大な生成物で画面と通信を潰さないため。
const MAX_DIFF_CHARS = 400_000;

// コミット済みの変更を比べる相手の候補。先に見つかったものを使う。
const BASE_BRANCHES = ["main", "master"];

/**
 * git を実行する。
 *
 * `git diff` 系は差分があると終了コード1を返すため、それをエラー扱いにしない。
 * 終了コード1でも stdout は取れているので、そのまま返す。
 */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code === 1 && typeof failure.stdout === "string") return failure.stdout;
    throw error;
  }
}

/** 追跡済みファイルの未コミット変更。ステージ済みと未ステージの両方を含む。 */
async function trackedChanges(cwd: string): Promise<string> {
  try {
    return await git(cwd, ["diff", "HEAD", "--unified=3"]);
  } catch {
    // コミットが1つも無いリポジトリでは HEAD を解決できない。
    // その場合はステージ済みの分だけ見る。ここも失敗するならgit管理下ではない。
    return await git(cwd, ["diff", "--cached", "--unified=3"]);
  }
}

/** `.gitignore` を尊重して新規ファイルを列挙する（node_modules などは除かれる）。 */
async function listUntracked(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 新規ファイルを「追加された差分」として表示する。
 *
 * `--no-index` で /dev/null と比べる。読み取りだけで済み、
 * エージェントのインデックスに触らない（`git add` してしまうと作業を壊す）。
 */
async function untrackedChanges(cwd: string, files: string[]): Promise<string[]> {
  const sections: string[] = [];

  for (const file of files.slice(0, MAX_UNTRACKED_FILES)) {
    try {
      sections.push(await git(cwd, ["diff", "--no-index", "--unified=3", "--", "/dev/null", file]));
    } catch {
      // 読めないファイルは飛ばす。差分全体を落とすほどではない。
    }
  }

  const rest = files.length - MAX_UNTRACKED_FILES;
  if (rest > 0) sections.push(`… 他 ${rest} 件の新規ファイル`);

  return sections;
}

/**
 * エージェントが自分でコミットした分。worktreeで動くエージェントは
 * 作業を commit してしまうことがあり、その場合は未コミット差分が空になる。
 *
 * 分岐元が分からないときは何も返さない。推測で誤ったものを見せるより出さない。
 */
async function committedChanges(cwd: string): Promise<string> {
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  for (const base of BASE_BRANCHES) {
    if (!branch || branch === base) return "";

    // `--verify --quiet` は見つからないと終了コード1と空の出力を返す。
    const sha = await git(cwd, ["rev-parse", "--verify", "--quiet", base]);
    if (!sha.trim()) continue;

    const diff = await git(cwd, ["diff", `${base}...HEAD`, "--unified=3"]);
    if (!diff.trim()) return "";
    return `=== ${base} からコミット済みの変更 ===\n${diff}`;
  }

  return "";
}

/**
 * 作業ディレクトリの変更をまとめて返す。
 * git管理下でない場合や変更が無い場合は空文字を返す。
 */
export async function collectDiff(cwd: string): Promise<string> {
  const sections: string[] = [];

  try {
    sections.push(await trackedChanges(cwd));
  } catch {
    // gitリポジトリではない。差分なしとして扱う。
    return "";
  }

  try {
    sections.push(...(await untrackedChanges(cwd, await listUntracked(cwd))));
  } catch {
    // 新規ファイルが採れなくても、追跡済みの差分は見せる価値がある。
  }

  try {
    sections.push(await committedChanges(cwd));
  } catch {
    // 分岐元が辿れないときは黙って省く。
  }

  const diff = sections
    .filter((section) => section.trim())
    .join("\n")
    .trim();

  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n… 差分が大きいため以降を省略しました`;
}
