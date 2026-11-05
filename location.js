'use strict';

// ===========================================================================
// 目前位置：在地圖上即時顯示裝置的位置（藍點）與準確度範圍。
// 開關存在這個瀏覽器（localStorage），和目前開啟的專案無關；預設關閉。
// 位置只在畫面上使用，不會寫進專案、推送或出現在分享連結中。
// 頁面切到背景時暫停定位以節省電力，回到前景再繼續。
// ===========================================================================

const SHOW_LOCATION_KEY = 'map-planner-show-location';
const LOCATION_COLOR = '#1a73e8';

let locationOn = false;
let locationWatchId = null;
// 最後一次取得的位置 { lat, lng, accuracy }
let lastLocation = null;
let locationMarker = null;
let accuracyCircle = null;
// 這次是使用者剛打開開關：取得第一個位置時把地圖移過去（重新整理頁面後自動開啟時不移動）
let panToNextLocation = false;
// 暫時無法定位的提示只顯示一次，直到再次定位成功
let locationErrorShown = false;

const locationEls = { toggle: $('#showLocation') };

function loadLocationSetting() {
  try { return localStorage.getItem(SHOW_LOCATION_KEY) === '1'; } catch { return false; }
}

function saveLocationSetting(on) {
  try {
    if (on) localStorage.setItem(SHOW_LOCATION_KEY, '1');
    else localStorage.removeItem(SHOW_LOCATION_KEY);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 地圖上的藍點與準確度範圍
// ---------------------------------------------------------------------------

function locationDot() {
  const el = document.createElement('div');
  el.className = 'my-location';
  el.innerHTML = '<span class="my-location-pulse"></span><span class="my-location-dot"></span>';
  return el;
}

// 依 lastLocation 建立或移動藍點；地圖還沒載入時等 initMap 呼叫
function drawLocation() {
  if (!mapReady() || !locationOn || !lastLocation) return;
  const pos = { lat: lastLocation.lat, lng: lastLocation.lng };
  if (locationMarker) {
    moveMarker(locationMarker, pos);
    moveCircle(accuracyCircle, pos, lastLocation.accuracy);
  } else {
    // 準確度範圍只填色、不畫外框
    accuracyCircle = drawCircle({ center: pos, radius: lastLocation.accuracy, color: LOCATION_COLOR, opacity: 0, weight: 0, fillOpacity: 0.12, zIndex: 1 });
    // 不可點選：避免點到藍點時出現焦點外框
    locationMarker = createMarker({ position: pos, content: locationDot(), title: '目前位置', zIndex: 5000, clickable: false });
  }
  if (panToNextLocation) {
    panToNextLocation = false;
    panMapTo(pos, 15);
  }
}

function clearLocationFromMap() {
  if (locationMarker) removeFromMap([locationMarker, accuracyCircle]);
  locationMarker = null;
  accuracyCircle = null;
}

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------

function onLocation(pos) {
  locationErrorShown = false;
  lastLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  drawLocation();
}

function onLocationError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    setLocationOn(false);
    toast('無法取得位置：定位權限被拒絕，請到瀏覽器或系統設定允許這個網站使用位置', 5000);
    return;
  }
  // 暫時收不到訊號或逾時：繼續等待下一次更新
  if (!locationErrorShown) {
    locationErrorShown = true;
    toast('暫時無法取得目前位置，會持續嘗試', 3000);
  }
}

function startWatching() {
  if (locationWatchId !== null) return;
  locationWatchId = navigator.geolocation.watchPosition(onLocation, onLocationError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
}

function stopWatching() {
  if (locationWatchId === null) return;
  navigator.geolocation.clearWatch(locationWatchId);
  locationWatchId = null;
}

function setLocationOn(on, { userAction = false } = {}) {
  if (on && !('geolocation' in navigator && window.isSecureContext)) {
    toast('這個瀏覽器無法定位（需要 HTTPS 連線）', 4000);
    on = false;
  }
  locationOn = on;
  locationEls.toggle.checked = on;
  saveLocationSetting(on);
  if (on) {
    panToNextLocation = userAction;
    // 已有位置（例如剛關掉又打開）時先畫上去，同時等待新的位置
    if (userAction && lastLocation) drawLocation();
    if (!document.hidden) startWatching();
  } else {
    stopWatching();
    clearLocationFromMap();
    lastLocation = null;
    panToNextLocation = false;
  }
}

locationEls.toggle.addEventListener('change', () => {
  setLocationOn(locationEls.toggle.checked, { userAction: true });
  if (locationOn) toast('正在取得目前位置…');
});

// 切到背景時暫停，回到前景時繼續
document.addEventListener('visibilitychange', () => {
  if (!locationOn) return;
  if (document.hidden) stopWatching();
  else startWatching();
});

setLocationOn(loadLocationSetting());
