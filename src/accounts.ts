import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GrokShopError } from "./errors.js";
import { newId } from "./ids.js";
import { resetsAt, upgradeError, utcDay } from "./limits.js";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export type AccountRecord = {
  id: string;
  email: string;
  password_hash: string;
  api_key_hash: string;
  api_key_prefix: string;
  tier: "free";
  created_at: string;
  usage_day: string;
  tool_calls: number;
  checkouts: number;
};

type AccountFile = {
  version: 1;
  accounts: Record<string, AccountRecord>;
  key_index: Record<string, string>;
};

export type AccountStore = {
  dataDir: string;
  now: () => Date;
  toolCallsPerDay: number;
  checkoutsPerDay: number;
};

export type PublicAccount = {
  account_id: string;
  email: string;
  tier: "free";
  catalog: "sample";
  charged: false;
  api_key_prefix: string;
  limits: {
    tool_calls_per_day: number;
    checkouts_per_day: number;
  };
  usage: {
    day: string;
    tool_calls: number;
    checkouts: number;
    resets_at: string;
  };
  created_at: string;
};

export type IssuedAccount = {
  api_key: string;
  account: PublicAccount;
};

const DUMMY_PASSWORD_HASH = hashPassword("not-a-real-password");

export function signup(store: AccountStore, emailRaw: string, password: string): IssuedAccount {
  const email = normalizeEmail(emailRaw);
  validatePassword(password);
  const apiKey = newApiKey();
  const now = store.now();
  const record: AccountRecord = {
    id: newId("acct"),
    email,
    password_hash: hashPassword(password),
    api_key_hash: hashApiKey(apiKey),
    api_key_prefix: apiKey.slice(0, 12),
    tier: "free",
    created_at: now.toISOString(),
    usage_day: utcDay(now),
    tool_calls: 0,
    checkouts: 0,
  };
  const account = updateAccounts(store, (file) => {
    if (findByEmail(file, email)) {
      throw new GrokShopError(
        "email_taken",
        "An account with that email already exists. POST /login to issue a new API key.",
        409,
      );
    }
    file.accounts[record.id] = record;
    file.key_index[record.api_key_hash] = record.id;
    return toPublic(store, record);
  });
  return { api_key: apiKey, account };
}

/**
 * Checks the password and rotates the API key. The previous key stops working.
 * v1 returns the new key in the response. No email is sent.
 */
export function login(store: AccountStore, emailRaw: string, password: string): IssuedAccount {
  const email = normalizeEmail(emailRaw);
  validatePassword(password);
  const apiKey = newApiKey();
  const account = updateAccounts(store, (file) => {
    const existing = findByEmail(file, email);
    const ok = verifyPassword(password, existing?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!existing || !ok) {
      throw new GrokShopError("unauthorized", "Email or password is wrong.", 401);
    }
    delete file.key_index[existing.api_key_hash];
    existing.api_key_hash = hashApiKey(apiKey);
    existing.api_key_prefix = apiKey.slice(0, 12);
    file.key_index[existing.api_key_hash] = existing.id;
    rollDay(existing, store.now());
    return toPublic(store, existing);
  });
  return { api_key: apiKey, account };
}

export function authenticate(store: AccountStore, header: string | undefined): AccountRecord | null {
  const token = bearerToken(header);
  if (!token?.startsWith("gsk_")) return null;
  const file = readAccounts(store);
  const id = file.key_index[hashApiKey(token)];
  if (!id) return null;
  return file.accounts[id] ?? null;
}

export function loadPublicAccount(store: AccountStore, accountId: string): PublicAccount {
  return updateAccounts(store, (file) => {
    const account = file.accounts[accountId];
    if (!account) throw new GrokShopError("not_found", "Account not found", 404);
    rollDay(account, store.now());
    return toPublic(store, account);
  });
}

export function consumeToolCall(store: AccountStore, accountId: string): void {
  updateAccounts(store, (file) => {
    const account = requireAccount(file, accountId);
    rollDay(account, store.now());
    if (account.tool_calls >= store.toolCallsPerDay) {
      throw upgradeError("tool_calls", account.tool_calls, store.toolCallsPerDay, account.usage_day);
    }
    account.tool_calls += 1;
  });
}

export function assertCheckoutCapacity(store: AccountStore, accountId: string): void {
  updateAccounts(store, (file) => {
    const account = requireAccount(file, accountId);
    rollDay(account, store.now());
    if (account.checkouts >= store.checkoutsPerDay) {
      throw upgradeError("checkouts", account.checkouts, store.checkoutsPerDay, account.usage_day);
    }
  });
}

export function recordCheckout(store: AccountStore, accountId: string): void {
  updateAccounts(store, (file) => {
    const account = requireAccount(file, accountId);
    rollDay(account, store.now());
    account.checkouts += 1;
  });
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

function toPublic(store: AccountStore, account: AccountRecord): PublicAccount {
  return {
    account_id: account.id,
    email: account.email,
    tier: "free",
    catalog: "sample",
    charged: false,
    api_key_prefix: account.api_key_prefix,
    limits: {
      tool_calls_per_day: store.toolCallsPerDay,
      checkouts_per_day: store.checkoutsPerDay,
    },
    usage: {
      day: account.usage_day,
      tool_calls: account.tool_calls,
      checkouts: account.checkouts,
      resets_at: resetsAt(account.usage_day),
    },
    created_at: account.created_at,
  };
}

function rollDay(account: AccountRecord, now: Date): void {
  const day = utcDay(now);
  if (account.usage_day === day) return;
  account.usage_day = day;
  account.tool_calls = 0;
  account.checkouts = 0;
}

function requireAccount(file: AccountFile, accountId: string): AccountRecord {
  const account = file.accounts[accountId];
  if (!account) throw new GrokShopError("not_found", "Account not found", 404);
  return account;
}

function findByEmail(file: AccountFile, email: string): AccountRecord | undefined {
  return Object.values(file.accounts).find((account) => account.email === email);
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GrokShopError("validation_error", "email must be a normal email address", 400);
  }
  return email;
}

function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 200) {
    throw new GrokShopError("validation_error", "password must be 8 to 200 characters", 400);
  }
}

function newApiKey(): string {
  return `gsk_${randomBytes(32).toString("hex")}`;
}

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString("hex");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4] ?? "";
  const expectedHex = parts[5] ?? "";
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || !salt || !expectedHex) return false;
  const got = scryptSync(password, salt, 32, { N, r, p });
  const expected = Buffer.from(expectedHex, "hex");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function accountsPath(store: AccountStore): string {
  return path.join(store.dataDir, "accounts.json");
}

function emptyFile(): AccountFile {
  return { version: 1, accounts: {}, key_index: {} };
}

function readAccounts(store: AccountStore): AccountFile {
  const file = accountsPath(store);
  if (!existsSync(file)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as AccountFile;
    if (!parsed || parsed.version !== 1 || !parsed.accounts || !parsed.key_index) {
      throw new Error("unexpected shape");
    }
    return parsed;
  } catch (err) {
    if (err instanceof GrokShopError) throw err;
    throw new GrokShopError("state_corrupt", `Could not read ${file}`, 500);
  }
}

function updateAccounts<T>(store: AccountStore, mutate: (file: AccountFile) => T): T {
  mkdirSync(store.dataDir, { recursive: true });
  const file = readAccounts(store);
  const result = mutate(file);
  const target = accountsPath(store);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, target);
  return result;
}
