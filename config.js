// Google Maps 設定（release 版不含金鑰：請用網址 #key=… 帶入）
// 前端金鑰會暴露在瀏覽器中，請到 Google Cloud Console 設定 HTTP referrer 限制。
window.APP_CONFIG = {
  googleMapsApiKey: '',
  // Advanced Markers 需要 Map ID；DEMO_MAP_ID 可用於開發，正式環境請換成自己的 Map ID
  mapId: 'DEMO_MAP_ID',
  // 搜尋與地點資訊使用哪個 Places API：'legacy'（Places API）或 'new'（Places API (New)）
  placesApi: 'legacy',
  defaultCenter: { lat: 25.0478, lng: 121.5319 },
  defaultZoom: 12,
};
