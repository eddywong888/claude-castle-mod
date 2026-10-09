export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = { usd?: number; tokens?: number; window: number; percent?: number; limits: Limit[] }
export type LastTurn = { ms: number; out: number }
export type Lines = { added: number; removed: number }
export type Profile = { level: number; title: string; into: number; need: number; xp: number; streak: number; unlocked: string[]; castleTier: number }
export type Cache = { read: number; written: number; uncached: number; at: number; model?: string; ttlMs?: number; rebased?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'castle-hud': { usage: Usage | null; cache: Cache | null; bats: number; now: number; windowUsd: number | null; lastTurn: LastTurn | null; lines: Lines; startedAt: number; profile: Profile | null; xpId: string }
  }
}
