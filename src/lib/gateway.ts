import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 窓口として使っているセッションの除外リスト。
 *
 * 窓口は本来ボードに並ばない決まり（AGENTS.md）だが、`claude --bg` で
 * 起動したセッションをそのまま窓口として使うと、CLIからは他のサブエージェントと
 * 区別が付かず `claude agents --json --all` に同じ形で出てくる。
 * 構造的に見分けられない以上、運用者が明示的に登録するしかない。
 *
 * `.logs/gateway.json` に `{ "sessionIds": ["…"] }` として持つ。ここに載った
 * sessionId は listAgents() の時点で弾かれるので、ボードにも配送ループ防止の
 * 対象（"レーンに居る＝窓口ではない"の判定）にも入らない。
 */
const GATEWAY_FILE = join(process.cwd(), ".logs", "gateway.json");

let cache: { at: number; ids: Set<string> } | null = null;
const CACHE_TTL_MS = 2000;

async function readGatewayIds(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.ids;

  let ids = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(await readFile(GATEWAY_FILE, "utf8"));
    const list = (parsed as { sessionIds?: unknown })?.sessionIds;
    if (Array.isArray(list)) {
      ids = new Set(list.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    // ファイルが無い、または壊れている。除外なしとして扱う。
  }

  cache = { at: Date.now(), ids };
  return ids;
}

export async function isGatewaySession(sessionId: string): Promise<boolean> {
  return (await readGatewayIds()).has(sessionId);
}

export async function filterOutGateway<T extends { sessionId: string }>(items: T[]): Promise<T[]> {
  const ids = await readGatewayIds();
  if (ids.size === 0) return items;
  return items.filter((item) => !ids.has(item.sessionId));
}
