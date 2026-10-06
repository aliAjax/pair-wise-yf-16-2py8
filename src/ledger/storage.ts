import { applyAll, createEmptyDoc } from "./merge";
import { ensureShape, migrate } from "./migrate";
import { seedDoc } from "./seed";
import { ApplyResult, Changeset, LedgerDoc } from "./types";

const DOC_KEY = "ski-shop-ledger:v2";
const QUEUE_KEY = "ski-shop-ledger:queue:v2";
const DEVICE_KEY = "ski-shop-ledger:device";
const FAIL_FLAG_KEY = "ski-shop-ledger:simulate-fail";

export const STORAGE_KEYS = { DOC_KEY, QUEUE_KEY, DEVICE_KEY, FAIL_FLAG_KEY };

/* ---------------- 设备身份 ---------------- */

export interface DeviceIdentity {
  id: string;
  name: string;
}

export function getDevice(): DeviceIdentity {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DeviceIdentity;
      if (parsed.id && parsed.name) return parsed;
    }
  } catch {
    /* 损坏则重发 */
  }
  const id = "dev-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
  const name = "平板" + Math.floor(10 + Math.random() * 90);
  const device = { id, name };
  try {
    safeSet(DEVICE_KEY, JSON.stringify(device));
  } catch {
    /* 存储暂时不可用时，仅本次会话使用该身份 */
  }
  return device;
}

export function setDeviceName(name: string): DeviceIdentity {
  const device = getDevice();
  const next = { ...device, name: name.trim() || device.name };
  try {
    safeSet(DEVICE_KEY, JSON.stringify(next));
  } catch {
    /* 改名仅内存生效，待存储恢复 */
  }
  return next;
}

/* ---------------- 底层安全读写 ---------------- */

function safeSet(key: string, value: string): void {
  // 测试开关：模拟主台账写盘失败（配额/隐私模式/IO 异常）。
  // 未提交队列是失败时的最后防线，不能被这个开关挡住。
  if (key === DOC_KEY && localStorage.getItem(FAIL_FLAG_KEY) === "1") {
    throw new Error("模拟写盘失败（主台账存储不可用）");
  }
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    // 真配额超限时，队列写入做最后的瘦身重试（旧批次已进过文档，丢日志不丢数据）
    if (key === QUEUE_KEY) {
      try {
        const compact = JSON.parse(value) as Changeset[];
        localStorage.setItem(QUEUE_KEY, JSON.stringify(compact.slice(-5)));
        return;
      } catch {
        /* 彻底不可用则上抛，由调用方保留内存批次 */
      }
    }
    throw e;
  }
}

export function setSimulateFail(on: boolean): void {
  if (on) localStorage.setItem(FAIL_FLAG_KEY, "1");
  else localStorage.removeItem(FAIL_FLAG_KEY);
}
export function isSimulatingFail(): boolean {
  return localStorage.getItem(FAIL_FLAG_KEY) === "1";
}

/* ---------------- 未提交批次队列 ---------------- */

export function readQueue(): Changeset[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Changeset[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(list: Changeset[]): void {
  safeSet(QUEUE_KEY, JSON.stringify(list));
  notifyQueueListeners();
}

export function enqueue(cs: Changeset): void {
  const list = readQueue();
  list.push(cs);
  writeQueue(list);
}

/** 出队时按 id 移除（应用成功后调用） */
function dropApplied(ids: string[]): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  const list = readQueue().filter((c) => !set.has(c.id));
  writeQueue(list);
}

/* ---------------- 文档加载 ---------------- */

export interface LoadedDoc {
  doc: LedgerDoc;
  /** 加载时发现并应用的遗留未提交批次 */
  replayed: ApplyResult[];
  upgraded: boolean;
  firstRun: boolean;
}

function parseDoc(raw: string | null): { doc: LedgerDoc; upgraded: boolean } {
  if (!raw) return { doc: createEmptyDoc(), upgraded: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 主台账损坏：隔离备份，避免覆盖现场，空台账起步（队列仍会重放）
    const backup = `${DOC_KEY}:corrupt:${Date.now()}`;
    try {
      localStorage.setItem(backup, raw);
    } catch {
      /* 连备份都写不了也只能放弃 */
    }
    return { doc: createEmptyDoc(), upgraded: false };
  }
  const { doc, migrated } = migrate(parsed);
  return { doc: ensureShape(doc), upgraded: migrated };
}

/**
 * 加载台账：读主文档 → 升级/补齐 → 重放未提交批次 → 尝试落盘。
 * 重放或落盘失败都不抛错（队列保留，等待重试）。
 */
export function loadDoc(): LoadedDoc {
  const firstRun = localStorage.getItem(DOC_KEY) === null;
  const { doc, upgraded } = firstRun
    ? { doc: seedDoc(), upgraded: false }
    : parseDoc(localStorage.getItem(DOC_KEY));
  const queue = readQueue().filter((cs) => !doc.applied[cs.id]);
  let replayed: ApplyResult[] = [];
  if (queue.length > 0) {
    replayed = applyAll(doc, queue);
    const okIds = queue.filter((cs) => doc.applied[cs.id]).map((cs) => cs.id);
    if (okIds.length > 0) {
      try {
        persist(doc);
        dropApplied(okIds);
      } catch {
        /* 写不进去就留队列，等恢复后 flushQueue 重试 */
      }
    }
  } else if (upgraded || firstRun) {
    try {
      persist(doc);
    } catch {
      /* 忽略 */
    }
  }
  return { doc, replayed, upgraded, firstRun };
}

/** 直接落盘（不含队列重放） */
export function persist(doc: LedgerDoc): void {
  safeSet(DOC_KEY, JSON.stringify(doc));
}

/* ---------------- 提交：写盘失败后留住未提交批次并重试 ---------------- */

export interface CommitOutcome {
  doc: LedgerDoc;
  result: ApplyResult | null;
  queued: boolean;
  error?: string;
}

/**
 * 提交一个批次：
 * 1) 先把批次写入未提交队列（这一步若也失败，直接把批次留在内存交给调用方提示）；
 * 2) 读最新文档（尊重对端平板刚落盘的内容）→ 应用批次 → 落盘；
 * 3) 成功则从队列移除；失败则批次留在队列中，等待自动/手动重试。
 */
export function commitChangeset(cs: Changeset): CommitOutcome {
  const queue = readQueue();
  if (!queue.some((c) => c.id === cs.id)) {
    queue.push(cs);
    try {
      writeQueue(queue);
    } catch (e) {
      return {
        doc: loadDoc().doc,
        result: null,
        queued: false,
        error: `批次未能保存到未提交队列：${(e as Error).message}，批次保留在本机内存中`,
      };
    }
  }

  try {
    const { doc } = parseDoc(localStorage.getItem(DOC_KEY));
    // 先重放队列里更早的未提交批次，保证顺序
    const pending = readQueue().slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const results = applyAll(doc, pending);
    // 主文档落盘成功后才能出队；persist 抛错时队列原样保留
    persist(doc);
    const appliedIds = pending.filter((c) => doc.applied[c.id]).map((c) => c.id);
    if (appliedIds.length > 0) dropApplied(appliedIds);
    const idx = pending.findIndex((c) => c.id === cs.id);
    return { doc, result: results[idx] ?? null, queued: false };
  } catch (e) {
    return {
      doc: loadDoc().doc,
      result: null,
      queued: true,
      error: `写盘失败，批次已留在未提交队列：${(e as Error).message}`,
    };
  }
}

/**
 * 重试队列：对“写盘恢复后”把滞留批次重新落盘。
 * @returns 成功应用的批次数量；失败时返回 -1 且队列原样保留。
 */
export function flushQueue(): { flushed: number; doc: LedgerDoc } | { error: string; doc: LedgerDoc } {
  const pending = readQueue();
  if (pending.length === 0) return { flushed: 0, doc: loadDoc().doc };
  try {
    const { doc } = parseDoc(localStorage.getItem(DOC_KEY));
    applyAll(doc, pending);
    persist(doc);
    dropApplied(pending.map((c) => c.id));
    return { flushed: pending.length, doc };
  } catch (e) {
    return { error: (e as Error).message, doc: loadDoc().doc };
  }
}

/* ---------------- 跨标签页（两台平板）同步 ---------------- */

type Listener = (doc: LedgerDoc, meta: { source: "storage" | "local" }) => void;
type QueueListener = (queue: Changeset[]) => void;

const listeners = new Set<Listener>();
const queueListeners = new Set<QueueListener>();
let installed = false;

function notifyDocListeners(doc: LedgerDoc, source: "storage" | "local") {
  for (const l of listeners) l(doc, { source });
}
function notifyQueueListeners() {
  const q = readQueue();
  for (const l of queueListeners) l(q);
}

export function subscribeLedger(listener: Listener): () => void {
  listeners.add(listener);
  ensureStorageListener();
  return () => listeners.delete(listener);
}
export function subscribeQueue(listener: QueueListener): () => void {
  queueListeners.add(listener);
  ensureStorageListener();
  return () => queueListeners.delete(listener);
}

function ensureStorageListener() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("storage", (e) => {
    if (e.key === DOC_KEY || e.key === null) {
      const { doc } = parseDoc(e.newValue);
      notifyDocListeners(ensureShape(doc), "storage");
    }
    if (e.key === QUEUE_KEY || e.key === null) {
      notifyQueueListeners();
    }
  });
  // 写盘失败恢复后自动重试：在线事件 + 每 15 秒巡检滞留队列
  window.addEventListener?.("online", () => {
    if (readQueue().length > 0) flushQueue();
  });
  const timer = window.setInterval(() => {
    if (readQueue().length > 0 && !isSimulatingFail()) {
      const r = flushQueue();
      if ("flushed" in r && r.flushed > 0) {
        notifyDocListeners(r.doc, "local");
      }
    }
  }, 15000);
  // 测试环境下不保留定时器引用也无妨
  void timer;
}

/** 本机成功提交后主动通知本标签页 UI */
export function notifyLocal(doc: LedgerDoc) {
  notifyDocListeners(doc, "local");
}

/* ---------------- 调试 / 重置 ---------------- */

/** 载入一份 v1 旧格式台账到主存储键，下次 loadDoc 时自动升级（演示/验收用） */
export function loadLegacySample(): unknown {
  const legacy = {
    version: 1,
    orders: [
      {
        orderNo: "OLD-01",
        brand: "旧板牌 160",
        length: "160",
        type: "全地域",
        edge: "侧刃87°，底刃1°",
        wax: "高温蜡",
        status: "维护中",
        customer: "老客户刘",
        baseDamage: "底板划痕12cm，距板头70cm左侧；板尾烧板2cm",
        repairs: [
          { position: "距板头70cm", material: "P-Tex 黑色", method: "热熔填补" },
        ],
      },
      {
        orderNo: "OLD-02",
        brand: "旧公园板 152",
        baseDamage: "固定器间浅划痕3cm",
        repairs: "待补P-Tex",
      },
    ],
  };
  localStorage.removeItem(QUEUE_KEY);
  localStorage.setItem(DOC_KEY, JSON.stringify(legacy));
  return legacy;
}

export function resetAll(): void {
  localStorage.removeItem(DOC_KEY);
  localStorage.removeItem(QUEUE_KEY);
  localStorage.removeItem(FAIL_FLAG_KEY);
}
