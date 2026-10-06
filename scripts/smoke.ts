// 冒烟测试：在 Node 中验证台账核心逻辑（需先 polyfill localStorage）
import assert from "node:assert";

const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

const { ledgerStore } = await import("../src/ledger/store");
const { mergeLedgers } = await import("../src/ledger/merge");
const { waxEligibility } = await import("../src/ledger/validity");
const { peerEditOrder, peerEditDamage, peerEditRepairMaterial, peerAddRepair } = await import("../src/ledger/peer");
const { migrate } = await import("../src/ledger/migrate");

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// 1. 初始种子
check("种子台账含 3 张工单、损伤点 DMG-0001、修补记录", () => {
  const s = ledgerStore.getState();
  assert.equal(Object.keys(s.orders).length, 3);
  assert.ok(s.damages["DMG-0001"]);
  const rep = Object.values(s.repairs).find((r) => r.damageId === "DMG-0001");
  assert.ok(rep);
  assert.ok(rep!.id.startsWith("REP-"));
});

// 2. 仅对端改品牌 → 自动合并，无冲突
check("对端单独改品牌 → 自动合并", () => {
  const before = ledgerStore.getState();
  const remote = peerEditOrder(before);
  const { conflicts, changedCount } = ledgerStore.mergeRemote(remote, "测试-对端改品牌");
  assert.equal(conflicts.length, 0);
  assert.ok(changedCount >= 1);
  assert.equal(ledgerStore.getState().orders["ORD-106"].boardBrand, "Burton 160W");
});

// 3. 两边改同一字段 → 冲突队列，各留一版
check("两边同字段改动 → 进冲突队列，各留一版", () => {
  const before = ledgerStore.getState();
  const remote = structuredClone(before);
  remote.deviceId = "tablet-B";
  remote.orders["ORD-106"].boardBrand = "对端品牌Z";
  remote.fieldMeta["order:ORD-106:boardBrand"] = { at: Date.now(), by: "tablet-B" };
  const local = structuredClone(before);
  local.orders["ORD-106"].boardBrand = "本地品牌X";
  const res = mergeLedgers(local, remote);
  assert.ok(res.conflicts.length >= 1);
  const cf = res.conflicts.find((c) => c.field === "boardBrand");
  assert.ok(cf);
  assert.equal(cf!.local, "本地品牌X");
  assert.equal(cf!.remote, "对端品牌Z");
});

// 4. 解决冲突：采用对端版
check("采用对端版解决冲突", () => {
  const before = ledgerStore.getState();
  const remote = structuredClone(before);
  remote.deviceId = "tablet-B";
  remote.orders["ORD-106"].boardBrand = "对端品牌W";
  remote.fieldMeta["order:ORD-106:boardBrand"] = { at: Date.now(), by: "tablet-B" };
  const local = structuredClone(before);
  local.orders["ORD-106"].boardBrand = "本地品牌Y";
  const res = mergeLedgers(local, remote);
  const store = ledgerStore as any;
  const orig = store.state;
  store.state = local;
  store.state.conflicts = res.conflicts;
  const cf = res.conflicts.find((c) => c.field === "boardBrand")!;
  store.resolveConflict(cf.id, "remote");
  assert.equal(store.state.orders["ORD-106"].boardBrand, "对端品牌W");
  store.state = orig;
});

// 5. 损伤点改动 → 已确认修补立即作废
check("损伤点位置改动 → 已确认修补作废", () => {
  const repId = Object.values(ledgerStore.getState().repairs).find((r) => r.damageId === "DMG-0001")!.id;
  // 先确认修补
  ledgerStore.confirmRepair(repId, true);
  assert.equal(ledgerStore.getState().repairs[repId].confirmed, true);
  // 对端改损伤位置
  const before = ledgerStore.getState();
  const remote = peerEditDamage(before);
  ledgerStore.mergeRemote(remote, "测试-改损伤位置");
  const rep = ledgerStore.getState().repairs[repId];
  assert.equal(rep.confirmed, false);
  assert.equal(rep.invalid, true);
  assert.ok(rep.invalidReason);
});

// 6. 打蜡资格作废
check("修补作废后打蜡资格立即不合格", () => {
  const elig = waxEligibility(ledgerStore.getState(), "ORD-112");
  assert.equal(elig.eligible, false);
  assert.ok(elig.reason.includes("DMG-0001"));
});

// 7. 修补材料改动 → 作废
check("修补材料改动 → 已确认修补作废", () => {
  const repId = Object.values(ledgerStore.getState().repairs).find((r) => r.damageId === "DMG-0001")!.id;
  ledgerStore.confirmRepair(repId, true);
  const before = ledgerStore.getState();
  const remote = peerEditRepairMaterial(before);
  ledgerStore.mergeRemote(remote, "测试-改材料");
  const rep = ledgerStore.getState().repairs[repId];
  assert.equal(rep.invalid, true);
  assert.ok(rep.invalidReason?.includes("材料"));
});

// 8. 写盘失败 → outbox 留住批次
check("写盘失败 → 批次留在 outbox，重试成功后清空", async () => {
  ledgerStore.setFaultInjection(true);
  const before = ledgerStore.getState();
  const remote = peerAddRepair(before);
  ledgerStore.mergeRemote(remote, "测试-写盘失败");
  assert.ok(ledgerStore.getState().outbox.length >= 1);
  ledgerStore.setFaultInjection(false);
  await ledgerStore.retryAll();
  assert.equal(ledgerStore.getState().outbox.length, 0);
});

// 9. 旧数据迁移：字符串数组 records → 补编号补版本
check("旧数据升级：records 数组补编号、补版本、补字段时间戳", () => {
  const legacy = {
    records: [
      ["ORD-901", "旧雪板", "侧刃88°", "已打低温蜡"],
      ["ORD-902", "旧竞速板", "底板划痕10cm", "待补P-Tex"],
    ],
  };
  const ledger = migrate(legacy);
  assert.ok(ledger.orders["ORD-901"]);
  assert.equal(ledger.orders["ORD-901"].version, 1);
  assert.ok(ledger.fieldMeta["order:ORD-901:boardBrand"]);
  assert.ok(ledger.damages["DMG-0001"]);
  assert.equal(ledger.damages["DMG-0001"].version, 1);
  const legacyRep = Object.values(ledger.repairs).find((r) => r.damageId === "DMG-0001");
  assert.ok(legacyRep);
  assert.ok(legacyRep!.id.startsWith("REP-"));
});

// 10. 稳定编号：损伤点改动后编号不变
check("损伤点改动后编号 DMG-0001 保持稳定", () => {
  const before = ledgerStore.getState();
  const dmg = before.damages["DMG-0001"];
  const updated = { ...dmg, location: "全新位置" };
  ledgerStore.upsertDamage(updated);
  assert.ok(ledgerStore.getState().damages["DMG-0001"]);
  assert.equal(ledgerStore.getState().damages["DMG-0001"].location, "全新位置");
});

console.log(`\n全部 ${passed} 项冒烟测试通过`);
