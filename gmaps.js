'use strict';

// ===========================================================================
// Google Maps：載入 API、Places 請求、回傳資料的解析，以及地圖物件（標記、圖形、資訊視窗）的操作。
// 不讀寫行程資料，也不處理疊加在地圖上的介面；地點一律轉成 candidate 交給 app.js：
//   candidate = { name, address, lat, lng, placeId, types, icon: { mask, bg } | null, details }
//   details   = { rating, ratingCount, openNow, hours, periods, phone, website, mapsUrl, photo, photoCredit }
// ===========================================================================

const CONFIG = window.APP_CONFIG || {};
const useNewPlacesApi = () => CONFIG.placesApi === 'new';

// 地點資訊視窗需要的欄位（評分、營業時間、電話、網站、照片、Google 地圖連結）
const PLACE_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'location',
  'types', 'svgIconMaskURI', 'iconBackgroundColor', 'rating', 'userRatingCount', 'regularOpeningHours', 'nationalPhoneNumber', 'websiteURI', 'googleMapsURI', 'photos',
];
const LEGACY_PLACE_FIELDS = [
  'place_id', 'name', 'formatted_address', 'geometry',
  'types', 'icon_mask_base_uri', 'icon_background_color', 'rating', 'user_ratings_total', 'opening_hours', 'utc_offset_minutes', 'formatted_phone_number', 'website', 'url', 'photos',
];

let map, infoWindow, geocoder, placesService, autocompleteService;
let placesLib, AdvancedMarkerElement, PinElement;

// ---------------------------------------------------------------------------
// 載入與初始化
// ---------------------------------------------------------------------------

// 金鑰來源優先順序：網址 #key=… → 先前存在瀏覽器的金鑰 → config.js（release 版的 config.js 不含金鑰）
// 網址上的金鑰讀到後就存起來並從網址移除，避免留在瀏覽紀錄、書籤或再分享出去的連結裡
const API_KEY_STORAGE = 'map-planner-gmaps-key';

(function resolveApiKey() {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromUrl = params.get('key')?.trim();
  if (fromUrl) {
    try { localStorage.setItem(API_KEY_STORAGE, fromUrl); } catch { /* ignore */ }
    params.delete('key');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  }
  let saved = null;
  try { saved = localStorage.getItem(API_KEY_STORAGE); } catch { /* ignore */ }
  CONFIG.googleMapsApiKey = fromUrl || saved || CONFIG.googleMapsApiKey || '';
})();

function forgetSavedApiKey() {
  try { localStorage.removeItem(API_KEY_STORAGE); } catch { /* ignore */ }
}

const hasApiKey = () => !!CONFIG.googleMapsApiKey;
const mapReady = () => !!map;

// Google 官方 dynamic library import loader
function loadGoogleMaps() {
  /* eslint-disable */
  ((g) => { var h, a, k, p = 'The Google Maps JavaScript API', c = 'google', l = 'importLibrary', q = '__ib__', m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set(), e = new URLSearchParams(), u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement('script')); e.set('libraries', [...r] + ''); for (k in g) e.set(k.replace(/[A-Z]/g, (t) => '_' + t[0].toLowerCase()), g[k]); e.set('callback', c + '.maps.' + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => h = n(Error(p + ' could not load.')); a.nonce = m.querySelector('script[nonce]')?.nonce || ''; m.head.append(a); })); d[l] ? console.warn(p + ' only loads once. Ignoring:', g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)); })({
    key: CONFIG.googleMapsApiKey,
    v: 'weekly',
    language: 'zh-TW',
  });
  /* eslint-enable */
}

// onMapClick({ latLng: { lat, lng }, placeId })：點到地圖上的 POI 時 placeId 有值，且不顯示 Google 預設的資訊視窗
// onInfoWindowReady()：資訊視窗內容顯示完成
async function initGoogleMaps(el, { controls = true, onMapClick, onInfoWindowReady } = {}) {
  loadGoogleMaps();
  const [{ Map, InfoWindow }, markerLib, places, { Geocoder }] = await Promise.all([
    google.maps.importLibrary('maps'),
    google.maps.importLibrary('marker'),
    google.maps.importLibrary('places'),
    google.maps.importLibrary('geocoding'),
  ]);
  ({ AdvancedMarkerElement, PinElement } = markerLib);
  placesLib = places;

  map = new Map(el, {
    center: CONFIG.defaultCenter || { lat: 25.0478, lng: 121.5319 },
    zoom: CONFIG.defaultZoom || 12,
    mapId: CONFIG.mapId || 'DEMO_MAP_ID',
    gestureHandling: 'greedy',
    clickableIcons: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    zoomControl: controls,
    cameraControl: controls,
  });
  infoWindow = new InfoWindow();
  if (onInfoWindowReady) infoWindow.addListener('domready', onInfoWindowReady);
  geocoder = new Geocoder();
  placesService = new places.PlacesService(map);
  if (!useNewPlacesApi()) autocompleteService = new places.AutocompleteService();

  map.addListener('click', (e) => {
    if (!e.latLng) return;
    if (e.placeId) e.stop();
    onMapClick?.({ latLng: { lat: e.latLng.lat(), lng: e.latLng.lng() }, placeId: e.placeId || '' });
  });
}

// ---------------------------------------------------------------------------
// 解析：Google 回傳的地點 → candidate
// ---------------------------------------------------------------------------

function placeToCandidate(place) {
  const photo = place.photos?.[0];
  return {
    name: place.displayName || '',
    address: place.formattedAddress || '',
    lat: place.location.lat(),
    lng: place.location.lng(),
    placeId: place.id || '',
    types: place.types || [],
    icon: place.svgIconMaskURI ? { mask: place.svgIconMaskURI, bg: place.iconBackgroundColor } : null,
    details: {
      rating: place.rating,
      ratingCount: place.userRatingCount,
      hours: place.regularOpeningHours?.weekdayDescriptions,
      periods: place.regularOpeningHours?.periods?.map(({ open, close }) => ({
        open: weekMinute(open.day, open.hour, open.minute),
        close: close ? weekMinute(close.day, close.hour, close.minute) : null,
      })),
      phone: place.nationalPhoneNumber,
      website: place.websiteURI,
      mapsUrl: place.googleMapsURI,
      photo: photo?.getURI({ maxWidth: 520 }),
      photoCredit: photo?.authorAttributions?.map((a) => a.displayName).join(', ') || '',
    },
  };
}

function legacyToCandidate(p) {
  const photo = p.photos?.[0];
  let openNow;
  try { openNow = p.opening_hours?.isOpen(); } catch { /* 缺少時區資訊時無法判斷 */ }
  return {
    name: p.name || '',
    address: p.formatted_address || '',
    lat: p.geometry.location.lat(),
    lng: p.geometry.location.lng(),
    placeId: p.place_id || '',
    types: p.types || [],
    icon: p.icon_mask_base_uri ? { mask: `${p.icon_mask_base_uri}.svg`, bg: p.icon_background_color } : null,
    details: {
      rating: p.rating,
      ratingCount: p.user_ratings_total,
      openNow,
      hours: p.opening_hours?.weekday_text,
      periods: p.opening_hours?.periods?.map(({ open, close }) => ({
        open: weekMinute(open.day, open.hours, open.minutes),
        close: close ? weekMinute(close.day, close.hours, close.minutes) : null,
      })),
      phone: p.formatted_phone_number,
      website: p.website,
      mapsUrl: p.url,
      photo: photo?.getUrl({ maxWidth: 520 }),
      photoCredit: htmlToText(photo?.html_attributions?.join(', ')),
    },
  };
}

function htmlToText(html) {
  return html ? new DOMParser().parseFromString(html, 'text/html').body.textContent : '';
}

// ---------------------------------------------------------------------------
// 營業時間
// ---------------------------------------------------------------------------

const WEEK_MINUTES = 7 * 1440;

// 一週中的第幾分鐘（週日 00:00 為 0），營業時段都換成這個單位比較
function weekMinute(day, hour, minute) {
  return day * 1440 + hour * 60 + minute;
}

// periods：[{ open, close }]，close 為 null 表示 24 小時營業；時間都是地點當地時間
function isOpenAt(periods, weekday, minutes) {
  const t = weekday * 1440 + minutes;
  return periods.some(({ open, close }) => {
    if (close === null) return true;
    const end = close > open ? close : close + WEEK_MINUTES; // 跨週（週六營業到週日凌晨）
    return (t >= open && t < end) || (t + WEEK_MINUTES >= open && t + WEEK_MINUTES < end);
  });
}

// 依營業時間過濾。舊版 Text Search 的結果沒有營業時段，要逐一查 Place Details；
// 新版的欄位已包含營業時段，「現在營業中」則已由 isOpenNow 在伺服器端過濾
// filter = { hours: 'now' } 或 { hours: 'at', weekday, minutes }
async function applyHoursFilter(items, filter) {
  if (useNewPlacesApi() && filter.hours === 'now') return { items, unknown: 0 };
  if (!useNewPlacesApi()) {
    items = await mapLimit(items, 5, (c) => (c.placeId ? getPlaceDetails(c.placeId).catch(() => c) : c));
  }
  const known = items.filter((c) => (filter.hours === 'now' ? c.details?.openNow !== undefined : c.details?.periods?.length));
  const open = known.filter((c) => (filter.hours === 'now'
    ? c.details.openNow
    : isOpenAt(c.details.periods, filter.weekday, filter.minutes)));
  return { items: open, unknown: items.length - known.length };
}

// ---------------------------------------------------------------------------
// Places 請求
// ---------------------------------------------------------------------------

// 一次輸入到選定地點共用同一個 session token（Google 合併計費）
function newSessionToken() {
  return new placesLib.AutocompleteSessionToken();
}

// 輸入時的地點建議：[{ main, sub, placeId, prediction }]（prediction 只有新版有）
async function fetchSuggestions(input, sessionToken, bounds) {
  if (useNewPlacesApi()) {
    const { suggestions: list } = await placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input, sessionToken, ...(bounds && { locationBias: bounds }),
    });
    return list.filter((s) => s.placePrediction).map(({ placePrediction: p }) => ({
      main: p.mainText?.text || p.text.text, sub: p.secondaryText?.text || '', placeId: p.placeId, prediction: p,
    }));
  }
  const { predictions } = await autocompleteService.getPlacePredictions({ input, sessionToken, ...(bounds && { bounds }) });
  return predictions.map((p) => ({
    main: p.structured_formatting.main_text, sub: p.structured_formatting.secondary_text || '', placeId: p.place_id,
  }));
}

// 選定某個建議後取得地點資訊（同時結束 session）
async function fetchSuggestionPlace(suggestion, sessionToken) {
  if (suggestion.prediction) {
    const place = suggestion.prediction.toPlace();
    await place.fetchFields({ fields: PLACE_FIELDS });
    return placeToCandidate(place);
  }
  return fetchPlaceById(suggestion.placeId, sessionToken);
}

async function fetchPlaceById(placeId, sessionToken) {
  if (useNewPlacesApi()) {
    const place = new placesLib.Place({ id: placeId });
    await place.fetchFields({ fields: PLACE_FIELDS });
    return placeToCandidate(place);
  }
  return new Promise((resolve, reject) => {
    placesService.getDetails({ placeId, fields: LEGACY_PLACE_FIELDS, ...(sessionToken && { sessionToken }) }, (p, status) => {
      if (status === 'OK' && p?.geometry?.location) resolve(legacyToCandidate(p));
      else reject(new Error(`PlacesService: ${status}`));
    });
  });
}

// 同一個地點重複點選時不再重新查詢
const detailsCache = new Map();
function getPlaceDetails(placeId) {
  if (!detailsCache.has(placeId)) {
    const request = fetchPlaceById(placeId);
    request.catch(() => detailsCache.delete(placeId));
    detailsCache.set(placeId, request);
  }
  return detailsCache.get(placeId);
}

// 最多 20 筆：舊版的翻頁（pagetoken）實測一律回 INVALID_REQUEST，新版 JS API 沒有翻頁，
// 想看別處的結果改用「搜尋此區域」。
// 搜尋此區域時用 locationRestriction（新版）並過濾掉範圍外的結果；一般搜尋只是優先顯示範圍內
async function textSearch(query, bounds, area, filter) {
  let items;
  if (useNewPlacesApi()) {
    const scope = area ? { locationRestriction: bounds } : { locationBias: bounds };
    const { places: list } = await placesLib.Place.searchByText({
      textQuery: query, fields: PLACE_FIELDS, maxResultCount: 20, ...(bounds && scope),
      ...(filter?.hours === 'now' && { isOpenNow: true }),
    });
    items = list.map(placeToCandidate);
  } else {
    items = await new Promise((resolve, reject) => {
      placesService.textSearch({ query, ...(bounds && { bounds }) }, (results, status) => {
        if (status === 'ZERO_RESULTS') resolve([]);
        else if (status !== 'OK') reject(new Error(`PlacesService: ${status}`));
        else resolve(results.filter((r) => r.geometry?.location).map(legacyToCandidate));
      });
    });
  }
  return area && bounds ? items.filter((c) => bounds.contains(latLng(c))) : items;
}

// 地圖上的車站標籤與圖示點擊時不會帶 placeId（Google 的限制，點陣與向量地圖皆然），
// 改找點擊位置附近最近的車站；超過這個距離就視為沒有點到車站
const STATION_SNAP_METERS = 60;

async function findStationNear(point) {
  let list = [];
  try {
    if (useNewPlacesApi()) {
      const { places } = await placesLib.Place.searchNearby({
        fields: ['id', 'location'],
        locationRestriction: { center: point, radius: STATION_SNAP_METERS },
        includedTypes: ['transit_station'],
        maxResultCount: 5,
        rankPreference: placesLib.SearchNearbyRankPreference.DISTANCE,
      });
      list = places.map((p) => ({ placeId: p.id, lat: p.location.lat(), lng: p.location.lng() }));
    } else {
      list = await new Promise((resolve) => {
        placesService.nearbySearch({ location: point, radius: STATION_SNAP_METERS, type: 'transit_station' }, (results, status) => {
          resolve(status === 'OK' ? results.map((r) => ({ placeId: r.place_id, lat: r.geometry.location.lat(), lng: r.geometry.location.lng() })) : []);
        });
      });
    }
  } catch (err) {
    console.error(err);
  }
  const nearest = list
    .map((s) => ({ ...s, d: distanceMeters(point, s) }))
    .filter((s) => s.d <= STATION_SNAP_METERS)
    .sort((a, b) => a.d - b.d)[0];
  return nearest?.placeId || '';
}

// 座標 → 地址；沒啟用 Geocoding API 或查不到時回傳空字串
async function reverseGeocode(point) {
  try {
    const { results } = await geocoder.geocode({ location: point });
    return results?.[0]?.formatted_address || '';
  } catch {
    return '';
  }
}

// 同時最多 limit 個請求，避免一次送出太多 Place Details
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Google 地圖網址
// ---------------------------------------------------------------------------

function googleMapsUrl(p) {
  if (p.details?.mapsUrl) return p.details.mapsUrl;
  const q = new URLSearchParams({ api: '1', query: p.placeId ? p.name : `${p.lat},${p.lng}` });
  if (p.placeId) q.set('query_place_id', p.placeId);
  return `https://www.google.com/maps/search/?${q}`;
}

function directionsUrl(points) {
  if (points.length === 0) return '';
  const pt = (p) => `${p.lat},${p.lng}`;
  if (points.length === 1) {
    const q = new URLSearchParams({ api: '1', query: pt(points[0]) });
    if (points[0].placeId) q.set('query_place_id', points[0].placeId);
    return `https://www.google.com/maps/search/?${q}`;
  }
  const q = new URLSearchParams({ api: '1', origin: pt(points[0]), destination: pt(points[points.length - 1]) });
  // Google Maps URL 最多支援 9 個中途點
  const waypoints = points.slice(1, -1).slice(0, 9).map(pt);
  if (waypoints.length) q.set('waypoints', waypoints.join('|'));
  return `https://www.google.com/maps/dir/?${q}`;
}

// ---------------------------------------------------------------------------
// Google 地圖「已儲存」清單（Google Takeout 匯出的 CSV）
//   格式：第一行是清單名稱，空一行後是「標題,筆記,網址,標籤,留言」（欄位名稱依語系而異，順序固定）。
//   CSV 沒有座標與 placeId，但網址的 data 參數中「!1s」後面是地點的 fid（0x…:0x…），
//   可直接換算成 placeId，再查 Place Details 取得精確的地點資訊。
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [[]];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      rows[rows.length - 1].push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      rows[rows.length - 1].push(cell);
      cell = '';
      rows.push([]);
    } else {
      cell += ch;
    }
  }
  rows[rows.length - 1].push(cell);
  return rows;
}

// → { name, items: [{ title, note, url }] }
function parseSavedList(text, fileName) {
  const rows = parseCsv(text);
  const isMapsUrl = (s) => /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.|maps\.app\.goo\.gl)/i.test(s || '');
  const items = rows.filter((r) => isMapsUrl(r[2])).map(([title = '', note = '', url, , comment = '']) => ({
    title: title.trim(),
    note: [note.trim(), comment.trim()].filter(Boolean).join('\n'),
    url,
  }));
  // 第一行只有一欄時是清單名稱，否則用檔名
  const listName = rows[0]?.length === 1 ? rows[0][0].trim() : '';
  return { name: listName || fileName.replace(/\.csv$/i, ''), items };
}

// fid（0x…:0x…）→ placeId：placeId 是 protobuf { 1: fixed64, 2: fixed64 } 的 base64url
// （所以這類 placeId 都以「ChIJ」開頭），兩個 64 位元整數以 little-endian 存放
function fidToPlaceId(fid) {
  const le64 = (n) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  const [a, b] = fid.split(':').map((hex) => BigInt(hex));
  const bytes = [0x0a, 0x12, 0x09, ...le64(a), 0x11, ...le64(b)];
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 回傳 { place } 或 { error }；名稱沿用清單中的標題（使用者在 Google 地圖看到的名稱）
async function resolveSavedPlace(item) {
  const fid = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(item.url)?.[1];
  if (fid) {
    try {
      const c = await getPlaceDetails(fidToPlaceId(fid));
      return { place: { ...c, name: item.title || c.name, note: item.note } };
    } catch (err) {
      console.error(err);
      return { error: 'missing' }; // 地點已從 Google 地圖移除
    }
  }
  // 丟圖釘儲存的地點沒有 fid，網址中是座標（「/search/緯度,經度」或「@緯度,經度」）
  const pt = /[/@=](-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(decodeURIComponent(item.url));
  if (pt) {
    const [lat, lng] = [Number(pt[1]), Number(pt[2])];
    const name = item.title || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    return { place: { name, address: '', lat, lng, placeId: '', types: [], icon: null, note: item.note } };
  }
  return { error: 'unknown' };
}

// ---------------------------------------------------------------------------
// 地圖操作：視角、標記、圖形
// ---------------------------------------------------------------------------

function mapBounds() {
  return map?.getBounds() ?? null;
}

// minZoom：地圖比這個還遠時一併拉近
function panMapTo(point, minZoom = 0) {
  map.panTo(point);
  if (map.getZoom() < minZoom) map.setZoom(minZoom);
}

function panMapBy(dx, dy) {
  map.panBy(dx, dy);
}

// padding：{ top, right, bottom, left }，可視範圍要避開的區域
function fitMapTo(points, padding) {
  if (points.length === 0) return;
  if (points.length === 1) {
    map.setZoom(16);
    map.panTo(points[0]);
    map.panBy((padding.right - padding.left) / 2, (padding.bottom - padding.top) / 2);
    return;
  }
  const bounds = new google.maps.LatLngBounds();
  points.forEach((p) => bounds.extend(p));
  map.fitBounds(bounds, padding);
}

// content：標記的 DOM 元素（或 createPin 的圖釘）
function createMarker({ position, content, title, zIndex, onClick }) {
  const marker = new AdvancedMarkerElement({ map, position, content, title, zIndex, gmpClickable: true });
  if (onClick) marker.addEventListener('gmp-click', onClick);
  return marker;
}

// Google 樣式的圖釘：白框、白色文字
function createPin({ color, text, scale }) {
  return new PinElement({ background: color, borderColor: '#ffffff', glyphText: text, glyphColor: '#ffffff', scale });
}

function drawCircle({ center, radius, color, opacity, weight }) {
  return new google.maps.Circle({
    map, center, radius, clickable: false, strokeColor: color, strokeOpacity: opacity, strokeWeight: weight, fillOpacity: 0,
  });
}

// 帶方向箭頭的路線
function drawRoute(path, { color, opacity, weight, zIndex }) {
  return new google.maps.Polyline({
    map,
    path,
    geodesic: true,
    strokeColor: color,
    strokeOpacity: opacity,
    strokeWeight: weight,
    zIndex,
    icons: [{
      icon: { path: google.maps.SymbolPath.FORWARD_OPEN_ARROW, scale: 2.5, strokeColor: color },
      offset: '50%',
      repeat: '160px',
    }],
  });
}

// 移除 createMarker / drawCircle / drawRoute 建立的物件
function removeFromMap(objects) {
  objects.forEach((o) => {
    if (typeof o.setMap === 'function') o.setMap(null);
    else o.map = null;
  });
}

// ---------------------------------------------------------------------------
// 資訊視窗
// ---------------------------------------------------------------------------

// 有 anchor（標記）時接在標記上，否則顯示在 position；photo 為帶有 details 的地點
function openInfoWindow(content, { photo = null, position, anchor } = {}) {
  infoWindow.setContent(content);
  setInfoWindowPhoto(photo);
  if (anchor) {
    infoWindow.open({ map, anchor });
  } else {
    infoWindow.setPosition(position);
    infoWindow.open({ map });
  }
}

// 照片放在標題列，與關閉按鈕同一排以節省高度
function setInfoWindowPhoto(p) {
  const d = p?.details;
  if (!d?.photo) {
    infoWindow.setHeaderContent(null);
    return;
  }
  const img = document.createElement('img');
  img.className = 'iw-photo';
  img.src = d.photo;
  img.alt = '';
  if (d.photoCredit) img.title = `相片：${d.photoCredit}`;
  infoWindow.setHeaderContent(img);
}

function closeInfoWindow() {
  infoWindow?.close();
}

// 資訊視窗目前顯示的是否還是這個內容（使用者可能已經點了別的地點）
function isInfoWindowShowing(content) {
  return infoWindow?.getContent() === content;
}
