'use strict';

// ===========================================================================
// 儲存的資料結構與工具函式（不碰 DOM，也不碰 Google Maps）
//
//   state   = { version, mode: 'trip' | 'library', title, startDate, days: [day], activeDayId, activeSectionId,
//               dayOpen, showAll, library }
//   day     = { id, name, title, sections: [section] }
//   section = { id, name, time, note, center: place, places: [place] }
//   place   = { id, name, address, lat, lng, placeId, types, icon, time, note }
//   library = { collections: [collection], activeCollectionId }
//   collection = { id, name, places: [place] }
//   local   = { remote: { owner, repo } | null, token, commit, commitMessage, commitDate, syncedHash }
//             只記錄在本機：這個專案連結的遠端，以及目前在哪一個 commit 上（不會推送到遠端，也不會匯出）
//
// 每個專案是一份 state，各自存在瀏覽器；projects 記錄專案清單與目前開啟的專案。
// 目前的資料放在全域的 state；匯入、清空或切換專案時會整個換掉（state = ...）。
// ===========================================================================

// 舊版只有一份存檔，第一次載入時搬成第一個專案
const STORAGE_KEY = 'map-planner-v1';
const PROJECTS_KEY = 'map-planner-projects';
const projectKey = (id) => `map-planner-project:${id}`;
const DAY_COLORS = ['#e8453c', '#34a853', '#1a73e8', '#f29900', '#9334e6', '#00a3bf', '#e8710a', '#795548', '#d01884', '#3949ab'];
const COLLECTION_COLORS = ['#00897b', '#f4511e', '#8e24aa', '#3949ab', '#7cb342', '#6d4c41', '#d81b60', '#039be5'];
const WEEKDAYS = '日一二三四五六';

// 沒有 Google 圖示時（例如自訂地點）的備用圖示：依 Google 地點類型對照；
// 依這裡的順序決定優先權（Google 回傳的 types 不一定依重要性排序）
const PLACE_CATEGORIES = [
  { icon: '🏨', label: '住宿', types: ['lodging', 'hotel', 'motel', 'hostel', 'resort_hotel', 'bed_and_breakfast', 'guest_house', 'campground'] },
  { icon: '✈️', label: '機場', types: ['airport', 'international_airport'] },
  { icon: '🚉', label: '車站', types: ['train_station', 'subway_station', 'light_rail_station', 'transit_station', 'transit_depot'] },
  { icon: '🚌', label: '公車站', types: ['bus_station', 'bus_stop'] },
  { icon: '☕', label: '咖啡廳', types: ['cafe', 'coffee_shop', 'bakery', 'tea_house', 'dessert_shop'] },
  { icon: '🍺', label: '酒吧', types: ['bar', 'night_club', 'pub', 'wine_bar'] },
  { icon: '🍴', label: '餐飲', types: ['restaurant', 'food', 'meal_takeaway', 'meal_delivery', 'food_court'] },
  { icon: '🛍️', label: '購物', types: ['shopping_mall', 'department_store', 'store', 'clothing_store', 'supermarket', 'convenience_store', 'market', 'book_store', 'electronics_store'] },
  { icon: '🏛️', label: '博物館', types: ['museum', 'art_gallery', 'cultural_center', 'historical_landmark', 'monument'] },
  { icon: '⛩️', label: '寺廟', types: ['place_of_worship', 'hindu_temple', 'buddhist_temple', 'church', 'mosque', 'synagogue', 'shinto_shrine'] },
  { icon: '🌳', label: '公園', types: ['park', 'national_park', 'garden', 'hiking_area', 'natural_feature', 'beach'] },
  { icon: '🎡', label: '景點', types: ['tourist_attraction', 'amusement_park', 'zoo', 'aquarium', 'stadium', 'movie_theater', 'observation_deck', 'visitor_center'] },
];
const DEFAULT_CATEGORY = { icon: '📍', label: '地點' };

function placeCategory(place) {
  const types = place.types || [];
  return PLACE_CATEGORIES.find((c) => c.types.some((t) => types.includes(t))) || DEFAULT_CATEGORY;
}

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// 建立與正規化
// ---------------------------------------------------------------------------

function newDay() {
  return { id: uid(), name: '', title: '', sections: [] };
}

function toPlace(p) {
  return {
    id: p.id || uid(),
    name: p.name || '未命名地點',
    address: p.address || '',
    lat: p.lat,
    lng: p.lng,
    placeId: p.placeId || '',
    // types / icon 為 undefined 表示還沒查過（舊資料），會在地圖載入後補上
    types: p.types,
    // Google 地圖使用的分類圖示 { mask, bg }；沒有時為 null
    icon: p.icon,
    time: p.time || '',
    note: p.note || '',
  };
}

function newSection(candidate) {
  return { id: uid(), name: candidate.name || '', time: '', note: '', center: toPlace({ ...candidate, id: uid() }), places: [] };
}

function defaultState() {
  const day = newDay();
  return {
    version: 2, mode: 'trip', title: '我的旅程', startDate: '', days: [day], activeDayId: day.id, activeSectionId: null, dayOpen: true, showAll: false,
    library: defaultLibrary(), local: defaultLocal(),
  };
}

function defaultLocal() {
  return { remote: null, token: '', commit: null, commitMessage: '', commitDate: '', syncedHash: '' };
}

function defaultLibrary() {
  return { collections: [], activeCollectionId: null };
}

// 驗證並把舊格式（每天一串地點）升級成區塊格式
function normalizeState(s) {
  if (!s || !Array.isArray(s.days) || s.days.length === 0) return null;
  for (const d of s.days) {
    if (!d || !d.id) return null;
    if (!Array.isArray(d.sections)) {
      d.sections = (Array.isArray(d.items) ? d.items : []).map((it) => ({
        id: uid(), name: it.name || '', time: it.time || '', note: it.note || '', center: toPlace(it), places: [],
      }));
      delete d.items;
    }
    if (!d.sections.every((sec) => sec && sec.id && sec.center && Array.isArray(sec.places))) return null;
    d.title ??= '';
    d.name ??= '';
  }
  s.version = 2;
  s.title ??= '我的旅程';
  // 導覽層級：dayOpen = false 時在選擇天數，true 時顯示當天的區塊
  s.dayOpen ??= s.panelOpen ?? true;
  delete s.panelOpen;
  if (!s.days.some((d) => d.id === s.activeDayId)) s.activeDayId = s.days[0].id;
  const day = s.days.find((d) => d.id === s.activeDayId);
  if (!day.sections.some((sec) => sec.id === s.activeSectionId)) s.activeSectionId = null;
  s.mode = s.mode === 'library' ? 'library' : 'trip';
  const lib = s.library;
  if (!lib || !Array.isArray(lib.collections) || !lib.collections.every((c) => c && c.id && Array.isArray(c.places))) {
    s.library = defaultLibrary();
  } else if (!lib.collections.some((c) => c.id === lib.activeCollectionId)) {
    lib.activeCollectionId = null;
  }
  s.local = s.local && typeof s.local === 'object' ? { ...defaultLocal(), ...s.local } : defaultLocal();
  return s;
}

// 支援完整匯出檔（{ library: { collections } }）或只有 { collections } 的檔案
function collectionsFromJson(data) {
  const cols = data?.library?.collections ?? data?.collections;
  if (!Array.isArray(cols)) return null;
  return cols
    .filter((c) => c && Array.isArray(c.places))
    .map((c) => ({
      name: String(c.name || '未命名分類').trim(),
      places: c.places.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    }))
    .filter((c) => c.places.length);
}

// ---------------------------------------------------------------------------
// 讀寫瀏覽器儲存空間
// ---------------------------------------------------------------------------

function loadState(id) {
  try {
    const s = normalizeState(JSON.parse(localStorage.getItem(projectKey(id))));
    if (s) return s;
  } catch { /* ignore */ }
  return defaultState();
}

// projects = { activeId, list: [{ id, title }] }；title 是專案清單顯示用的快取
function loadProjects() {
  try {
    const p = JSON.parse(localStorage.getItem(PROJECTS_KEY));
    if (p && Array.isArray(p.list) && p.list.length && p.list.every((x) => x && x.id)) {
      if (!p.list.some((x) => x.id === p.activeId)) p.activeId = p.list[0].id;
      return p;
    }
  } catch { /* ignore */ }
  // 沒有專案清單：把舊版的單一存檔（或新的空白行程）建成第一個專案
  let first = null;
  try { first = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch { /* ignore */ }
  first ||= defaultState();
  const id = uid();
  try {
    localStorage.setItem(projectKey(id), JSON.stringify(first));
    localStorage.setItem(PROJECTS_KEY, JSON.stringify({ activeId: id, list: [{ id, title: first.title }] }));
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  return { activeId: id, list: [{ id, title: first.title }] };
}

function saveProjects() {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); } catch { /* ignore */ }
}

// 回傳是否成功（儲存空間不足或被封鎖時失敗）
function saveState() {
  const entry = projects.list.find((p) => p.id === projects.activeId);
  if (entry && entry.title !== state.title) {
    entry.title = state.title;
    saveProjects();
  }
  try {
    localStorage.setItem(projectKey(projects.activeId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

let projects = loadProjects();
let state = loadState(projects.activeId);

// ---------------------------------------------------------------------------
// 專案：新增、切換、刪除（呼叫端負責重繪畫面）
// ---------------------------------------------------------------------------

function projectTitle(p) { return p.title || '未命名旅程'; }

function switchProject(id) {
  if (id === projects.activeId || !projects.list.some((p) => p.id === id)) return;
  saveState();
  projects.activeId = id;
  saveProjects();
  state = loadState(id);
}

function createProject(title) {
  if (projects.list.some((p) => p.id === projects.activeId)) saveState();
  const id = uid();
  state = { ...defaultState(), title: title || '我的旅程' };
  projects.list.push({ id, title: state.title });
  projects.activeId = id;
  saveProjects();
  saveState();
}

// 刪除目前的專案；刪掉最後一個時建立新的空白專案
function deleteActiveProject() {
  const id = projects.activeId;
  try { localStorage.removeItem(projectKey(id)); } catch { /* ignore */ }
  projects.list = projects.list.filter((p) => p.id !== id);
  if (!projects.list.length) {
    createProject();
    return;
  }
  projects.activeId = projects.list[0].id;
  saveProjects();
  state = loadState(projects.activeId);
}

// ---------------------------------------------------------------------------
// 行程查詢
// ---------------------------------------------------------------------------

function findDay(id) { return state.days.find((d) => d.id === id); }
function activeDay() { return findDay(state.activeDayId) || state.days[0]; }
function activeSection() { return activeDay().sections.find((s) => s.id === state.activeSectionId) || null; }
function dayIndex(day) { return state.days.indexOf(day); }
function dayColor(day) { return DAY_COLORS[dayIndex(day) % DAY_COLORS.length]; }
// 使用者可自訂每天的名稱；沒有自訂時用「Day N」
function dayNumLabel(day) { return `Day ${dayIndex(day) + 1}`; }
function dayLabel(day) { return day.name || dayNumLabel(day); }
function sectionName(sec) { return sec.name || sec.center.name; }

// 依出發日算出這一天的日期；沒有設定出發日時為 null
function dayDateObj(day) {
  if (!state.startDate) return null;
  const d = new Date(`${state.startDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + dayIndex(day));
  return d;
}

function dayDate(day) {
  const d = dayDateObj(day);
  return d ? `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})` : '';
}

function dayOptionLabel(day) {
  return [dayLabel(day), dayDate(day), day.title].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// 地點庫查詢
// ---------------------------------------------------------------------------

const isLibrary = () => state.mode === 'library';

function activeCollection() {
  return state.library.collections.find((c) => c.id === state.library.activeCollectionId) || null;
}

function collectionColor(col) {
  return COLLECTION_COLORS[state.library.collections.indexOf(col) % COLLECTION_COLORS.length];
}

function createCollection(name) {
  const cols = state.library.collections;
  const col = { id: uid(), name: name || `新分類 ${cols.length + 1}`, places: [] };
  cols.push(col);
  return col;
}

// 同一個地點可能在多個分類中，用 placeId（或座標）合併成一筆
function placeKey(p) {
  return p.placeId || `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

function libraryEntries() {
  const byKey = new Map();
  state.library.collections.forEach((col) => {
    col.places.forEach((p) => {
      const key = placeKey(p);
      if (!byKey.has(key)) byKey.set(key, { key, place: p, collections: [] });
      byKey.get(key).collections.push(col);
    });
  });
  return [...byKey.values()];
}

// 找出已儲存地點所屬的區塊（中心或周邊地點）或地點庫分類
function findPlaceOwner(placeId) {
  for (const day of state.days) {
    for (const sec of day.sections) {
      if (sec.center.id === placeId) return { kind: 'center', day, sec };
      if (sec.places.some((p) => p.id === placeId)) return { kind: 'section', day, sec };
    }
  }
  const col = state.library.collections.find((c) => c.places.some((p) => p.id === placeId));
  return col ? { kind: 'collection', col } : null;
}

// ---------------------------------------------------------------------------
// 座標
// ---------------------------------------------------------------------------

function latLng(p) { return { lat: p.lat, lng: p.lng }; }

function distanceMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 區塊範圍：涵蓋所有周邊地點，至少 200 公尺
function sectionRadius(sec) {
  const far = Math.max(0, ...sec.places.map((p) => distanceMeters(sec.center, p)));
  return Math.max(200, far * 1.15 + 60);
}
