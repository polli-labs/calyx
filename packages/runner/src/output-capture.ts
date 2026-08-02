import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

import type { ArtifactEntry, JsonValue, RunOutputCapture } from "./types.js";

export type RunOutputCaptureFailureKind = "invalid_output" | "materialization_failed";

export class RunOutputCaptureError extends Error {
  constructor(message: string, readonly failure_kind: RunOutputCaptureFailureKind) {
    super(message);
    this.name = "RunOutputCaptureError";
  }
}

function invalidOutput(message: string): never {
  throw new RunOutputCaptureError(message, "invalid_output");
}

function assertSafeBasename(name: string): void {
  if (
    name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\0")
    || path.isAbsolute(name)
  ) {
    throw new RunOutputCaptureError(
      `Output capture name ${JSON.stringify(name)} is not a safe basename.`,
      "materialization_failed",
    );
  }
}

/** Strict JSON parser that rejects duplicate object member names. */
class StrictJsonParser {
  private offset = 0;

  constructor(private readonly text: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.text.length) {
      invalidOutput(`Terminal output is malformed JSON at byte ${this.offset}.`);
    }
    return value;
  }

  private parseValue(): JsonValue {
    const token = this.text[this.offset];
    if (token === "{") return this.parseObject();
    if (token === "[") return this.parseArray();
    if (token === '"') return this.parseString();
    if (this.text.startsWith("true", this.offset)) {
      this.offset += 4;
      return true;
    }
    if (this.text.startsWith("false", this.offset)) {
      this.offset += 5;
      return false;
    }
    if (this.text.startsWith("null", this.offset)) {
      this.offset += 4;
      return null;
    }
    return this.parseNumber();
  }

  private parseObject(): { [key: string]: JsonValue } {
    this.offset += 1;
    this.skipWhitespace();
    const value = Object.create(null) as { [key: string]: JsonValue };
    const keys = new Set<string>();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return value;
    }
    while (this.offset < this.text.length) {
      if (this.text[this.offset] !== '"') {
        invalidOutput(`Terminal output is malformed JSON at byte ${this.offset}: expected an object key.`);
      }
      const key = this.parseString();
      if (keys.has(key)) {
        invalidOutput(`Terminal output contains duplicate JSON object key ${JSON.stringify(key)}.`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.offset] !== ":") {
        invalidOutput(`Terminal output is malformed JSON at byte ${this.offset}: expected ':'.`);
      }
      this.offset += 1;
      this.skipWhitespace();
      value[key] = this.parseValue();
      this.skipWhitespace();
      const delimiter = this.text[this.offset];
      if (delimiter === "}") {
        this.offset += 1;
        return value;
      }
      if (delimiter !== ",") {
        invalidOutput(`Terminal output is malformed JSON at byte ${this.offset}: expected ',' or '}'.`);
      }
      this.offset += 1;
      this.skipWhitespace();
    }
    return invalidOutput("Terminal output is malformed JSON: unterminated object.");
  }

  private parseArray(): JsonValue[] {
    this.offset += 1;
    this.skipWhitespace();
    const value: JsonValue[] = [];
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return value;
    }
    while (this.offset < this.text.length) {
      value.push(this.parseValue());
      this.skipWhitespace();
      const delimiter = this.text[this.offset];
      if (delimiter === "]") {
        this.offset += 1;
        return value;
      }
      if (delimiter !== ",") {
        invalidOutput(`Terminal output is malformed JSON at byte ${this.offset}: expected ',' or ']'.`);
      }
      this.offset += 1;
      this.skipWhitespace();
    }
    return invalidOutput("Terminal output is malformed JSON: unterminated array.");
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset);
      if (code === 0x22) {
        this.offset += 1;
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string;
        } catch {
          return invalidOutput(`Terminal output contains an invalid JSON string at byte ${start}.`);
        }
      }
      if (code < 0x20) {
        invalidOutput(`Terminal output contains an unescaped control character at byte ${this.offset}.`);
      }
      if (code === 0x5c) {
        this.offset += 1;
        const escaped = this.text[this.offset];
        if (escaped === "u") {
          const hex = this.text.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            invalidOutput(`Terminal output contains an invalid Unicode escape at byte ${this.offset - 1}.`);
          }
          this.offset += 5;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
          invalidOutput(`Terminal output contains an invalid escape at byte ${this.offset - 1}.`);
        }
      }
      this.offset += 1;
    }
    return invalidOutput(`Terminal output contains an unterminated JSON string at byte ${start}.`);
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.offset));
    if (!match) return invalidOutput(`Terminal output is malformed JSON at byte ${this.offset}.`);
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return invalidOutput("Terminal output contains a non-finite JSON number.");
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.text[this.offset] === " " ||
      this.text[this.offset] === "\t" ||
      this.text[this.offset] === "\r" ||
      this.text[this.offset] === "\n"
    ) {
      this.offset += 1;
    }
  }
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalidOutput("Terminal JSON contains a lone Unicode surrogate.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalidOutput("Terminal JSON contains a lone Unicode surrogate.");
    }
  }
}

function canonicalizeJson(value: JsonValue): string {
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  const keys = Object.keys(value);
  keys.forEach(assertValidUnicode);
  return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key]!)}`).join(",")}}`;
}

async function durableWriteExclusive(runDir: string, name: string, bytes: Buffer): Promise<string> {
  const rootStat = await lstat(runDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Run output root must be a real directory, not a symlink.");
  }
  const canonicalRoot = await realpath(runDir);
  const targetPath = path.resolve(canonicalRoot, name);
  if (path.dirname(targetPath) !== canonicalRoot) throw new Error("Run output target escapes its run directory.");
  const tempPath = path.join(canonicalRoot, `.${name}.${randomUUID()}.tmp`);
  let targetLinked = false;
  let complete = false;
  try {
    const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // link(2) is the publication primitive: unlike rename(2), it fails with
    // EEXIST rather than overwriting a target created by a concurrent writer.
    await link(tempPath, targetPath);
    targetLinked = true;
    await rm(tempPath);
    const directory = await open(canonicalRoot, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    complete = true;
    return targetPath;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (!complete && targetLinked) {
      await rm(targetPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function materializeRunOutputCapture(args: {
  run_id: string;
  run_dir: string | undefined;
  capture: RunOutputCapture;
  terminal_message: string | undefined;
  now?: () => string;
}): Promise<ArtifactEntry> {
  assertSafeBasename(args.capture.name);
  if (!args.run_dir) {
    throw new RunOutputCaptureError("Output capture requires a trusted run directory.", "materialization_failed");
  }
  if (args.terminal_message === undefined || args.terminal_message.trim().length === 0) {
    invalidOutput("Required terminal JSON output is missing.");
  }
  const rawBytes = Buffer.byteLength(args.terminal_message, "utf8");
  if (rawBytes > args.capture.max_bytes) {
    invalidOutput(`Terminal JSON output is ${rawBytes} bytes; limit is ${args.capture.max_bytes}.`);
  }

  const value = new StrictJsonParser(args.terminal_message).parse();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  let validate: ReturnType<Ajv2020["compile"]>;
  try {
    validate = ajv.compile(args.capture.schema as object);
  } catch (error) {
    throw new RunOutputCaptureError(
      `Output capture schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
      "materialization_failed",
    );
  }
  if (!validate(value)) invalidOutput(`Terminal JSON output failed schema validation: ${ajv.errorsText(validate.errors)}.`);

  const bytes = Buffer.from(canonicalizeJson(value), "utf8");
  if (bytes.byteLength > args.capture.max_bytes) {
    invalidOutput(`Canonical terminal JSON is ${bytes.byteLength} bytes; limit is ${args.capture.max_bytes}.`);
  }
  let targetPath: string;
  try {
    targetPath = await durableWriteExclusive(args.run_dir, args.capture.name, bytes);
  } catch (error) {
    if (error instanceof RunOutputCaptureError) throw error;
    throw new RunOutputCaptureError(
      `Failed to materialize terminal JSON output: ${error instanceof Error ? error.message : String(error)}`,
      "materialization_failed",
    );
  }

  return {
    name: args.capture.name,
    location: "run_dir",
    path: targetPath,
    size_bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    required: true,
    detected_at: (args.now ?? (() => new Date().toISOString()))(),
  };
}
