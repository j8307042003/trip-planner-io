'use strict';

// ===========================================================================
// 三方合併：base（上次同步的版本）、local（本機）、remote（遠端最新版本）。
// 天數、區塊、地點、分類都有固定的 id，逐筆比對：
//   - 只有一邊改的直接採用；一邊新增或刪除的照做
//   - 兩邊把同一個欄位改成不同的值，或一邊刪除、另一邊有修改，才算衝突
//   - 清單順序：只有一邊調整過順序時採用那一邊，都調整過時以遠端為準，再補上另一邊新增的項目
// 衝突預設保留本機；choices = { [衝突的 key]: 'local' | 'remote' } 可指定保留哪一邊。
// 只處理資料，不碰 DOM；畫面在 remote.js。
// ===========================================================================

// 各種資料的結構：lists = 有 id 的清單、objects = 有 id 的單一物件、fields = 一般欄位（顯示名稱）
// groups = 視為一個整體比較的欄位（例如地點的座標與 Google 資料要一起換）、skip = 只影響畫面的欄位（沿用本機）
const MERGE_SCHEMA = {
  state: {
    lists: { days: 'day' },
    objects: {},
    nested: { library: 'library' },
    fields: { title: '旅程名稱', startDate: '出發日', showAll: '在地圖上顯示全部天數' },
    skip: ['version', 'mode', 'activeDayId', 'activeSectionId', 'dayOpen', 'local'],
  },
  library: { lists: { collections: 'collection' }, skip: ['activeCollectionId'] },
  day: { lists: { sections: 'section' }, fields: { name: '名稱', title: '主題' } },
  section: { lists: { places: 'place' }, objects: { center: 'place' }, fields: { name: '名稱', time: '時間', note: '備註' } },
  collection: { lists: { places: 'place' }, fields: { name: '名稱' } },
  place: {
    fields: { name: '名稱', time: '時間', note: '備註' },
    groups: { location: { label: '位置', keys: ['address', 'lat', 'lng', 'placeId', 'types', 'icon'] } },
  },
};

const LIST_LABELS = { days: '天數', sections: '區塊', places: '地點', collections: '分類' };

// 依 key 排序後序列化，比較時不受欄位順序影響
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
const same = (a, b) => stableJson(a) === stableJson(b);

function entityLabel(type, item, index) {
  if (!item) return '';
  switch (type) {
    case 'day': return [`Day ${index + 1}`, item.name, item.title].filter(Boolean).join(' ');
    case 'section': return item.name || item.center?.name || '區塊';
    case 'collection': return item.name || '分類';
    default: return item.name || '地點';
  }
}

function formatValue(v) {
  if (v === undefined || v === null || v === '') return '（空白）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') return v.name || v.address || '（已修改）';
  return String(v);
}

function mergeProject(base, local, remote, choices = {}) {
  const conflicts = [];
  const ctx = { choices, conflicts };
  const merged = mergeEntity('state', base || {}, local, remote, ctx, 'state', []);
  merged.local = local.local;
  // 修正指向已刪除項目的畫面狀態（目前的天數、區塊、分類）
  return { state: normalizeState(merged) || remote, conflicts };
}

// 記錄衝突並依選擇回傳
function conflict(ctx, key, where, field, localValue, remoteValue, { localText, remoteText } = {}) {
  const choice = ctx.choices[key] === 'remote' ? 'remote' : 'local';
  ctx.conflicts.push({
    key,
    where: where.filter(Boolean).join(' › '),
    field,
    local: localText ?? formatValue(localValue),
    remote: remoteText ?? formatValue(remoteValue),
    choice,
  });
  return choice;
}

function mergeValue(ctx, key, where, field, b, l, r) {
  if (same(l, r) || same(b, r)) return l;
  if (same(b, l)) return r;
  return conflict(ctx, key, where, field, l, r) === 'remote' ? r : l;
}

function mergeEntity(type, b, l, r, ctx, path, where) {
  const schema = MERGE_SCHEMA[type];
  const out = {};
  const handled = new Set();
  const take = (k, v) => {
    handled.add(k);
    if (v !== undefined) out[k] = v;
  };

  for (const k of schema.skip || []) take(k, l[k] !== undefined ? l[k] : r[k]);
  for (const [k, childType] of Object.entries(schema.lists || {})) {
    take(k, mergeList(childType, b[k] || [], l[k] || [], r[k] || [], ctx, `${path}/${k}`, where, LIST_LABELS[k]));
  }
  for (const [k, childType] of Object.entries(schema.nested || {})) {
    take(k, mergeEntity(childType, b[k] || {}, l[k] || {}, r[k] || {}, ctx, `${path}/${k}`, where));
  }
  for (const [k, childType] of Object.entries(schema.objects || {})) {
    const [bo, lo, ro] = [b[k], l[k], r[k]];
    // 同一個物件（id 相同）時逐欄合併；換成別的物件（例如更換區塊中心）時整個比較
    if (lo && ro && lo.id === ro.id) {
      take(k, mergeEntity(childType, bo?.id === lo.id ? bo : {}, lo, ro, ctx, `${path}/${k}`, where.concat(entityLabel(childType, lo))));
    } else {
      take(k, mergeValue(ctx, `${path}/${k}`, where, k === 'center' ? '中心地點' : k, bo, lo, ro));
    }
  }
  for (const [g, { label, keys }] of Object.entries(schema.groups || {})) {
    const pick = (o) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    const v = mergeValue(ctx, `${path}/${g}`, where, label, pick(b), pick(l), pick(r));
    keys.forEach((k) => take(k, v[k]));
  }
  // 其餘欄位（包含 schema 沒列出的）一律逐欄比較
  const keys = new Set([...Object.keys(l), ...Object.keys(r)]);
  for (const k of keys) {
    if (handled.has(k)) continue;
    take(k, mergeValue(ctx, `${path}/${k}`, where, schema.fields?.[k] || k, b[k], l[k], r[k]));
  }
  return out;
}

function mergeList(type, bList, lList, rList, ctx, path, where, listLabel) {
  const byId = (list) => new Map(list.map((x, i) => [x.id, { item: x, index: i }]));
  const [B, L, R] = [byId(bList), byId(lList), byId(rList)];
  const kept = new Map();

  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const b = B.get(id)?.item;
    const l = L.get(id);
    const r = R.get(id);
    const ref = l || r;
    const name = entityLabel(type, ref.item, ref.index);
    const key = `${path}/${id}`;
    const here = where.concat(name);
    if (l && r) {
      kept.set(id, mergeEntity(type, b || {}, l.item, r.item, ctx, key, here));
    } else if (!b) {
      // 只有一邊新增
      kept.set(id, ref.item);
    } else if (l) {
      // 遠端刪除：本機沒改就刪掉，本機有修改則是衝突
      if (same(b, l.item)) continue;
      const choice = conflict(ctx, key, where, `${listLabel}「${name}」`, null, null,
        { localText: '保留（本機有修改）', remoteText: '刪除（遠端已刪除）' });
      if (choice === 'local') kept.set(id, l.item);
    } else {
      // 本機刪除：遠端沒改就刪掉，遠端有修改則是衝突
      if (same(b, r.item)) continue;
      const choice = conflict(ctx, key, where, `${listLabel}「${name}」`, null, null,
        { localText: '刪除（本機已刪除）', remoteText: '保留（遠端有修改）' });
      if (choice === 'remote') kept.set(id, r.item);
    }
  }

  // 順序：遠端沒有調整共同項目的順序時以本機為主，否則以遠端為主；再把另一邊新增的項目插在它原本的前一項後面
  const common = (list) => list.map((x) => x.id).filter((id) => B.has(id) && L.has(id) && R.has(id));
  const remoteReordered = !same(common(rList), common(bList));
  const [primary, secondary] = remoteReordered ? [rList, lList] : [lList, rList];
  const order = primary.map((x) => x.id).filter((id) => kept.has(id));
  secondary.forEach((x, i) => {
    if (!kept.has(x.id) || order.includes(x.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = order.indexOf(secondary[j].id);
      if (prev !== -1) { at = prev + 1; break; }
    }
    order.splice(at, 0, x.id);
  });
  return order.map((id) => kept.get(id));
}
