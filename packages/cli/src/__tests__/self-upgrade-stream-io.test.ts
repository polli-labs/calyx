import { once } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  createFailOpenProjectionWriter,
  execSelfUpgradeStreaming,
} from "../self-upgrade-stream-io.js";

describe("self-upgrade byte-stream transport", () => {
  test("reassembles chunked CRLF frames and emits an unterminated tail", async () => {
    const lines: string[] = [];
    const script = [
      "process.stdout.write('{\"status\":\"ok\"}\\n');",
      "process.stderr.write(Buffer.from('first\\r'));",
      "setTimeout(() => process.stderr.write(Buffer.from('\\nsec')), 5);",
      "setTimeout(() => process.stderr.write(Buffer.from('ond\\r\\ntail')), 10);",
    ].join("");

    const result = await execSelfUpgradeStreaming(process.execPath, ["-e", script], {
      onStderrLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(["first", "second", "tail"]);
    expect(result.stdout).toBe('{"status":"ok"}\n');
    expect(result.stderr).toBe("first\r\nsecond\r\ntail");
    expect(result.stderr_capture.truncated).toBe(false);
  });

  test("keeps parsing typed lines after diagnostic capture and line caps", async () => {
    const lines: string[] = [];
    const script = [
      "process.stderr.write('x'.repeat(256));",
      "process.stderr.write('\\n{\"typed\":true}\\n');",
      "process.stdout.write(JSON.stringify({status:'succeeded',receipt:'r'.repeat(256)})+'\\n');",
    ].join("");

    const result = await execSelfUpgradeStreaming(process.execPath, ["-e", script], {
      maxBuffer: 32,
      maxStderrLineBytes: 64,
      onStderrLine: (line) => lines.push(line),
    });

    expect(JSON.parse(result.stdout)).toEqual({ status: "succeeded", receipt: "r".repeat(256) });
    expect(result.stdout_capture.truncated).toBe(false);
    expect(lines).toEqual(['{"typed":true}']);
    expect(result.stderr_capture).toMatchObject({
      captured_bytes: 32,
      truncated: true,
    });
    expect(result.stderr_capture.dropped_bytes).toBeGreaterThan(200);
  });

  test("treats a throwing frame consumer as a projection failure", async () => {
    const lineErrors: string[] = [];
    const result = await execSelfUpgradeStreaming(
      process.execPath,
      ["-e", "process.stderr.write('frame\\n'); process.stdout.write('final');"],
      {
        onStderrLine: () => {
          throw new Error("consumer closed");
        },
        onStderrLineError: (error) => lineErrors.push(error instanceof Error ? error.message : String(error)),
      },
    );

    expect(result.stdout).toBe("final");
    expect(lineErrors).toEqual(["consumer closed"]);
  });

  test("absorbs a throwing frame-error observer", async () => {
    const result = await execSelfUpgradeStreaming(
      process.execPath,
      ["-e", "process.stderr.write('frame\\n'); process.stdout.write('final');"],
      {
        onStderrLine: () => {
          throw new Error("consumer closed");
        },
        onStderrLineError: () => {
          throw new Error("diagnostic observer closed");
        },
      },
    );

    expect(result.stdout).toBe("final");
  });
});

describe("fail-open projection writer", () => {
  test("drops while a slow sink is backpressured and resumes on drain", async () => {
    const writes: string[] = [];
    const callbacks: Array<() => void> = [];
    const unavailable: string[] = [];
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString());
        callbacks.push(callback);
      },
    });
    const writer = createFailOpenProjectionWriter(sink, (reason) => unavailable.push(reason));

    writer.write("first");
    writer.write("dropped");
    const drained = once(sink, "drain");
    callbacks.shift()?.();
    await drained;
    writer.write("second");
    callbacks.shift()?.();
    await writer.stop();

    expect(writes).toEqual(["first", "second"]);
    expect(unavailable).toEqual([
      "projection stream is backpressured; progress records are being dropped",
    ]);
  });

  test("absorbs asynchronous EPIPE and closed-sink writes", async () => {
    const unavailable = vi.fn();
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
      },
    });
    const writer = createFailOpenProjectionWriter(sink, unavailable);

    expect(() => writer.write("projection\n")).not.toThrow();
    await once(sink, "error");
    expect(unavailable).toHaveBeenCalledWith("broken pipe");
    expect(() => writer.write("after-close\n")).not.toThrow();
    await writer.stop();
  });

  test("absorbs failures from the projection-loss observer", async () => {
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        // Deliberately remain backpressured.
      },
    });
    const writer = createFailOpenProjectionWriter(sink, () => {
      throw new Error("warning sink also failed");
    }, 0);

    expect(() => writer.write("projection\n")).not.toThrow();
    expect(() => writer.write("dropped\n")).not.toThrow();
    await writer.stop();
    sink.destroy();
  });

  test("bounds a never-settling final write and reports the loss before stop returns", async () => {
    const unavailable: string[] = [];
    const sink = new Writable({
      write(_chunk, _encoding, _callback) {
        // Neither callback nor error/close: model a permanently slow sink.
      },
    });
    const writer = createFailOpenProjectionWriter(
      sink,
      (reason) => unavailable.push(reason),
      0,
    );

    writer.write("terminal projection\n");
    await writer.stop();

    expect(unavailable).toEqual([
      "projection stream did not settle within 0ms; pending output was dropped",
    ]);
    sink.destroy();
  });

  test("attributes error and close after more than two event-loop turns", async () => {
    for (const signal of ["error", "close"] as const) {
      const unavailable: string[] = [];
      const sink = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
          void (async () => {
            for (let turn = 0; turn < 4; turn += 1) {
              await new Promise<void>((resolve) => { setImmediate(resolve); });
            }
            if (signal === "error") {
              sink.emit("error", new Error("post-callback EPIPE"));
            } else {
              sink.emit("close");
            }
          })();
        },
      });
      const writer = createFailOpenProjectionWriter(
        sink,
        (reason) => unavailable.push(reason),
      );

      writer.write("terminal projection\n");
      await writer.stop();
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }

      expect(unavailable).toEqual([
        signal === "error" ? "post-callback EPIPE" : "projection stream closed",
      ]);
    }
  });

  test("retains one bounded late-signal attribution on a shared sink", async () => {
    const reports = Array.from({ length: 16 }, () => [] as string[]);
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    for (const report of reports) {
      const writer = createFailOpenProjectionWriter(sink, (reason) => report.push(reason));
      writer.write("projection\n");
      await writer.stop();
    }

    expect(sink.listenerCount("error")).toBe(1);
    expect(sink.listenerCount("close")).toBe(1);
    expect(sink.listenerCount("drain")).toBe(0);
    sink.emit("error", new Error("late shared EPIPE"));
    expect(reports.slice(0, -1).every((report) => report.length === 0)).toBe(true);
    expect(reports.at(-1)).toEqual(["late shared EPIPE"]);
  });

  test("replaces retired attribution while a newer writer is active", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const firstWriter = createFailOpenProjectionWriter(sink, (reason) => first.push(reason));
    await firstWriter.stop();
    const secondWriter = createFailOpenProjectionWriter(sink, (reason) => second.push(reason));

    sink.emit("error", new Error("new operation EPIPE"));

    expect(first).toEqual([]);
    expect(second).toEqual(["new operation EPIPE"]);
    await secondWriter.stop();
  });

  test("an idempotent old stop cannot replace a newer retired attribution", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const firstWriter = createFailOpenProjectionWriter(sink, (reason) => first.push(reason));
    await firstWriter.stop();
    const secondWriter = createFailOpenProjectionWriter(sink, (reason) => second.push(reason));
    await secondWriter.stop();

    await firstWriter.stop();
    sink.emit("error", new Error("latest operation EPIPE"));

    expect(first).toEqual([]);
    expect(second).toEqual(["latest operation EPIPE"]);
  });

  test("does not retain a stopped writer while another writer remains active", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const firstWriter = createFailOpenProjectionWriter(sink, (reason) => first.push(reason));
    const secondWriter = createFailOpenProjectionWriter(sink, (reason) => second.push(reason));
    await firstWriter.stop();

    sink.emit("error", new Error("active operation EPIPE"));

    expect(first).toEqual([]);
    expect(second).toEqual(["active operation EPIPE"]);
    await secondWriter.stop();
  });
});
