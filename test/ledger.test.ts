/* 台账引擎端到端测试（Node + 内存 localStorage 桩，esbuild 打包后运行） */
import { applyChangeset, createEmptyDoc, waxEligibility } from "../src/ledger/merge";
import { migrate } from "../src/ledger/migrate";
import {
  Changeset,
  Damage,
  DamageFieldKey,
  FieldKey,
  LedgerDoc,
  Repair,
  RepairFieldKey,
} from "../src/ledger/types";
import {
  STORAGE_KEYS,
  commitChangeset,
  flushQueue,
  getDevice,
  loadDoc,
  readQueue,
  resetAll,
  setSimulateFail,
} from "../src/ledger/storage";

let passed = 0;
let failed = 0;
function ok(cond: unknown, name: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}
function eq<T>(a: T, b: T, name: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

let csSeq = 0;
function cs(device: string, ops: Changeset["ops"], at = Date.now()): Changeset {
  csSeq++;
  return {
    id: `test-cs-${csSeq}`,
    deviceId: "id-" + device,
    deviceName: device,
    at,
    ops,
  };
}

function addOrder(device: string, fields: Partial<Record<FieldKey, string>>) {
  return cs(device, [{ kind: "addOrder", localId: `tmp-order-${csSeq}`, fields }]);
}

/* ---------- 内存 localStorage 桩 ---------- */
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => {
    if (mem.get("__fail__") === "1") throw new Error("QuotaExceeded");
    mem.set(k, String(v));
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};
(globalThis as any).window = {
  addEventListener: () => {},
  setInterval: () => 0,
};
// 让 storage 的模拟失败开关使用同一存储
mem.delete("__fail__");

/* ================================================================ */

console.log("1) 稳定编号：工单/损伤/修补编号不随重开变化，修补关联真实损伤点");
{
  let doc = createEmptyDoc();
  const a = applyChangeset(doc, addOrder("平板A", { orderNo: "ORD-201", brand: "Rossi" }));
  const orderId = a.orderIds[Object.keys(a.orderIds)[0]];
  const dmgCs = cs("平板A", [
    { kind: "addDamage", orderId, localId: "td1", data: { kind: "划痕", position: "距板头70cm", sizeCm: "12", note: "", status: "待修补" } },
  ]);
  const dmgRes = applyChangeset(doc, dmgCs);
  const damageId = dmgRes.damageIds["td1"];
  eq(damageId, "D-001", "首张工单首个损伤点为 D-001");

  const repCs = cs("平板A", [
    { kind: "addRepair", orderId, localId: "tr1", damageLocalId: damageId, data: { material: "P-Tex 黑色", confirmed: "否" } },
  ]);
  const repRes = applyChangeset(doc, repCs);
  const repairId = repRes.repairIds["tr1"];
  eq(repairId, "R-001", "首张工单首个修补为 R-001");
  eq(doc.orders[orderId].repairs[0].damageId, "D-001", "修补记录关联到真实损伤点 D-001");

  // 再来一张工单，序列独立递增
  const b = applyChangeset(doc, addOrder("平板A", { orderNo: "ORD-202" }));
  const orderId2 = b.orderIds[Object.keys(b.orderIds)[0]];
  eq(orderId2, "ORD-002", "第二张工单为 ORD-002");
  const d2 = applyChangeset(doc, cs("平板A", [{ kind: "addDamage", orderId: orderId2, localId: "td2", data: { kind: "烧板", position: "板尾", sizeCm: "2", note: "", status: "待修补" } }]));
  eq(d2.damageIds["td2"], "D-001", "第二张工单的损伤点编号独立从 D-001 起");
}

console.log("2) 按字段合并：各改不同字段互不覆盖");
{
  const doc = createEmptyDoc();
  const r = applyChangeset(doc, addOrder("平板A", { orderNo: "ORD-301", brand: "Burton", waxType: "" }));
  const oid = r.orderIds[Object.keys(r.orderIds)[0]];

  // 基线：A、B 都看到 brand=Burton, waxType=""
  const a = cs("平板A", [
    { kind: "setField", orderId: oid, field: "brand", value: "Burton Custom", base: "Burton" },
  ]);
  applyChangeset(doc, a);
  const b = cs("平板B", [
    { kind: "setField", orderId: oid, field: "waxType", value: "低温蜡", base: "" },
  ]);
  const res = applyChangeset(doc, b);
  eq(doc.orders[oid].fields.brand.value, "Burton Custom", "A 的 brand 修改保留");
  eq(doc.orders[oid].fields.waxType.value, "低温蜡", "B 的 waxType 修改合并成功");
  ok(res.conflicts.length === 0, "不同字段无冲突");
}

console.log("3) 同字段双方都改：各留一版待确认，现值不被覆盖");
{
  const doc = createEmptyDoc();
  const r = applyChangeset(doc, addOrder("平板A", { orderNo: "ORD-302", waxType: "全温蜡" }));
  const oid = r.orderIds[Object.keys(r.orderIds)[0]];

  applyChangeset(doc, cs("平板A", [
    { kind: "setField", orderId: oid, field: "waxType", value: "低温蜡", base: "全温蜡" },
  ], 1000));
  const resB = applyChangeset(doc, cs("平板B", [
    { kind: "setField", orderId: oid, field: "waxType", value: "高温蜡", base: "全温蜡" },
  ], 2000));

  const t = doc.orders[oid].fields.waxType;
  eq(t.value, "低温蜡", "现值保留先写入方 A 的值");
  ok(!!t.conflict, "字段进入冲突状态");
  eq(t.conflict!.candidates.map((c) => c.value), ["低温蜡", "高温蜡"], "双方版本各留一版");
  ok(resB.conflicts.length === 1, "ApplyResult 报告 1 处冲突");

  // B 仲裁选自己的版本
  applyChangeset(doc, cs("平板B", [
    { kind: "resolveField", orderId: oid, field: "waxType", value: "高温蜡" },
  ], 3000));
  eq(doc.orders[oid].fields.waxType.value, "高温蜡", "仲裁后值更新");
  eq(doc.orders[oid].fields.waxType.conflict!.resolvedValue, "高温蜡", "仲裁结论留痕");
}

console.log("4) 幂等：同一批次重放不产生重复修改");
{
  const doc = createEmptyDoc();
  const r = applyChangeset(doc, addOrder("平板A", { orderNo: "ORD-303" }));
  const oid = r.orderIds[Object.keys(r.orderIds)[0]];
  const c = cs("平板A", [{ kind: "setField", orderId: oid, field: "brand", value: "X", base: "" }]);
  const revBefore = doc.rev;
  applyChangeset(doc, c);
  const revAfter = doc.rev;
  const again = applyChangeset(doc, c);
  ok(!again.applied, "重复批次不再应用");
  eq(doc.rev, revAfter, "修订号不重复递增");
  ok(revAfter === revBefore + 1, "修订号只涨一次");
}

console.log("5) 损伤点改动 → 已确认修补立即作废，打蜡资格重算");
{
  const doc = createEmptyDoc();
  const r = applyChangeset(doc, addOrder("平板A", { orderNo: "ORD-401" }));
  const oid = r.orderIds[Object.keys(r.orderIds)[0]];
  const d = applyChangeset(doc, cs("平板A", [
    { kind: "addDamage", orderId: oid, localId: "d", data: { kind: "划痕", position: "板头", sizeCm: "3", note: "", status: "已修补" } },
  ]));
  const did = d.damageIds["d"];
  applyChangeset(doc, cs("平板A", [
    { kind: "addRepair", orderId: oid, localId: "rp", damageLocalId: did, data: { material: "P-Tex", confirmed: "是" } },
  ]));
  const order = doc.orders[oid];
  ok(waxEligibility(order).eligible, "全部修补已确认 → 具备打蜡资格");

  // B 修改损伤点尺寸（base 与现值一致时不会触发；这里模拟真实改动）
  const res = applyChangeset(doc, cs("平板B", [
    { kind: "setDamageField", orderId: oid, damageId: did, field: "sizeCm", value: "5", base: "3" },
  ]));
  const repair = doc.orders[oid].repairs[0];
  eq(repair.confirmed.value, "否", "损伤点改动后确认状态立即作废");
  ok(/已作废/.test(repair.confirmNote.value), "confirmNote 写明作废原因");
  ok(res.invalidatedRepairs.length === 1, "报告 1 条修补作废");
  ok(!waxEligibility(doc.orders[oid]).eligible, "打蜡资格立即变为不可用");
  const wax = waxEligibility(doc.orders[oid]);
  ok(wax.reasons.some((x) => /未确认/.test(x)), "打蜡原因列出未确认修补");

  // 重新确认后恢复资格
  applyChangeset(doc, cs("平板A", [
    { kind: "setRepairField", orderId: oid, repairId: repair.id, field: "confirmed", value: "是", base: "否" },
  ]));
  ok(waxEligibility(doc.orders[oid]).eligible, "重新确认后打蜡资格恢复");
}

console.log("6) 修补材料改动 → 确认作废（方式/技师改动不影响确认）");
{
  const doc = createEmptyDoc();
  const r = applyChangeset(doc, addOrder("平板A", { orderNo: "ORD-402" }));
  const oid = r.orderIds[Object.keys(r.orderIds)[0]];
  const d = applyChangeset(doc, cs("平板A", [
    { kind: "addDamage", orderId: oid, localId: "d", data: { kind: "划痕", position: "中部", sizeCm: "2", note: "", status: "已修补" } },
  ]));
  const did = d.damageIds["d"];
  applyChangeset(doc, cs("平板A", [
    { kind: "addRepair", orderId: oid, localId: "rp", damageLocalId: did, data: { material: "P-Tex 透明", technician: "李", confirmed: "是" } },
  ]));
  const rid = doc.orders[oid].repairs[0].id;

  applyChangeset(doc, cs("平板B", [
    { kind: "setRepairField", orderId: oid, repairId: rid, field: "technician", value: "赵", base: "李" },
  ]));
  eq(doc.orders[oid].repairs[0].confirmed.value, "是", "改技师不影响确认");

  const res = applyChangeset(doc, cs("平板B", [
    { kind: "setRepairField", orderId: oid, repairId: rid, field: "material", value: "P-Tex 黑色", base: "P-Tex 透明" },
  ]));
  eq(doc.orders[oid].repairs[0].confirmed.value, "否", "改材料后确认立即作废");
  ok(res.invalidatedRepairs.length === 1, "材料改动报告作废 1 条");
}

console.log("7) 同批次新增损伤点 + 修补关联（临时编号重映射）");
{
  const doc = createEmptyDoc();
  const localOrder = "tmp:o1";
  const res = applyChangeset(doc, cs("平板A", [
    { kind: "addOrder", localId: localOrder, fields: { orderNo: "ORD-501" } },
    { kind: "addDamage", orderId: localOrder, localId: "tmp:d1", data: { kind: "凹伤", position: "板尾右侧", sizeCm: "1", note: "", status: "待修补" } },
    { kind: "addRepair", orderId: localOrder, localId: "tmp:r1", damageLocalId: "tmp:d1", data: { material: "环氧胶" } },
  ]));
  const oid = res.orderIds[localOrder];
  eq(doc.orders[oid].repairs[0].damageId, "D-001", "临时损伤编号被重映射为真实 D-001");
}

console.log("8) 写盘失败：批次留在未提交队列，恢复后重试补齐");
{
  resetAll();
  // 初始播种
  const loaded = loadDoc();
  ok(Object.keys(loaded.doc.orders).length === 3, "首次打开播种 3 张示例工单");

  setSimulateFail(true);
  const device = getDevice();
  const outcome = commitChangeset({
    id: "fail-cs-1",
    deviceId: device.id,
    deviceName: device.name,
    at: Date.now(),
    ops: [{ kind: "addOrder", localId: "tmp:fail-order", fields: { orderNo: "ORD-FAIL" } }],
  });
  ok(!!outcome.error, "写盘失败返回错误信息");
  eq(readQueue().length, 1, "失败批次完整保留在未提交队列");
  const rawDoc = JSON.parse(localStorage.getItem(STORAGE_KEYS.DOC_KEY) || "{}");
  ok(!Object.values(rawDoc.orders ?? {}).some((o: any) => o.fields?.orderNo?.value === "ORD-FAIL"),
    "失败期间主台账落盘内容不含该工单（仅进入未提交队列）");

  setSimulateFail(false);
  const flushed = flushQueue();
  ok("flushed" in flushed && flushed.flushed === 1, "恢复后重试成功应用 1 个批次");
  eq(readQueue().length, 0, "成功后队列清空");
  const reloaded = loadDoc();
  ok(Object.values(reloaded.doc.orders).some((o) => o.fields.orderNo.value === "ORD-FAIL"),
    "重试后工单补齐落盘");
  ok(reloaded.doc.applied["fail-cs-1"] === true, "批次号登记，保证不重复");
}

console.log("9) 旧数据升级：补齐编号/版本，原位置可查，修补按位置关联");
{
  const legacy = {
    version: 1,
    orders: [
      {
        orderNo: "ORD-106",
        brand: "Burton",
        length: "156",
        edge: "侧刃88°，底刃1°",
        wax: "低温蜡",
        baseDamage: "底板划痕12cm，距板头70cm左侧",
        repairs: [{ position: "距板头70cm", material: "P-Tex" }],
      },
      {
        orderNo: "ORD-107",
        baseDamage: "板尾烧板2cm",
        repairs: "待补P-Tex",
      },
    ],
  };
  const { doc, migrated } = migrate(legacy);
  ok(migrated, "识别为旧数据并执行升级");
  eq(doc.version, 2, "版本升级到 v2");
  const ids = Object.keys(doc.orders);
  eq(ids[0], "ORD-001", "补发工单稳定编号");
  const o1 = doc.orders["ORD-001"];
  eq(o1.damages[0].id, "D-001", "补发损伤点编号 D-001");
  eq(o1.damages[0].legacyPosition, "底板划痕12cm，距板头70cm左侧", "原损伤文字位置保留可查");
  eq(o1.damages[0].sizeCm.value, "12", "从旧文本提取尺寸");
  eq(o1.fields.edgeSideDeg.value, "88", "从旧刃角文本提取侧刃角");
  eq(o1.fields.edgeBaseDeg.value, "1", "从旧刃角文本提取底刃角");
  eq(o1.repairs[0].id, "R-001", "补发修补编号 R-001");
  eq(o1.repairs[0].damageId, "D-001", "旧修补按文字位置关联到真实损伤点");
  eq(o1.repairs[0].confirmed.value, "否", "迁移的修补需重新确认");

  const o2 = doc.orders["ORD-002"];
  eq(o2.repairs[0].damageId, "D-001", "第二张工单的修补关联到本单 D-001");
  eq(o2.repairs[0].confirmNote.value, "旧台账原文：待补P-Tex", "纯文本旧修补保留原文");

  // 升级后再走 storage 落盘、重载，结构完整
  ok(!waxEligibility(o1).eligible, "升级后因修补未确认，打蜡资格为否");
}

console.log("10) 旧修补位置匹配不上时不臆造关联，但原文照旧可查");
{
  const legacy = {
    version: 1,
    orders: [
      {
        orderNo: "ORD-108",
        baseDamage: "板头小划痕",
        repairs: [{ position: "一个完全对不上的远位置描述", material: "焊补条" }],
      },
    ],
  };
  const { doc } = migrate(legacy);
  const o = doc.orders["ORD-001"];
  eq(o.repairs[0].damageId, "", "匹配不上时 damageId 留空");
  eq(o.repairs[0].legacyPosition, "一个完全对不上的远位置描述", "原修复位置仍可查");
  const wax = waxEligibility(o);
  ok(wax.reasons.some((r) => /未关联损伤点/.test(r)), "打蜡资格中提示未关联修补");
}

console.log("11) 交叉场景：A 改品牌、B 改同一损伤点的位置与另一个损伤点的材料");
{
  const doc = createEmptyDoc();
  const r = applyChangeset(doc, addOrder("平板A", {
    orderNo: "ORD-601", brand: "旧品牌",
  }));
  const oid = r.orderIds[Object.keys(r.orderIds)[0]];
  applyChangeset(doc, cs("平板A", [
    { kind: "addDamage", orderId: oid, localId: "d1", data: { kind: "划痕", position: "位置一", sizeCm: "2", note: "", status: "已修补" } },
    { kind: "addDamage", orderId: oid, localId: "d2", data: { kind: "划痕", position: "位置二", sizeCm: "4", note: "", status: "已修补" } },
  ]));
  const [d1, d2] = doc.orders[oid].damages.map((x: Damage) => x.id);
  applyChangeset(doc, cs("平板A", [
    { kind: "addRepair", orderId: oid, localId: "r1", damageLocalId: d1, data: { material: "M1", confirmed: "是" } },
    { kind: "addRepair", orderId: oid, localId: "r2", damageLocalId: d2, data: { material: "M2", confirmed: "是" } },
  ]));

  // B 基于同一基线做三处不同修改
  const res = applyChangeset(doc, cs("平板B", [
    { kind: "setField", orderId: oid, field: "brand", value: "新品牌", base: "旧品牌" },
    { kind: "setDamageField", orderId: oid, damageId: d1, field: "position", value: "位置一(修正)", base: "位置一" },
    { kind: "setRepairField", orderId: oid, repairId: doc.orders[oid].repairs[1].id, field: "material", value: "M2-new", base: "M2" },
  ]));
  const o = doc.orders[oid];
  eq(o.fields.brand.value, "新品牌", "品牌字段合并");
  eq(o.damages[0].position.value, "位置一(修正)", "损伤位置合并");
  eq(o.repairs[0].confirmed.value, "否", "位置一的已确认修补因损伤点改动作废");
  eq(o.repairs[1].confirmed.value, "否", "位置二的已确认修补因材料改动作废");
  ok(res.invalidatedRepairs.length === 2, "两条作废都被报告");
  ok(!waxEligibility(o).eligible, "打蜡资格整体重算为否");
}

/* ---------- 汇总在文件末尾 ---------- */

console.log("12) 端到端：两台平板基于各自存储副本交替保存，全程不丢改动");
{
  resetAll();
  setSimulateFail(false);
  const devA = { id: "A-id", name: "平板A" };
  const devB = { id: "B-id", name: "平板B" };
  const make = (device: { id: string; name: string }, ops: Changeset["ops"]): Changeset =>
    ({ id: `e2e-${Math.random().toString(36).slice(2)}`, deviceId: device.id, deviceName: device.name, at: Date.now() + Math.floor(Math.random()*1000), ops });

  // A 新建工单+损伤点+已确认修补
  const oa = make(devA, [
    { kind: "addOrder", localId: "t1", fields: { orderNo: "ORD-E2E", brand: "BrandX", status: "维护中" } },
    { kind: "addDamage", orderId: "t1", localId: "d1", data: { kind: "划痕", position: "左刃中段", sizeCm: "6", note: "", status: "已修补" } },
    { kind: "addRepair", orderId: "t1", localId: "r1", damageLocalId: "d1", data: { material: "P-Tex 透明", technician: "A技师", confirmed: "是" } },
  ]);
  const ra = commitChangeset(oa);
  ok(ra.ok ?? true, "A 首单提交成功");
  const oid = ra.result!.orderIds["t1"];

  // B 在自己的页面已经能看到（同存储）；B 修改材料，A 同时修改品牌 —— 不同字段
  const rb = commitChangeset(make(devB, [
    { kind: "setRepairField", orderId: oid, repairId: "R-001", field: "material", value: "P-Tex 黑色", base: "P-Tex 透明" },
  ]));
  const rc = commitChangeset(make(devA, [
    { kind: "setField", orderId: oid, field: "brand", value: "BrandX Pro", base: "BrandX" },
  ]));
  const doc = rc.doc;
  const order = doc.orders[oid];
  eq(order.fields.brand.value, "BrandX Pro", "A 的品牌改动在");
  eq(order.repairs[0].material.value, "P-Tex 黑色", "B 的材料改动在");
  eq(order.repairs[0].confirmed.value, "否", "B 改材料导致 A 已确认修补作废（双方都能看到）");
  ok(!waxEligibility(order).eligible, "打蜡资格重算为否");

  // 双方又同时把 technician 改成不同的人 → 冲突各留一版
  const rd = commitChangeset(make(devA, [
    { kind: "setRepairField", orderId: oid, repairId: "R-001", field: "technician", value: "钱技师", base: "A技师" },
  ]));
  const re2 = commitChangeset(make(devB, [
    { kind: "setRepairField", orderId: oid, repairId: "R-001", field: "technician", value: "孙技师", base: "A技师" },
  ]));
  ok(re2.result!.conflicts.length === 1, "第二个保存方报告技师字段冲突");
  const t = re2.doc.orders[oid].repairs[0].technician;
  eq(t.conflict!.candidates.length, 2, "两个版本都保留");

  // B 仲裁
  const rf = commitChangeset(make(devB, [
    { kind: "resolveRepairField", orderId: oid, repairId: "R-001", field: "technician", value: "孙技师" },
  ]));
  eq(rf.doc.orders[oid].repairs[0].technician.value, "孙技师", "仲裁生效");

  // 最终落盘文档里数据完整
  const finalDoc = loadDoc().doc;
  const finalOrder = finalDoc.orders[oid];
  eq(finalOrder.fields.brand.value, "BrandX Pro", "重载后品牌仍在");
  eq(finalOrder.damages[0].id, "D-001", "损伤点稳定编号不变");
  eq(finalOrder.repairs[0].damageId, "D-001", "修补始终关联真实损伤点");
  eq(finalOrder.repairs[0].material.value, "P-Tex 黑色", "重载后材料为 B 的版本");
  eq(readQueue().length, 0, "队列全部清空");
}

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
