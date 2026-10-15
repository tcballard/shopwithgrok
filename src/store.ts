import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ShopContext } from "./context.js";
import { GrokShopError } from "./errors.js";
import type { ShopState } from "./types.js";

function emptyState(): ShopState {
  return { version: 1, checkouts: {}, rates: {} };
}

function statePath(ctx: ShopContext): string {
  return path.join(ctx.dataDir, "state.json");
}

export function readState(ctx: ShopContext): ShopState {
  const file = statePath(ctx);
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ShopState;
    if (!parsed || parsed.version !== 1 || !parsed.checkouts || !parsed.rates) {
      throw new Error("unexpected shape");
    }
    return parsed;
  } catch {
    throw new GrokShopError("state_corrupt", `Could not read ${file}`, 500);
  }
}

export function updateState<T>(ctx: ShopContext, mutate: (state: ShopState) => T): T {
  mkdirSync(ctx.dataDir, { recursive: true });
  const file = statePath(ctx);
  const state = readState(ctx);
  const result = mutate(state);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
  return result;
}
