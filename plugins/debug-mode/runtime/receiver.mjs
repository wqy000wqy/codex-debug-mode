import { createRequire as __debugCreateRequire } from "node:module"; const require = __debugCreateRequire(import.meta.url);

// src/receiver.mjs
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { createServer } from "node:http";
import { readFile as readFile2, mkdir } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/session-store.mjs
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
var ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function atomicJson(path, value) {
  await atomicText(path, JSON.stringify(value) + "\n");
}
async function atomicText(path, value) {
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, value, { mode: 384, flag: "wx" });
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {
    });
  }
}
var SessionStore = class {
  constructor(root2) {
    this.root = root2;
    this.queue = /* @__PURE__ */ new Map();
    this.indices = /* @__PURE__ */ new Map();
    this.scannedBytes = 0;
  }
  dir(id) {
    if (!ID.test(id)) throw Error("Invalid session ID");
    return join(this.root, id);
  }
  serial(id, task) {
    this.dir(id);
    const next = (this.queue.get(id) || Promise.resolve()).catch(() => {
    }).then(task);
    this.queue.set(id, next);
    return next.finally(() => {
      if (this.queue.get(id) === next) this.queue.delete(id);
    });
  }
  file(id, round, generation = 0) {
    return join(this.dir(id), `events-${round}-${generation}.ndjson`);
  }
  async load(id) {
    const s = JSON.parse(await readFile(join(this.dir(id), "session.json"), "utf8"));
    if (s.id !== id || !Number.isFinite(Date.parse(s.createdAt)) || Date.now() - Date.parse(s.createdAt) > 30 * 864e5) throw Error("\u8C03\u8BD5\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F");
    if (s.storageVersion !== 2) await this.migrate(s);
    s.purpose ||= "unknown";
    await this.cleanGarbage(s);
    return s;
  }
  async cleanGarbage(s) {
    if (!s.garbageFiles?.length) return;
    const left = [];
    for (const name of s.garbageFiles) {
      if (!/^events-[0-9]+-[0-9]+\.ndjson$/.test(name)) {
        left.push(name);
        continue;
      }
      try {
        await unlink(join(this.dir(s.id), name));
      } catch (e) {
        if (e.code !== "ENOENT") left.push(name);
      }
    }
    if (left.length !== s.garbageFiles.length) {
      s.garbageFiles = left;
      await atomicJson(join(this.dir(s.id), "session.json"), s);
    }
  }
  async save(s) {
    s.revision = (s.revision || 0) + 1;
    s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await atomicJson(join(this.dir(s.id), "session.json"), s);
  }
  async importLogs(source, dest, round, cutoff) {
    const tmp = dest + "." + randomUUID() + ".tmp";
    const out = await open(tmp, "wx", 384);
    let n = 0;
    try {
      const input = createReadStream(source, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let r;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          if (Date.parse(r.time) <= Date.parse(cutoff)) continue;
          await out.write(JSON.stringify({ ...r, id: r.id || randomUUID(), sequence: ++n, round }) + "\n");
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      } finally {
        lines.close();
        input.destroy();
      }
      await out.close();
      await rename(tmp, dest);
    } catch (e) {
      await out.close().catch(() => {
      });
      await unlink(tmp).catch(() => {
      });
      throw e;
    }
  }
  async migrate(s) {
    await this.importLogs(join(this.dir(s.id), "logs.ndjson"), this.file(s.id, s.round || 1, s.clearGeneration || 0), s.round || 1, s.logsClearedAt);
    s.storageVersion = 2;
    s.round = s.round || 1;
    s.clearGeneration = s.clearGeneration || 0;
    s.actions = s.actions || {};
    await this.save(s);
  }
  async index(path) {
    let info;
    try {
      info = await stat(path);
    } catch (e) {
      if (e.code === "ENOENT") return { rows: [], size: 0, stamp: 0 };
      throw e;
    }
    const old = this.indices.get(path);
    if (old && old.size === info.size && old.stamp === info.mtimeMs) return old;
    const rows = [];
    let position = 0, buffer = Buffer.alloc(0);
    this.scannedBytes += info.size;
    for await (const chunk of createReadStream(path)) {
      buffer = Buffer.concat([buffer, chunk]);
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, end);
        try {
          JSON.parse(line.toString("utf8"));
          rows.push([position, position + end + 1]);
        } catch {
        }
        position += end + 1;
        buffer = buffer.subarray(end + 1);
      }
    }
    if (buffer.length) {
      try {
        JSON.parse(buffer.toString("utf8"));
        rows.push([position, position + buffer.length]);
      } catch {
      }
    }
    const index = { rows, size: info.size, stamp: info.mtimeMs };
    this.indices.set(path, index);
    return index;
  }
  async page(path, offset = null, limit = 100) {
    const idx = await this.index(path);
    const start = offset === null ? Math.max(0, idx.rows.length - limit) : offset;
    const selected = idx.rows.slice(start, start + limit);
    let logs = [];
    if (selected.length) {
      const begin = selected[0][0], end = selected.at(-1)[1];
      const f = await open(path, "r");
      try {
        const buf = Buffer.alloc(end - begin);
        let done = 0;
        while (done < buf.length) {
          const { bytesRead } = await f.read(buf, done, buf.length - done, begin + done);
          if (!bytesRead) break;
          done += bytesRead;
        }
        logs = buf.subarray(0, done).toString("utf8").split("\n").filter(Boolean).flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      } finally {
        await f.close();
      }
    }
    return { logs, totalCount: idx.rows.length, offset: start, limit };
  }
  async snapshot(s) {
    const p = await this.page(this.file(s.id, s.round, s.clearGeneration));
    return { ...s, logs: p.logs, totalCount: p.totalCount, logOffset: p.offset, logVersion: `${s.round}:${s.clearGeneration}:${p.totalCount}` };
  }
  async append(id, body2, token) {
    return this.serial(id, async () => {
      const s = await this.load(id);
      const left = Buffer.from(typeof token === "string" ? token : ""), right = Buffer.from(typeof s.token === "string" ? s.token : "");
      if (!left.length || left.length !== right.length || !timingSafeEqual(left, right)) throw Error("Invalid debug session token");
      if (["cleanup", "fixed", "closed"].includes(s.status)) throw Error("Debug session is closed");
      const path = this.file(id, s.round, s.clearGeneration);
      const idx = await this.index(path);
      let safePath = "/";
      try {
        safePath = new URL(typeof body2.path === "string" ? body2.path : "/", "http://localhost").pathname.slice(0, 500);
      } catch {
      }
      const text = (key, max) => typeof body2[key] === "string" ? body2[key].slice(0, max) : "";
      const record = { id: randomUUID(), sequence: idx.rows.length + 1, round: s.round, runId: text("runId", 80) || `round-${s.round}`, hypothesisId: text("hypothesisId", 80), location: text("location", 300), message: text("message", 500), data: Object.fromEntries(Object.entries(body2.data && typeof body2.data === "object" && !Array.isArray(body2.data) ? body2.data : {}).slice(0, 30).filter(([k, v]) => k.length <= 100 && (v === null || ["string", "number", "boolean"].includes(typeof v))).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 500) : v])), time: (/* @__PURE__ */ new Date()).toISOString(), method: text("method", 16).toUpperCase() || "FETCH", path: safePath, status: Number.isInteger(body2.status) ? body2.status : null, durationMs: Number.isFinite(body2.durationMs) ? Math.max(0, Math.min(6e5, Math.round(body2.durationMs))) : null, errorName: text("errorName", 80) || null };
      const line = Buffer.from(JSON.stringify(record) + "\n");
      const f = await open(path, "a", 384);
      try {
        await f.writeFile(line);
      } finally {
        await f.close();
      }
      const info = await stat(path);
      idx.rows.push([idx.size, idx.size + line.length]);
      idx.size = info.size;
      idx.stamp = info.mtimeMs;
      this.indices.set(path, idx);
      return record;
    });
  }
  clearCurrent(s) {
    const path = this.file(s.id, s.round, s.clearGeneration);
    this.indices.delete(path);
    s.garbageFiles ||= [];
    s.garbageFiles.push(`events-${s.round}-${s.clearGeneration}.ndjson`);
    s.clearGeneration++;
  }
  async control(id, args) {
    return this.serial(id, async () => {
      const s = await this.load(id);
      const op = args.op;
      if (op === "snapshot") return this.snapshot(s);
      if (op === "action_status") return { sessionId: id, committed: Boolean(s.actions?.[args.actionId]), action: s.actions?.[args.actionId] || null };
      if (op === "page") {
        let round = args.round ?? s.round;
        let p;
        if (!Number.isInteger(round) || round < 1 || !Number.isInteger(args.offset ?? 0) || args.offset < 0 || !Number.isInteger(args.limit ?? 100) || (args.limit ?? 100) < 1 || (args.limit ?? 100) > 500) throw Error("Invalid page");
        if (round === s.round) p = await this.page(this.file(id, round, s.clearGeneration), args.offset ?? 0, args.limit ?? 100);
        else {
          const metaPath = join(this.dir(id), `meta-${round}.json`);
          try {
            const meta = JSON.parse(await readFile(metaPath, "utf8"));
            p = { ...meta, ...await this.page(this.file(id, round, round === s.round ? s.clearGeneration : meta.clearGeneration), args.offset ?? 0, args.limit ?? 100) };
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
            const legacy = JSON.parse(await readFile(join(this.dir(id), `round-${round}.json`), "utf8"));
            const source = join(this.dir(id), `round-${round}.ndjson`);
            const exists = await stat(source).then(() => true).catch((error) => {
              if (error.code === "ENOENT") return false;
              throw error;
            });
            const dest = this.file(id, round, 0);
            if (exists) await this.importLogs(source, dest, round, legacy.logsClearedAt);
            else await atomicText(dest, (legacy.logs || []).map((r, i) => JSON.stringify({ ...r, id: r.id || randomUUID(), sequence: i + 1, round })).join("\n") + ((legacy.logs || []).length ? "\n" : ""));
            const meta = { round, hypotheses: legacy.hypotheses, reproductionSteps: legacy.reproductionSteps, clearGeneration: 0, legacySnapshot: true, note: exists ? "\u65E7\u7248\u5F52\u6863\uFF0C\u4FDD\u7559\u73B0\u6709\u8BB0\u5F55" : "\u65E7\u7248\u5FEB\u7167\uFF0C\u4E4B\u524D\u622A\u65AD\u7684\u6570\u636E\u4E0D\u53EF\u6062\u590D" };
            await atomicJson(metaPath, meta);
            p = { ...meta, ...await this.page(dest, args.offset ?? 0, args.limit ?? 100) };
          }
        }
        return { ...p, sessionId: id, round, clearGeneration: round === s.round ? s.clearGeneration : p.clearGeneration || 0, revision: s.revision };
      }
      const actionId = args.actionId;
      if (actionId && !ID.test(actionId)) throw Error("Invalid action ID");
      if (actionId && s.actions?.[actionId]) {
        if (s.actions[actionId].op !== op) throw Error("Action ID conflict");
        return this.snapshot(s);
      }
      if (args.expectedRevision !== void 0 && args.expectedRevision !== s.revision) throw Error("\u4F1A\u8BDD\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u65B0\u64CD\u4F5C");
      if (args.expectedRound !== void 0 && args.expectedRound !== s.round) throw Error("\u8F6E\u6B21\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u64CD\u4F5C");
      if (op === "show") {
        if (s.status === "preparing" && !s.instrumentationRemovedByRequest) {
          if ((await this.page(this.file(id, s.round, s.clearGeneration))).totalCount) this.clearCurrent(s);
          s.status = "waiting";
          s.statusLabel = `\u7B2C ${s.round} \u8F6E\uFF1A\u7B49\u5F85\u590D\u73B0`;
        }
      } else if (op === "proceed") {
        if (!["waiting", "awaiting_confirmation"].includes(s.status)) throw Error("\u5F53\u524D\u4E0D\u5728\u7B49\u5F85\u7528\u6237\u53CD\u9988\u72B6\u6001");
        s.status = "investigating";
        s.statusLabel = "\u7528\u6237\u5DF2\u53CD\u9988\uFF0C\u6B63\u5728\u5206\u6790\u8FD0\u884C\u8BC1\u636E";
      } else if (op === "mark_fixed") {
        if (!["waiting", "investigating", "awaiting_confirmation"].includes(s.status)) throw Error("\u5F53\u524D\u4E0D\u80FD\u786E\u8BA4\u4FEE\u590D");
        s.cleanupReason = "confirmed_fixed";
        s.cleanupReturnStatus = "fixed";
        s.status = "cleanup";
        s.statusLabel = "\u7528\u6237\u5DF2\u786E\u8BA4\uFF0C\u7B49\u5F85\u6E05\u7406";
      } else if (op === "request_cleanup") {
        if (!["preparing", "waiting", "investigating", "awaiting_confirmation"].includes(s.status)) throw Error("\u5F53\u524D\u4E0D\u80FD\u8BF7\u6C42\u79FB\u9664\u57CB\u70B9");
        if (typeof args.endSession !== "boolean") throw Error("\u5FC5\u987B\u660E\u786E\u7528\u6237\u53EA\u79FB\u9664\u57CB\u70B9\u8FD8\u662F\u7ED3\u675F\u672C\u6B21\u8C03\u8BD5");
        s.cleanupReason = "instrumentation_removal";
        s.cleanupReturnStatus = args.endSession ? "closed" : s.status;
        s.status = "cleanup";
        s.statusLabel = "\u6309\u7528\u6237\u8981\u6C42\u6E05\u7406\u57CB\u70B9\uFF0C\u5C1A\u672A\u786E\u8BA4\u4FEE\u590D";
      } else if (op === "finish") {
        if (!["cleanup", "fixed", "closed"].includes(s.status)) throw Error("\u5C1A\u672A\u83B7\u5F97\u6E05\u7406\u8BF7\u6C42\u6216\u4FEE\u590D\u786E\u8BA4");
        if (s.status === "cleanup") {
          s.status = s.cleanupReturnStatus || "fixed";
          if (s.cleanupReason === "instrumentation_removal") {
            s.instrumentationRemovedByRequest = true;
            s.statusLabel = s.status === "closed" ? "\u7528\u6237\u5DF2\u7ED3\u675F\u8C03\u8BD5\uFF0C\u57CB\u70B9\u5DF2\u6E05\u7406\uFF1B\u672A\u786E\u8BA4\u4FEE\u590D" : "\u57CB\u70B9\u5DF2\u6309\u8981\u6C42\u6E05\u7406\uFF1B\u672A\u786E\u8BA4\u4FEE\u590D\uFF0C\u7B49\u5F85\u540E\u7EED\u6307\u793A";
          } else {
            s.instrumentationRemovedByRequest = false;
            s.statusLabel = "\u8C03\u8BD5\u5DF2\u7ED3\u675F\uFF0C\u6E05\u7406\u5B8C\u6210";
          }
        }
      } else if (op === "resume") {
        if (args.interrupted !== true) throw Error("\u8BF7\u5148\u786E\u8BA4\u4E0A\u4E00\u8F6E\u4EFB\u52A1\u5DF2\u505C\u6B62");
        if (s.status === "cleanup") {
        } else if (["preparing", "investigating"].includes(s.status)) {
          s.statusLabel = s.status === "preparing" ? "\u5DF2\u6062\u590D\uFF0C\u7EE7\u7EED\u51C6\u5907\u57CB\u70B9\u4E0E\u590D\u73B0\u6761\u4EF6" : "\u5DF2\u6062\u590D\uFF0C\u7EE7\u7EED\u5206\u6790\u672C\u8F6E\u8BC1\u636E";
        } else throw Error("\u5F53\u524D\u72B6\u6001\u65E0\u9700\u6062\u590D");
      } else if (op === "await_confirmation") {
        if (s.status !== "investigating" || s.purpose !== "verification" || !s.baselineRound) throw Error("\u4EC5\u4FEE\u590D\u540E\u590D\u9A8C\u5206\u6790\u53EF\u4EE5\u7B49\u5F85\u786E\u8BA4");
        if (typeof args.evidenceSummary !== "string" || !args.evidenceSummary.trim()) throw Error("\u9700\u8981\u524D\u540E\u65E5\u5FD7\u7684\u8BC1\u636E\u8BF4\u660E");
        const current = await this.page(this.file(id, s.round, s.clearGeneration));
        const baseline = JSON.parse(await readFile(join(this.dir(id), `meta-${s.baselineRound}.json`), "utf8"));
        const before = await this.page(this.file(id, s.baselineRound, baseline.clearGeneration));
        if (!current.totalCount || !before.totalCount) throw Error("\u7F3A\u5C11\u4FEE\u590D\u524D\u6216\u4FEE\u590D\u540E\u65E5\u5FD7\uFF0C\u4E0D\u80FD\u58F0\u79F0\u65E5\u5FD7\u652F\u6301\u6210\u529F\uFF1B\u7528\u6237\u4ECD\u53EF\u660E\u786E\u786E\u8BA4\u89E3\u51B3");
        s.evidenceSummary = args.evidenceSummary.trim();
        s.status = "awaiting_confirmation";
        s.statusLabel = "\u65E5\u5FD7\u6BD4\u8F83\u652F\u6301\u6210\u529F\uFF0C\u7B49\u5F85\u4F60\u786E\u8BA4";
      } else if (op === "clear") {
        this.clearCurrent(s);
      } else if (op === "prepare") {
        if (!["preparing", "waiting", "investigating"].includes(s.status)) throw Error("\u4F1A\u8BDD\u5DF2\u7ED3\u675F");
        if (!["investigation", "verification"].includes(args.purpose)) throw Error("\u5FC5\u987B\u660E\u786E\u672C\u8F6E\u7528\u4E8E\u8C03\u67E5\u8FD8\u662F\u4FEE\u590D\u540E\u590D\u9A8C");
        if (args.nextRound === false && (s.status !== "preparing" || s.round !== 1 || (await this.page(this.file(id, s.round, s.clearGeneration))).totalCount > 0)) throw Error("\u540C\u8F6E\u51C6\u5907\u4EC5\u9650\u5C1A\u672A\u4EA4\u63A5\u7684\u9996\u8F6E");
        if (args.purpose === "verification") {
          if (!Number.isInteger(args.baselineRound) || args.baselineRound < 1 || args.baselineRound > s.round || args.nextRound === false) throw Error("\u590D\u9A8C\u5FC5\u987B\u6307\u5B9A\u5DF2\u6709\u7684\u4FEE\u590D\u524D\u57FA\u7EBF\u8F6E\u6B21\u5E76\u63A8\u8FDB\u65B0\u8F6E");
          if (args.baselineRound < s.round) await readFile(join(this.dir(id), `meta-${args.baselineRound}.json`), "utf8");
        }
        if (args.nextRound !== false) {
          await atomicJson(join(this.dir(id), `meta-${s.round}.json`), { round: s.round, purpose: s.purpose, baselineRound: s.baselineRound ?? null, hypotheses: s.hypotheses, reproductionSteps: s.reproductionSteps, clearGeneration: s.clearGeneration });
          s.round++;
          s.clearGeneration = 0;
        }
        s.instrumentationRemovedByRequest = false;
        s.cleanupReason = null;
        s.cleanupReturnStatus = null;
        s.purpose = args.purpose;
        s.baselineRound = args.purpose === "verification" ? args.baselineRound : null;
        s.evidenceSummary = "";
        s.hypotheses = args.hypotheses;
        s.reproductionSteps = args.reproductionSteps;
        s.status = "waiting";
        s.statusLabel = `\u7B2C ${s.round} \u8F6E\uFF1A\u7B49\u5F85\u590D\u73B0`;
      } else throw Error("Unknown control operation");
      if (actionId) {
        s.actions ||= {};
        s.actions[actionId] = { op, at: (/* @__PURE__ */ new Date()).toISOString() };
      }
      await this.save(s);
      await this.cleanGarbage(s);
      return this.snapshot(s);
    });
  }
};

// src/receiver.mjs
var root = process.env.CODEX_DEBUG_DATA_DIR;
if (!root) throw Error("CODEX_DEBUG_DATA_DIR is required");
await mkdir(root, { recursive: true, mode: 448 });
var config = JSON.parse(await readFile2(join2(root, "receiver.json"), "utf8"));
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || typeof config.brokerToken !== "string" || config.brokerToken.length < 32) throw Error("Invalid receiver configuration");
var store = new SessionStore(root);
var lastActivity = Date.now();
var equal = (a, b) => {
  const x = Buffer.from(typeof a === "string" ? a : ""), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual2(x, y);
};
async function body(req, max) {
  let n = 0;
  const parts = [];
  for await (const p of req) {
    n += p.length;
    if (n > max) throw Error("Payload too large");
    parts.push(p);
  }
  const value = JSON.parse(Buffer.concat(parts).toString());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected object");
  return value;
}
var json = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};
var server = createServer(async (req, res) => {
  lastActivity = Date.now();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-debug-token,x-debug-broker-token");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  try {
    if (path === "/health" && req.method === "GET") {
      if (!equal(req.headers["x-debug-broker-token"], config.brokerToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      json(res, 200, { service: "debug-mode", ready: true, schemaVersion: 7 });
      return;
    }
    const control = /^\/control\/([0-9a-f-]{36})$/i.exec(path);
    if (control && req.method === "POST") {
      if (!equal(req.headers["x-debug-broker-token"], config.brokerToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      json(res, 200, await store.control(control[1], await body(req, 64 * 1024)));
      return;
    }
    const logs = /^\/logs\/([0-9a-f-]{36})$/i.exec(path);
    if (logs && req.method === "POST") {
      const value = await body(req, 16 * 1024);
      const record = await store.append(logs[1], value, req.headers["x-debug-token"]);
      json(res, 201, { accepted: true, id: record.id, round: record.round });
      return;
    }
    json(res, 404, { error: "Unknown endpoint" });
  } catch (e) {
    json(res, e.message.includes("token") ? 401 : e.message === "Payload too large" ? 413 : 409, { error: e.message });
  }
});
server.on("error", (e) => {
  process.send?.({ type: "error", code: e.code, message: e.message }, () => process.disconnect());
  process.exitCode = 1;
});
server.listen(config.port, "127.0.0.1", () => process.send?.({ type: "ready" }, () => process.disconnect()));
var timer = setInterval(() => {
  if (Date.now() - lastActivity > 12 * 36e5) {
    clearInterval(timer);
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  }
}, 6e4);
timer.unref();
