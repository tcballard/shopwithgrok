import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ShopContext } from "./context.js";
import { GrokShopError } from "./errors.js";
import type { ShopState } from "./types.js";

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

function emptyState(): ShopState {
  return { version: 1, checkouts: {}, rates: {}, inventory_sold: {} };
}

function statePath(ctx: ShopContext): string {
  return path.join(ctx.dataDir, "state.json");
}

function lockPath(ctx: ShopContext): string {
  return path.join(ctx.dataDir, "state.lock");
}

export function readState(ctx: ShopContext): ShopState {
  const file = statePath(ctx);
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ShopState>;
    if (!parsed || parsed.version !== 1 || !parsed.checkouts || !parsed.rates) {
      throw new Error("unexpected shape");
    }
    return {
      version: 1,
      checkouts: parsed.checkouts,
      rates: parsed.rates,
      inventory_sold: soldOverlay(parsed.inventory_sold),
    };
  } catch {
    throw new GrokShopError("state_corrupt", `Could not read ${file}`, 500);
  }
}

function soldOverlay(raw: unknown): Record<string, number> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("unexpected shape");
  }
  const sold: Record<string, number> = {};
  for (const [sku, value] of Object.entries(raw)) {
    if (!sku || typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error("unexpected shape");
    }
    if (value > 0) sold[sku] = value;
  }
  return sold;
}

export function updateState<T>(ctx: ShopContext, mutate: (state: ShopState) => T): T {
  acquireLock(ctx);
  try {
    mkdirSync(ctx.dataDir, { recursive: true });
    const file = statePath(ctx);
    const state = readState(ctx);
    const result = mutate(state);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
    return result;
  } finally {
    releaseLock(ctx);
  }
}

function acquireLock(ctx: ShopContext): void {
  mkdirSync(ctx.dataDir, { recursive: true });
  const file = lockPath(ctx);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (lockIsStale(file)) {
        try {
          unlinkSync(file);
        } catch {
          // the holder released it, or another waiter stole it
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new GrokShopError("state_locked", "Timed out waiting to update shop state", 503);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function lockIsStale(file: string): boolean {
  try {
    if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

function releaseLock(ctx: ShopContext): void {
  try {
    const file = lockPath(ctx);
    const owner = readFileSync(file, "utf8");
    if (owner === String(process.pid)) unlinkSync(file);
  } catch {
    // already released
  }
}
