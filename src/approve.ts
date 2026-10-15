#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contextFromEnv } from "./context.js";
import { asGrokShopError } from "./errors.js";
import { approveCheckout } from "./service.js";

type TextStream = { write: (chunk: string) => void };

export function runApprove(
  argv: string[],
  stdout: TextStream = process.stdout,
  stderr: TextStream = process.stderr,
): number {
  const id = argv.find((arg) => !arg.startsWith("-"));
  if (!id) {
    stderr.write("Usage: npm run approve -- chk_<id>\n");
    return 1;
  }
  try {
    const checkout = approveCheckout(id, "cli", contextFromEnv());
    stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          checkout_id: checkout.id,
          human_approved: checkout.human_approved,
          approval: checkout.approval,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (err) {
    const normalized = asGrokShopError(err);
    stderr.write(`${normalized.code}: ${normalized.message}\n`);
    return 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  process.exit(runApprove(process.argv.slice(2)));
}
