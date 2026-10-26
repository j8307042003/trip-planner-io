'use strict';

// ===========================================================================
// 畫面（DOM）與操作流程：渲染疊加在地圖上的介面、處理事件、決定地圖上要畫什麼。
// 資料結構與工具在 store.js；Google Maps 的請求、操作與解析在 gmaps.js。
// ===========================================================================

const NEW_SECTION = '__new__';
const REPLACE_CENTER = '__center__';
const $ = (sel) => document.querySelector(sel);
const isWide = () => window.innerWidth >= 900;
// 與 styles.css 的手機斷點一致
const isMobile = () => window.innerWidth <= 600;
const PLACES_PER_PAGE = 6; // 手機地點清單：3 欄 × 2 列

// Material Symbols 圖示（index.html 載入的字型只包含 collections_bookmark、delete、directions、edit、event）
function msIcon(name) {
  return `<span class="material-symbols-outlined ms-${name}" aria-hidden="true">${name}</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// 介面狀態（不儲存）
// ---------------------------------------------------------------------------

let expandedPlaceId = null;
// 正在編輯的區塊；其他區塊只顯示唯讀內容
let editingSectionId = null;
// 地點庫中正在編輯的分類
let editingCollectionId = null;
// 手機上點選區塊後，地點面板要按按鈕才展開；記錄展開中的區塊
let placesOpenId = null;
// 「從地點庫加入」的挑選狀態：{ sectionId 或 collectionId, filter: 分類 id 或 null（全部）, selected: Set<key> }
// 目標是行程中的區塊，或地點庫中的分類（從其他分類加入）
let picker = null;
// 正在編輯目前這天的名稱
let editingDayName = false;
// 編輯區塊時按了「更換中心」：下一個選到的地點預設設為新中心（離開編輯即失效）
let replacingCenterId = null;
const isReplacingCenter = (sec) => replacingCenterId === sec.id && editingSectionId === sec.id;

function save() {
  if (!saveState()) toast('無法儲存到瀏覽器（儲存空間不足或被封鎖）');
}

function commit({ fit = false } = {}) {
  save();
  render();
  renderMap({ fit });
}

// state 整個換掉後（匯入、切換專案、切換遠端版本）：清掉介面狀態並重繪
function afterStateReplaced() {
  expandedPlaceId = null;
  editingSectionId = null;
  editingCollectionId = null;
  placesOpenId = null;
  picker = null;
  editingDayName = false;
  replacingCenterId = null;
  libImport = null;
  libImportMenuOpen = false;
  closeInfoWindow();
  commit({ fit: 'day' });
}

function selectDay(day) {
  state.activeDayId = day.id;
  state.activeSectionId = null;
  state.dayOpen = true;
  expandedPlaceId = null;
  editingSectionId = null;
  editingDayName = false;
  picker = null;
  closeInfoWindow();
  commit({ fit: 'day' });
}

// 退回天數選擇：收起區塊，展開天數時間軸
function backToDays() {
  state.dayOpen = false;
  state.activeSectionId = null;
  expandedPlaceId = null;
  editingSectionId = null;
  editingDayName = false;
  picker = null;
  closeInfoWindow();
  commit({ fit: 'day' });
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  expandedPlaceId = null;
  editingSectionId = null;
  picker = null;
  editingCollectionId = null;
  libImport = null;
  libImportMenuOpen = false;
  closeInfoWindow();
  commit({ fit: true });
  toast(mode === 'library' ? '已切換到地點庫' : '已切換到每日行程');
}

function selectCollection(col) {
  state.library.activeCollectionId = col ? col.id : null;
  expandedPlaceId = null;
  editingCollectionId = null;
  libImport = null;
  picker = null;
  closeInfoWindow();
  commit({ fit: true });
}

function addPlaceToCollection(col, candidate) {
  if (candidate.placeId && col.places.some((p) => p.placeId === candidate.placeId)) {
    toast(`「${candidate.name}」已在「${col.name}」中`);
    return;
  }
  const place = toPlace({ ...candidate, id: uid() });
  col.places.push(place);
  state.library.activeCollectionId = col.id;
  expandedPlaceId = null;
  commit();
  scrollToPlace(place.id);
  toast(`已加入「${col.name}」：${place.name}`);
}

function selectSection(sec) {
  state.activeSectionId = sec ? sec.id : null;
  expandedPlaceId = null;
  editingSectionId = null;
  picker = null;
  placesOpenId = null;
  closeInfoWindow();
  commit({ fit: sec ? 'section' : 'day' });
}

function addSection(day, candidate) {
  const sec = newSection(candidate);
  day.sections.push(sec);
  state.activeDayId = day.id;
  state.activeSectionId = sec.id;
  state.dayOpen = true;
  expandedPlaceId = null;
  commit({ fit: 'section' });
  toast(`已建立區塊：${sectionName(sec)}`);
}

// 以新地點取代區塊中心；保留原中心自己填的時間與備註，區塊名稱沿用中心名稱時一起更新
function replaceCenter(sec, candidate) {
  const old = sec.center;
  sec.center = toPlace({ ...candidate, id: uid(), time: old.time, note: old.note });
  if (sec.name === old.name) sec.name = sec.center.name;
  replacingCenterId = null;
  commit({ fit: 'section' });
  toast(`已將中心改為「${sec.center.name}」`);
}

function addPlaceToSection(day, sec, candidate) {
  const place = toPlace({ ...candidate, id: uid() });
  sec.places.push(place);
  state.activeDayId = day.id;
  state.activeSectionId = sec.id;
  state.dayOpen = true;
  expandedPlaceId = null;
  placesOpenId = sec.id;
  commit();
  scrollToPlace(place.id);
  toast(`已加入「${sectionName(sec)}」：${place.name}`);
}

// ---------------------------------------------------------------------------
// Overlay rendering
// ---------------------------------------------------------------------------

const els = {
  overlay: $('#overlay'),
  timeline: $('#timeline'),
  dayPanel: $('#dayPanel'),
  libraryPanel: $('#libraryPanel'),
  menu: $('#menu'),
  tripTitle: $('#tripTitle'),
  startDate: $('#startDate'),
  showAll: $('#showAll'),
  projectSelect: $('#projectSelect'),
};

let sortables = [];

function render() {
  document.title = `${state.title || '旅程'} · 旅程地圖規劃`;
  if (isLibrary()) {
    // 地點庫模式不顯示每日行程介面
    els.timeline.hidden = true;
    els.dayPanel.hidden = true;
    els.dayPanel.innerHTML = '';
    renderLibraryPanel();
    updatePickerUI();
    return;
  }
  els.libraryPanel.hidden = true;
  els.libraryPanel.innerHTML = '';
  renderTimeline();
  renderDayPanel();
  updatePickerUI();
}

// 只重繪目前模式的面板（不動地圖）
function renderPanel() {
  if (isLibrary()) renderLibraryPanel();
  else renderDayPanel();
  updatePickerUI();
}

function renderTimeline() {
  // 已選定某一天時，天數時間軸收起，改由區塊卡片上方的當日資訊列退回
  els.timeline.hidden = state.dayOpen;
  if (state.dayOpen) return;
  const dots = state.days.map((day, i) => `
    ${i > 0 ? '<span class="day-link"></span>' : ''}
    <button class="day-dot ${day.id === state.activeDayId ? 'active' : ''} ${day.name ? 'named' : ''}" data-day-id="${day.id}"
      style="--day-color:${dayColor(day)}" title="${esc(dayOptionLabel(day))}">${day.name ? esc(day.name) : i + 1}</button>`).join('');
  els.timeline.innerHTML = `${dots}<span class="day-link"></span><button class="day-dot add" data-action="add-day" title="新增一天">＋</button>`;
  els.timeline.querySelector('.day-dot.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderDayPanel() {
  sortables.forEach((s) => s.destroy());
  sortables = [];
  const panel = els.dayPanel;
  panel.hidden = !state.dayOpen;
  if (!state.dayOpen) {
    panel.innerHTML = '';
    return;
  }

  const day = activeDay();
  const sec = activeSection();
  const dayNav = directionsUrl(day.sections.map((s) => s.center));
  panel.style.setProperty('--day-color', dayColor(day));
  // 重繪時保留地點分頁的位置
  const prevPages = panel.querySelector('.place-pages');
  const prevPageScroll = prevPages && prevPages.dataset.sectionId === sec?.id ? prevPages.scrollLeft : 0;

  // 手機：地點面板預設收起，用按鈕展開；編輯或挑選中一律展開
  const mobileToggle = sec && isMobile();
  if (mobileToggle && (editingSectionId === sec.id || picker?.sectionId === sec.id)) placesOpenId = sec.id;
  const showDetail = sec && (!mobileToggle || placesOpenId === sec.id);
  const toggleBar = mobileToggle ? `
    <button class="places-toggle" data-action="toggle-places" aria-expanded="${showDetail}">
      <span>📍 ${esc(sectionName(sec))} · ${sec.places.length} 個地點</span>
      <span class="places-toggle-hint">${showDetail ? '收起 ▴' : '顯示 ▾'}</span>
    </button>` : '';

  // 當日資訊列 + 區塊列（樣式同天數時間軸）；點選區塊後才在下方顯示該區塊的地點
  panel.innerHTML = `
    <div class="day-card">
      <div class="day-head">
        <button class="day-back" data-action="back-to-days" title="回到天數選擇">
          <span class="back-arrow">‹</span>
          <span class="day-dot active small">${dayIndex(day) + 1}</span>
          <span class="day-back-text"><b>${esc(dayLabel(day))}</b>${dayDate(day) ? `<small>${esc(dayDate(day))}</small>` : ''}</span>
        </button>
        <input class="dp-title" data-field="day-title" placeholder="這天的主題" value="${esc(day.title)}">
        <button class="icon-btn" data-action="edit-day-name" title="自訂這天的名稱">${msIcon('edit')}</button>
        ${dayNav ? `<a class="icon-btn nav-btn" href="${esc(dayNav)}" target="_blank" rel="noopener" title="在 Google 地圖開啟當日路線">${msIcon('directions')}</a>` : ''}
        <button class="icon-btn" data-action="delete-day" title="刪除這一天" ${state.days.length <= 1 ? 'disabled' : ''}>${msIcon('delete')}</button>
      </div>
      ${editingDayName ? `
        <div class="day-name-edit">
          <span>名稱</span>
          <input class="dp-name" data-field="day-name" maxlength="12" placeholder="${esc(dayNumLabel(day))}" value="${esc(day.name)}" aria-label="這天的名稱">
          ${day.name ? '<button class="btn small" data-action="reset-day-name">恢復預設</button>' : ''}
          <button class="btn primary small" data-action="done-day-name">完成</button>
        </div>` : ''}
      <div class="sections" id="sectionList">
        ${day.sections.map((s, i) => renderSectionCard(s, i, s === sec)).join('')}
        <button class="section-card add" data-action="add-section"><span>＋</span>新增區塊</button>
        ${day.sections.length ? '' : '<span class="sections-hint">搜尋或點選地圖上的地點<br>建立第一個區塊</span>'}
      </div>
    </div>
    ${toggleBar}
    ${showDetail ? renderSectionDetail(day, sec) : ''}`;

  const sectionList = panel.querySelector('#sectionList');
  enableDragScroll(sectionList);
  const pages = panel.querySelector('.place-pages');
  if (pages) {
    pages.scrollLeft = prevPageScroll;
    enablePageDots(pages);
  }
  if (window.Sortable) {
    const placeList = panel.querySelector('#placeList');
    if (placeList && sec && editingSectionId === sec.id) {
      sortables.push(Sortable.create(placeList, {
        handle: '.handle',
        animation: 150,
        onEnd(evt) {
          if (evt.oldIndex === evt.newIndex) return;
          const [moved] = sec.places.splice(evt.oldIndex, 1);
          sec.places.splice(evt.newIndex, 0, moved);
          commit();
        },
      }));
    }
  }
  sectionList.querySelector('.section-card.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// 區塊列：滑鼠拖曳與滾輪也能左右滑動（觸控裝置原生支援滑動）
function enableDragScroll(el) {
  let startX = 0;
  let startScroll = 0;
  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    startX = e.clientX;
    startScroll = el.scrollLeft;
    dragging = false;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) < 5) return;
      dragging = true;
      el.classList.add('dragging');
      el.scrollLeft = startScroll - dx;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.classList.remove('dragging');
      // 拖曳結束時不要觸發區塊的點擊
      if (dragging) {
        const block = (ev) => ev.stopPropagation();
        el.addEventListener('click', block, { capture: true, once: true });
        setTimeout(() => el.removeEventListener('click', block, { capture: true }), 0);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  el.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, { passive: false });
}

function renderSectionCard(sec, i, active) {
  return `
    <div class="section-card ${active ? 'active' : ''}" data-section-id="${sec.id}" title="${esc(sec.center.address)}">
      <div class="sc-top">
        <span class="sc-num">${i + 1}</span>
        <span class="sc-time">${esc(sec.time)}</span>
        ${active ? `<button class="sc-edit" data-action="edit-section" title="編輯區塊">${msIcon('edit')}</button>` : ''}
      </div>
      <div class="sc-name">${esc(sectionName(sec))}</div>
      <div class="sc-meta">${sec.places.length ? `${sec.places.length} 個周邊地點` : '尚無周邊地點'}</div>
    </div>`;
}

function renderSectionDetail(day, sec) {
  const idx = day.sections.indexOf(sec);
  const editing = editingSectionId === sec.id;
  const renderItem = editing ? renderPlaceEditor : renderPlace;
  let places = '<div class="sd-empty">搜尋或點選地圖上的地點，加入到這個區塊</div>';
  if (sec.places.length && !editing && isMobile()) places = renderPlacePages(sec);
  else if (sec.places.length) places = `<ol class="places" id="placeList">${sec.places.map((p, i) => renderItem(p, i)).join('')}</ol>`;

  const head = editing ? `
      <div class="sd-head">
        <span class="sc-num">${idx + 1}</span>
        <input class="sd-name" data-field="section-name" value="${esc(sec.name)}" placeholder="${esc(sec.center.name)}" aria-label="區塊名稱">
        ${timeInput('class="sd-time" data-field="section-time" aria-label="抵達時間"', sec.time)}
        <button class="btn primary small" data-action="done-edit">完成</button>
      </div>` : '';

  if (picker?.sectionId === sec.id) return `<div class="section-detail">${renderLibraryPicker(sec)}</div>`;

  const center = `
      <button class="sd-center" data-action="focus-center">
        <span class="sd-center-icon">◎</span>
        <span class="sd-center-text"><b>${esc(sec.center.name)}</b></span>
        <span class="sd-center-label">中心</span>
      </button>`;
  const replacing = isReplacingCenter(sec);
  // 編輯模式：可更換中心點（搜尋或點地圖選新地點；也可用周邊地點的「設為區塊中心」互換）
  const centerRow = editing ? `
      <div class="sd-center-row">
        ${center}
        <button class="btn small ${replacing ? '' : 'primary'}" data-action="change-center">${replacing ? '取消' : '更換中心'}</button>
      </div>
      ${replacing ? '<div class="sd-hint">🔍 搜尋或點選地圖上的地點，作為新的中心點</div>' : ''}` : center;

  return `
    <div class="section-detail">
      ${head}
      ${centerRow}
      ${places}
      <button class="sd-add-lib" data-action="open-picker">${msIcon('collections_bookmark')}從地點庫加入</button>
    </div>`;
}

// ---------- 從地點庫挑選地點加入區塊 ----------

// 挑選的目標：行程中的區塊（picker.sectionId），或地點庫中的分類（picker.collectionId）
function pickerOwner() {
  if (!picker) return null;
  if (picker.collectionId) return state.library.collections.find((c) => c.id === picker.collectionId) || null;
  return activeSection();
}
const isCollection = (owner) => !owner.center;
const ownerName = (owner) => (isCollection(owner) ? owner.name : sectionName(owner));

// 目標是分類時，只列出其他分類的地點、也只篩選其他分類
function pickerCollections(owner) {
  return state.library.collections.filter((c) => c !== owner && c.places.length);
}

function pickerSource(owner) {
  return libraryEntries().filter((e) => !isCollection(owner) || e.collections.some((c) => c !== owner));
}

// 目前篩選下的項目；已在目標中的地點標記為不可選
function pickerEntries(owner) {
  const inOwner = new Set((isCollection(owner) ? owner.places : [owner.center, ...owner.places]).map(placeKey));
  return pickerSource(owner)
    .filter((e) => !picker.filter || e.collections.some((c) => c.id === picker.filter))
    .map((e) => ({ ...e, added: inOwner.has(e.key) }));
}

function renderLibraryPicker(owner) {
  const title = `${msIcon('collections_bookmark')}${isCollection(owner) ? '從其他分類加入' : '從地點庫加入'}`;
  const head = `<div class="picker-head"><b>${title}</b><button class="icon-btn" data-action="close-picker" title="關閉">✕</button></div>`;
  const all = pickerSource(owner);
  if (!all.length) {
    return `${head}<div class="sd-empty">${isCollection(owner)
      ? '其他分類還沒有地點'
      : '地點庫還沒有地點<br>可在選單切換到「地點庫」模式新增'}</div>`;
  }
  const entries = pickerEntries(owner);
  const chip = (col, label, count) => `
    <button class="picker-chip ${picker.filter === (col?.id ?? null) ? 'active' : ''}" data-action="picker-filter" data-filter="${col?.id || ''}"
      ${col ? `style="--chip-color:${collectionColor(col)}"` : ''}>${esc(label)} <small>${count}</small></button>`;

  return `
    ${head}
    <div class="picker-filters">
      ${chip(null, '全部', all.length)}
      ${pickerCollections(owner).map((c) => chip(c, c.name, c.places.length)).join('')}
    </div>
    <label class="picker-all"><input type="checkbox" data-pick-all> 全選</label>
    <ul class="picker-list">
      ${entries.map((e) => `
        <li>
          <label class="picker-item ${e.added ? 'added' : ''}">
            <input type="checkbox" data-pick-key="${esc(e.key)}" ${e.added ? 'disabled' : ''} ${picker.selected.has(e.key) ? 'checked' : ''}>
            ${renderPlaceIcon(e.place)}
            <span class="picker-name">${esc(e.place.name)}</span>
            ${e.added ? '<span class="picker-tag">已加入</span>'
              : `<span class="picker-cols">${e.collections.filter((c) => c !== owner).map((c) => `<span class="dot" style="--day-color:${collectionColor(c)}" title="${esc(c.name)}"></span>`).join('')}</span>`}
          </label>
        </li>`).join('') || '<li class="sd-empty">這個分類沒有地點</li>'}
    </ul>
    <div class="picker-actions">
      <button class="btn" data-action="close-picker">取消</button>
      <button class="btn primary" data-action="picker-add">加入</button>
    </div>`;
}

// 依挑選狀態更新全選框與加入按鈕（不重繪清單，保留捲動位置）
function updatePickerUI() {
  const owner = pickerOwner();
  if (!owner) return;
  const panel = isLibrary() ? els.libraryPanel : els.dayPanel;
  const selectable = pickerEntries(owner).filter((e) => !e.added);
  const chosen = selectable.filter((e) => picker.selected.has(e.key)).length;
  const allBox = panel.querySelector('[data-pick-all]');
  if (allBox) {
    allBox.checked = selectable.length > 0 && chosen === selectable.length;
    allBox.indeterminate = chosen > 0 && chosen < selectable.length;
    allBox.disabled = selectable.length === 0;
  }
  panel.querySelectorAll('[data-pick-key]').forEach((box) => { box.checked = picker.selected.has(box.dataset.pickKey); });
  const addBtn = panel.querySelector('[data-action="picker-add"]');
  if (addBtn) {
    addBtn.disabled = picker.selected.size === 0;
    addBtn.textContent = picker.selected.size ? `加入 ${picker.selected.size} 個地點` : '加入';
  }
}

// 複製地點到目標；行程中的時間另外安排，所以清空
function addPickedPlaces(owner) {
  const entries = libraryEntries().filter((e) => picker.selected.has(e.key));
  entries.forEach((e) => owner.places.push(toPlace({ ...e.place, id: uid(), time: '' })));
  picker = null;
  commit({ fit: isCollection(owner) ? true : 'section' });
  toast(`已加入 ${entries.length} 個地點到「${ownerName(owner)}」`);
}

// 優先使用 Google 地圖的分類圖示（與 Google 地圖上顯示的相同），否則用備用 emoji
function renderPlaceIcon(p) {
  const cat = placeCategory(p);
  if (p.icon?.mask) {
    return `<span class="place-icon google" title="${cat.label}" style="--icon-bg:${esc(p.icon.bg || '#7b9eb0')}">`
      + `<span style="--icon-mask:url('${esc(p.icon.mask)}')"></span></span>`;
  }
  return `<span class="place-icon" title="${cat.label}">${cat.icon}</span>`;
}

function renderPlace(p, i) {
  return `
    <li class="place ${p.id === expandedPlaceId ? 'highlight' : ''}" data-place-id="${p.id}">
      <div class="place-head" data-action="focus-place">
        ${renderPlaceIcon(p)}
        <span class="place-num">${i + 1}</span>
        <div class="place-text">
          <div class="place-name">${esc(p.name)}</div>
          <div class="place-sub">${esc(p.note)}</div>
        </div>
        ${p.time ? `<span class="place-time-text">${esc(p.time)}</span>` : ''}
      </div>
    </li>`;
}

// 手機版地點清單：每頁 3 × 2 格，左右滑動換頁
function renderPlacePages(sec) {
  const pages = [];
  for (let i = 0; i < sec.places.length; i += PLACES_PER_PAGE) pages.push(sec.places.slice(i, i + PLACES_PER_PAGE));
  const tiles = (list, offset) => list.map((p, k) => `
    <button class="place-tile ${p.id === expandedPlaceId ? 'highlight' : ''}" data-place-id="${p.id}" data-action="focus-place"
      title="${offset + k + 1}. ${esc(p.name)}${p.time ? ` · ${esc(p.time)}` : ''}">
      ${renderPlaceIcon(p)}
      <span class="tile-name">${esc(p.name)}</span>
    </button>`).join('');
  return `
    <div class="place-pages" data-section-id="${sec.id}">
      ${pages.map((list, i) => `<div class="place-page">${tiles(list, i * PLACES_PER_PAGE)}</div>`).join('')}
    </div>
    ${pages.length > 1 ? `<div class="page-dots">${pages.map((_, i) => `<span class="${i === 0 ? 'active' : ''}"></span>`).join('')}</div>` : ''}`;
}

// 依捲動位置標示目前頁
function enablePageDots(pages) {
  const dots = pages.nextElementSibling?.classList.contains('page-dots') ? [...pages.nextElementSibling.children] : [];
  const update = () => {
    const index = Math.round(pages.scrollLeft / pages.clientWidth);
    dots.forEach((d, i) => d.classList.toggle('active', i === index));
  };
  pages.addEventListener('scroll', update, { passive: true });
  update();
}

function renderPlaceEditor(p, i) {
  const expanded = p.id === expandedPlaceId;
  return `
    <li class="place ${expanded ? 'expanded' : ''}" data-place-id="${p.id}">
      <div class="place-head" data-action="toggle-place">
        <span class="handle" title="拖曳排序">⠿</span>
        ${renderPlaceIcon(p)}
        <span class="place-num">${i + 1}</span>
        ${timeInput('class="place-time" data-field="place-time" aria-label="時間"', p.time)}
        <div class="place-text">
          <div class="place-name">${esc(p.name)}</div>
          <div class="place-sub">${esc(p.note)}</div>
        </div>
        <button class="icon-btn" data-action="delete-place" title="刪除">${msIcon('delete')}</button>
      </div>
      ${expanded ? `
        <div class="place-body">
          <label>名稱<input data-field="place-name" value="${esc(p.name)}"></label>
          <label>備註<textarea data-field="place-note" placeholder="門票、訂位、營業時間…">${esc(p.note)}</textarea></label>
          <div><button class="btn" data-action="set-center">◎ 設為區塊中心</button></div>
        </div>` : ''}
    </li>`;
}

// ---------- 地點庫 ----------

function renderLibraryPanel() {
  sortables.forEach((s) => s.destroy());
  sortables = [];
  const panel = els.libraryPanel;
  panel.hidden = false;
  const cols = state.library.collections;
  const col = activeCollection();

  panel.innerHTML = `
    <div class="day-card">
      <div class="library-head">
        <b>${msIcon('collections_bookmark')}地點庫</b>
        <span>${cols.length} 個分類 · ${cols.reduce((n, c) => n + c.places.length, 0)} 個地點</span>
        <button class="btn small lib-import" data-action="toggle-lib-import" aria-expanded="${libImportMenuOpen}"
          ${importingSavedList ? 'disabled' : ''}>${importingSavedList ? '匯入中…' : `匯入 ${libImportMenuOpen ? '▴' : '▾'}`}</button>
      </div>
      ${libImportMenuOpen ? `
        <div class="lib-import-menu">
          <button class="btn" data-action="import-saved-list" title="Google Takeout 匯出的「已儲存」清單 CSV，可多選">📍 Google 地圖清單 (.csv)</button>
          <button class="btn" data-action="import-library" title="本工具「匯出」的 JSON 檔，只匯入其中的地點庫">${msIcon('collections_bookmark')}其他地點庫 (.json)</button>
        </div>` : ''}
      <div class="sections collections" id="collectionList">
        ${cols.map((c, i) => renderCollectionCard(c, i, c === col)).join('')}
        <button class="section-card add" data-action="add-collection"><span>＋</span>新增分類</button>
        ${cols.length ? '' : '<span class="sections-hint">建立分類後，搜尋或<br>點選地圖上的地點加入</span>'}
      </div>
    </div>
    ${libImport ? renderLibraryImport() : col ? renderCollectionDetail(col) : ''}`;

  const list = panel.querySelector('#collectionList');
  enableDragScroll(list);
  const placeList = panel.querySelector('#placeList');
  if (window.Sortable && placeList && col && editingCollectionId === col.id) {
    sortables.push(Sortable.create(placeList, {
      handle: '.handle',
      animation: 150,
      onEnd(evt) {
        if (evt.oldIndex === evt.newIndex) return;
        const [moved] = col.places.splice(evt.oldIndex, 1);
        col.places.splice(evt.newIndex, 0, moved);
        commit();
      },
    }));
  }
  list.querySelector('.section-card.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderCollectionCard(col, i, active) {
  return `
    <div class="section-card ${active ? 'active' : ''}" data-collection-id="${col.id}" style="--day-color:${collectionColor(col)}">
      <div class="sc-top">
        <span class="sc-num">${i + 1}</span>
        ${active ? `<button class="sc-edit" data-action="edit-collection" title="編輯分類">${msIcon('edit')}</button>` : ''}
      </div>
      <div class="sc-name">${esc(col.name)}</div>
      <div class="sc-meta">${col.places.length ? `${col.places.length} 個地點` : '尚無地點'}</div>
    </div>`;
}

function renderCollectionDetail(col) {
  const editing = editingCollectionId === col.id;
  const head = editing ? `
      <div class="sd-head">
        <input class="sd-name" data-field="collection-name" value="${esc(col.name)}" placeholder="分類名稱" aria-label="分類名稱">
        <button class="btn danger small" data-action="delete-collection">刪除分類</button>
        <button class="btn primary small" data-action="done-edit-collection">完成</button>
      </div>` : '';
  if (picker?.collectionId === col.id) {
    return `<div class="section-detail" style="--day-color:${collectionColor(col)}">${renderLibraryPicker(col)}</div>`;
  }
  const items = col.places.length
    ? `<ol class="places" id="placeList">${col.places.map((p) => (editing ? renderLibraryPlaceEditor(p) : renderLibraryPlace(p))).join('')}</ol>`
    : '<div class="sd-empty">搜尋或點選地圖上的地點，加入到這個分類</div>';
  // 其他分類有地點時，可以從中挑選複製到這個分類
  const fromOthers = pickerCollections(col).length
    ? `<button class="sd-add-lib" data-action="open-col-picker">${msIcon('collections_bookmark')}從其他分類加入</button>` : '';
  return `<div class="section-detail" style="--day-color:${collectionColor(col)}">${head}${items}${fromOthers}</div>`;
}

function renderLibraryPlace(p) {
  return `
    <li class="place ${p.id === expandedPlaceId ? 'highlight' : ''}" data-place-id="${p.id}">
      <div class="place-head" data-action="focus-place">
        ${renderPlaceIcon(p)}
        <div class="place-text">
          <div class="place-name">${esc(p.name)}</div>
          <div class="place-sub">${esc(p.note)}</div>
        </div>
      </div>
    </li>`;
}

function renderLibraryPlaceEditor(p) {
  const expanded = p.id === expandedPlaceId;
  return `
    <li class="place ${expanded ? 'expanded' : ''}" data-place-id="${p.id}">
      <div class="place-head" data-action="toggle-place">
        <span class="handle" title="拖曳排序">⠿</span>
        ${renderPlaceIcon(p)}
        <div class="place-text">
          <div class="place-name">${esc(p.name)}</div>
          <div class="place-sub">${esc(p.note)}</div>
        </div>
        <button class="icon-btn" data-action="delete-place" title="刪除">${msIcon('delete')}</button>
      </div>
      ${expanded ? `
        <div class="place-body">
          <label>名稱<input data-field="place-name" value="${esc(p.name)}"></label>
          <label>備註<textarea data-field="place-note" placeholder="想去的原因、營業時間…">${esc(p.note)}</textarea></label>
        </div>` : ''}
    </li>`;
}

function scrollToPlace(placeId) {
  const tile = els.overlay.querySelector(`.place-tile[data-place-id="${placeId}"]`);
  if (tile) {
    const pages = tile.closest('.place-pages');
    pages.scrollTo({ left: tile.closest('.place-page').offsetLeft, behavior: 'smooth' });
    return;
  }
  els.overlay.querySelector(`[data-place-id="${placeId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Overlay events
// ---------------------------------------------------------------------------

els.overlay.addEventListener('click', (e) => {
  const dot = e.target.closest('.day-dot[data-day-id]');
  if (dot) {
    selectDay(findDay(dot.dataset.dayId));
    return;
  }

  const colCard = e.target.closest('.section-card[data-collection-id]');
  if (colCard && !e.target.closest('[data-action]')) {
    const target = state.library.collections.find((c) => c.id === colCard.dataset.collectionId);
    selectCollection(target === activeCollection() ? null : target);
    return;
  }

  const day = activeDay();
  const sec = activeSection();
  const card = e.target.closest('.section-card[data-section-id]');
  if (card && !e.target.closest('[data-action]')) {
    const target = day.sections.find((s) => s.id === card.dataset.sectionId);
    selectSection(target === sec ? null : target);
    return;
  }

  const action = e.target.closest('[data-action]')?.dataset.action;
  // 地點清單的擁有者：行程中的區塊或地點庫的分類
  const owner = isLibrary() ? activeCollection() : sec;
  const placeEl = e.target.closest('[data-place-id]');
  const place = placeEl && owner?.places.find((p) => p.id === placeEl.dataset.placeId);

  switch (action) {
    case 'toggle-results':
      toggleResults();
      break;
    case 'clear-search':
      setSearch(null);
      searchEls.input.value = '';
      break;
    case 'search-area':
      runTextSearch(search.query, { area: true });
      break;
    case 'focus-result':
      focusResult(Number(e.target.closest('[data-result-index]').dataset.resultIndex));
      break;
    case 'toggle-places':
      placesOpenId = placesOpenId === sec.id ? null : sec.id;
      renderPanel();
      break;
    case 'open-picker':
      picker = { sectionId: sec.id, filter: null, selected: new Set() };
      editingSectionId = null;
      renderPanel();
      break;
    case 'close-picker':
      picker = null;
      renderPanel();
      break;
    case 'picker-filter':
      picker.filter = e.target.closest('[data-filter]').dataset.filter || null;
      renderPanel();
      break;
    case 'picker-add':
      if (picker?.selected.size && pickerOwner()) addPickedPlaces(pickerOwner());
      break;
    case 'open-col-picker':
      picker = { collectionId: state.library.activeCollectionId, filter: null, selected: new Set() };
      editingCollectionId = null;
      renderPanel();
      break;
    case 'toggle-lib-import':
      libImportMenuOpen = !libImportMenuOpen;
      renderPanel();
      break;
    case 'import-saved-list':
      libImportMenuOpen = false;
      renderPanel();
      if (!importingSavedList) $('#savedListFile').click();
      break;
    case 'import-library':
      libImportMenuOpen = false;
      renderPanel();
      $('#libraryFile').click();
      break;
    case 'close-lib-import':
      libImport = null;
      renderPanel();
      break;
    case 'confirm-lib-import':
      if (libImport?.selected.size) importLibraryCollections();
      break;
    case 'add-collection': {
      const col = createCollection();
      state.library.activeCollectionId = col.id;
      editingCollectionId = col.id;
      expandedPlaceId = null;
      commit();
      const input = els.libraryPanel.querySelector('[data-field="collection-name"]');
      input?.focus();
      input?.select();
      break;
    }
    case 'edit-collection':
      editingCollectionId = state.library.activeCollectionId;
      expandedPlaceId = null;
      picker = null;
      renderPanel();
      break;
    case 'done-edit-collection':
      editingCollectionId = null;
      expandedPlaceId = null;
      commit();
      break;
    case 'delete-collection': {
      const col = activeCollection();
      if (col.places.length && !confirm(`確定刪除分類「${col.name}」以及其中 ${col.places.length} 個地點？`)) return;
      state.library.collections = state.library.collections.filter((c) => c !== col);
      selectCollection(null);
      break;
    }
    case 'add-day': {
      const newOne = newDay();
      state.days.push(newOne);
      selectDay(newOne);
      toast(`已新增 ${dayLabel(newOne)}`);
      break;
    }
    case 'back-to-days':
      backToDays();
      break;
    case 'edit-day-name': {
      editingDayName = !editingDayName;
      renderPanel();
      const input = els.dayPanel.querySelector('[data-field="day-name"]');
      input?.focus();
      input?.select();
      break;
    }
    case 'reset-day-name':
      day.name = '';
      editingDayName = false;
      commit();
      break;
    case 'done-day-name':
      editingDayName = false;
      commit();
      break;
    case 'delete-day': {
      if (state.days.length <= 1) return;
      const count = day.sections.length;
      if (count && !confirm(`確定刪除 ${dayLabel(day)} 以及其中 ${count} 個區塊？`)) return;
      const i = dayIndex(day);
      state.days.splice(i, 1);
      selectDay(state.days[Math.min(i, state.days.length - 1)]);
      break;
    }
    case 'add-section':
      state.activeSectionId = null;
      commit();
      searchEls.input.focus();
      toast('搜尋或點選地圖上的地點，作為新區塊的中心');
      break;
    case 'edit-section':
      editingSectionId = sec.id;
      expandedPlaceId = null;
      renderPanel();
      break;
    case 'done-edit':
      editingSectionId = null;
      replacingCenterId = null;
      expandedPlaceId = null;
      renderPanel();
      break;
    case 'change-center':
      replacingCenterId = isReplacingCenter(sec) ? null : sec.id;
      renderPanel();
      if (replacingCenterId && !isMobile()) searchEls.input.focus();
      break;
    case 'focus-place':
      if (!place) return;
      expandedPlaceId = place.id;
      renderPanel();
      focusPlaceOnMap(place);
      break;
    case 'focus-center':
      focusPlaceOnMap(sec.center);
      break;
    case 'delete-place':
      if (!place) return;
      owner.places = owner.places.filter((p) => p !== place);
      closeInfoWindow();
      commit();
      break;
    case 'set-center': {
      if (!place) return;
      // 與原中心互換：原中心變成區塊內的一般地點
      const oldCenter = sec.center;
      sec.places[sec.places.indexOf(place)] = oldCenter;
      sec.center = place;
      if (sec.name === oldCenter.name) sec.name = place.name;
      expandedPlaceId = null;
      commit({ fit: 'section' });
      toast(`已將「${place.name}」設為中心`);
      break;
    }
    case 'toggle-place':
      if (!place || e.target.closest('input, .handle')) return;
      expandedPlaceId = expandedPlaceId === place.id ? null : place.id;
      renderPanel();
      focusPlaceOnMap(place);
      break;
  }
});

els.overlay.addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const day = activeDay();
  const sec = activeSection();
  const col = activeCollection();
  const owner = isLibrary() ? col : sec;
  const placeEl = e.target.closest('[data-place-id]');
  const place = placeEl && owner?.places.find((p) => p.id === placeEl.dataset.placeId);
  const card = sec && els.dayPanel.querySelector(`.section-card[data-section-id="${sec.id}"]`);
  const value = e.target.value;

  switch (field) {
    case 'collection-name':
      col.name = value;
      els.libraryPanel.querySelector(`.section-card[data-collection-id="${col.id}"] .sc-name`).textContent = value;
      break;
    case 'day-title':
      day.title = value;
      break;
    case 'day-name':
      day.name = value.trim();
      els.dayPanel.querySelector('.day-back-text b').textContent = dayLabel(day);
      break;
    case 'section-name':
      sec.name = value;
      card.querySelector('.sc-name').textContent = sectionName(sec);
      break;
    case 'section-time':
      sec.time = value;
      card.querySelector('.sc-time').textContent = value;
      break;
    case 'place-time':
      place.time = value;
      break;
    case 'place-name':
      place.name = value;
      placeEl.querySelector('.place-name').textContent = value;
      break;
    case 'place-note':
      place.note = value;
      placeEl.querySelector('.place-sub').textContent = value;
      break;
    default:
      return;
  }
  save();
});

// 名稱輸入框按 Enter 完成編輯
els.overlay.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || !e.target.matches('[data-field="day-name"]')) return;
  editingDayName = false;
  commit();
});

els.overlay.addEventListener('change', (e) => {
  if (libImport && e.target.matches('[data-libimp], [data-libimp-all]')) {
    const all = libImport.collections.map((_, i) => i);
    if (e.target.matches('[data-libimp-all]')) libImport.selected = new Set(e.target.checked ? all : []);
    else if (e.target.checked) libImport.selected.add(Number(e.target.dataset.libimp));
    else libImport.selected.delete(Number(e.target.dataset.libimp));
    renderPanel();
    return;
  }
  if (picker && e.target.matches('[data-pick-key]')) {
    if (e.target.checked) picker.selected.add(e.target.dataset.pickKey);
    else picker.selected.delete(e.target.dataset.pickKey);
    updatePickerUI();
    return;
  }
  if (picker && e.target.matches('[data-pick-all]')) {
    // 全選 / 取消全選：只作用在目前篩選中可加入的地點
    const selectable = pickerEntries(pickerOwner()).filter((x) => !x.added);
    selectable.forEach((x) => (e.target.checked ? picker.selected.add(x.key) : picker.selected.delete(x.key)));
    updatePickerUI();
    return;
  }
  const field = e.target.dataset.field;
  if (field === 'section-name' || field === 'place-name' || field === 'day-name') renderMap();
});

// Menu
function openMenu() {
  document.querySelectorAll('#modeSwitch [data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
  });
  $('#tripSettings').hidden = isLibrary();
  $('#resetBtn').textContent = isLibrary() ? '清空地點庫' : '清空行程';
  els.tripTitle.value = state.title;
  els.startDate.value = state.startDate || '';
  els.showAll.checked = !!state.showAll;
  renderProjectSelect();
  renderRemotePanel();
  els.menu.hidden = false;
}

// 專案清單
function renderProjectSelect() {
  els.projectSelect.innerHTML = projects.list
    .map((p) => `<option value="${esc(p.id)}" ${p.id === projects.activeId ? 'selected' : ''}>${esc(projectTitle(p))}</option>`)
    .join('');
}

// 切換專案後重新整理選單內容（停留在選單中）
function afterProjectChanged() {
  afterStateReplaced();
  openMenu();
}
function closeMenu() { els.menu.hidden = true; }

$('#menuBtn').addEventListener('click', openMenu);
$('#modeSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-mode]');
  if (!btn) return;
  closeMenu();
  setMode(btn.dataset.mode);
});
$('#menuDone').addEventListener('click', closeMenu);
els.menu.addEventListener('click', (e) => { if (e.target === els.menu) closeMenu(); });
// Esc：關閉選單、收起搜尋結果，或往上退一層（地點 → 區塊 → 天數）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.target.matches('input, textarea, select')) return;
  if (!els.menu.hidden) closeMenu();
  else if (filtersOpen) toggleFilters(false);
  else if (search?.open) toggleResults();
  else if (isLibrary() && (libImport || picker)) { libImport = null; picker = null; renderPanel(); }
  else if (isLibrary()) { if (activeCollection()) selectCollection(null); }
  else if (picker) { picker = null; renderPanel(); }
  else if (activeSection()) selectSection(null);
  else if (state.dayOpen) backToDays();
});

els.tripTitle.addEventListener('input', () => {
  state.title = els.tripTitle.value;
  document.title = `${state.title || '旅程'} · 旅程地圖規劃`;
  save();
  renderProjectSelect();
});

els.projectSelect.addEventListener('change', () => {
  switchProject(els.projectSelect.value);
  afterProjectChanged();
  toast(`已切換到「${state.title || '未命名旅程'}」`);
});

$('#newProjectBtn').addEventListener('click', () => {
  const title = prompt('新專案名稱', '我的旅程');
  if (title === null) return;
  createProject(title.trim());
  afterProjectChanged();
  toast(`已建立專案「${state.title}」`);
});

$('#deleteProjectBtn').addEventListener('click', () => {
  const remote = state.local.remote ? `\n（遠端 ${remoteLabel(state.local.remote)} 上的檔案不會被刪除）` : '';
  if (!confirm(`確定刪除專案「${state.title || '未命名旅程'}」？此動作無法復原（可先匯出備份）。${remote}`)) return;
  deleteActiveProject();
  afterProjectChanged();
  toast(`已切換到「${state.title || '未命名旅程'}」`);
});

els.startDate.addEventListener('change', () => {
  state.startDate = els.startDate.value;
  commit();
});

els.showAll.addEventListener('change', () => {
  state.showAll = els.showAll.checked;
  save();
  renderMap({ fit: 'day' });
});

$('#exportBtn').addEventListener('click', () => {
  // local（遠端連結與所在的 commit）只屬於這個瀏覽器，不匯出
  const blob = new Blob([remoteContent(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.title || 'trip').replace(/[\\/:*?"<>|]/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = normalizeState(JSON.parse(await file.text()));
    if (!data) throw new Error('格式不符');
    if (!confirm('匯入會取代目前專案的行程，確定嗎？')) return;
    // 保留目前專案的遠端連結；匯入的內容會算成尚未推送的變更
    state = { ...data, local: state.local };
    closeMenu();
    afterStateReplaced();
    toast('匯入完成');
  } catch (err) {
    toast(`匯入失敗：${err.message}`);
  }
});

// 清空目前模式的資料：行程與地點庫互不影響
$('#resetBtn').addEventListener('click', () => {
  const what = isLibrary() ? '地點庫中所有分類與地點' : '所有行程';
  if (!confirm(`確定清空${what}？此動作無法復原（可先匯出備份）。`)) return;
  if (isLibrary()) state.library = defaultLibrary();
  else state = { ...defaultState(), library: state.library, local: state.local };
  expandedPlaceId = null;
  editingCollectionId = null;
  closeInfoWindow();
  closeMenu();
  commit({ fit: true });
});

// 跨過手機斷點時重繪面板（版面不同）
let wasMobile = isMobile();
window.addEventListener('resize', () => {
  if (isMobile() === wasMobile) return;
  wasMobile = isMobile();
  renderPanel();
});

// ---------------------------------------------------------------------------
// 時間選擇器（電腦）：24 小時制；左側上午／下午跟著所選的小時自動切換，
// 點上午／下午會把小時換到另一半天。手機維持系統原生的時間滾輪。
// 選擇時更新 input 的值並發出 input / change 事件，沿用原本欄位的處理方式。
// ---------------------------------------------------------------------------

const useTimePicker = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const MINUTE_STEP = 5;
const pad2 = (n) => String(n).padStart(2, '0');
const timePicker = { el: null, input: null };

function timeInput(attrs, value) {
  return useTimePicker()
    ? `<input type="text" readonly data-time-picker ${attrs} value="${esc(value)}" placeholder="--:--">`
    : `<input type="time" ${attrs} value="${esc(value)}">`;
}

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

function openTimePicker(input) {
  closeTimePicker();
  const el = document.createElement('div');
  el.className = 'time-picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '選擇時間');
  document.body.appendChild(el);
  Object.assign(timePicker, { el, input });
  input.classList.add('open');
  renderTimePicker();
  positionTimePicker();
  // 捲到目前選的時間；還沒選時小時欄從早上開始顯示
  el.querySelectorAll('.tp-col').forEach((col) => centerCell(col, col.querySelector('.active') || col.querySelector('[data-hour="9"]')));
}

function closeTimePicker() {
  if (!timePicker.el) return;
  timePicker.el.remove();
  timePicker.input?.classList.remove('open');
  Object.assign(timePicker, { el: null, input: null });
}

function renderTimePicker() {
  const { el, input } = timePicker;
  const t = parseTime(input.value);
  const minutes = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
  // 不在間隔上的分鐘（例如 05:52）也要能顯示為已選
  if (t && !minutes.includes(t.m)) {
    minutes.push(t.m);
    minutes.sort((a, b) => a - b);
  }
  const pm = t ? t.h >= 12 : null;
  const cell = (kind, value, label, active) =>
    `<button type="button" class="tp-cell ${active ? 'active' : ''}" data-${kind}="${value}">${label}</button>`;
  // 重繪時保留各欄的捲動位置
  const scrolls = [...el.querySelectorAll('.tp-col')].map((col) => col.scrollTop);
  el.innerHTML = `
    <div class="tp-cols">
      <div class="tp-col tp-period">${cell('period', 'am', '上午', pm === false)}${cell('period', 'pm', '下午', pm === true)}</div>
      <div class="tp-col">${Array.from({ length: 24 }, (_, h) => cell('hour', h, pad2(h), t?.h === h)).join('')}</div>
      <div class="tp-col">${minutes.map((m) => cell('minute', m, pad2(m), t?.m === m)).join('')}</div>
    </div>
    <div class="tp-foot">
      <button type="button" class="btn small" data-tp="clear">清除</button>
      <button type="button" class="btn primary small" data-tp="done">完成</button>
    </div>`;
  el.querySelectorAll('.tp-col').forEach((col, i) => { col.scrollTop = scrolls[i] || 0; });
}

function centerCell(col, cell) {
  if (cell) col.scrollTop = cell.offsetTop - (col.clientHeight - cell.offsetHeight) / 2;
}

// 放在欄位下方；下方空間不夠時改放上方
function positionTimePicker() {
  const { el, input } = timePicker;
  const r = input.getBoundingClientRect();
  let top = r.bottom + 6;
  if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 6);
  el.style.top = `${top}px`;
  el.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - el.offsetWidth - 8)}px`;
}

function setPickedTime(value) {
  const { input } = timePicker;
  if (!input.isConnected) {
    closeTimePicker();
    return;
  }
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  renderTimePicker();
}

document.addEventListener('click', (e) => {
  const input = e.target.closest('input[data-time-picker]');
  if (input) {
    if (timePicker.input === input) closeTimePicker();
    else openTimePicker(input);
    return;
  }
  if (!timePicker.el?.contains(e.target)) return;
  const t = parseTime(timePicker.input.value);
  const cell = e.target.closest('.tp-cell');
  const action = e.target.closest('[data-tp]')?.dataset.tp;
  if (cell?.dataset.hour) {
    setPickedTime(`${pad2(Number(cell.dataset.hour))}:${pad2(t?.m ?? 0)}`);
  } else if (cell?.dataset.minute) {
    setPickedTime(`${pad2(t?.h ?? 12)}:${pad2(Number(cell.dataset.minute))}`);
  } else if (cell?.dataset.period) {
    const wantPm = cell.dataset.period === 'pm';
    let h = wantPm ? 12 : 9;
    if (t) h = (t.h >= 12) === wantPm ? t.h : (t.h + 12) % 24;
    setPickedTime(`${pad2(h)}:${pad2(t?.m ?? 0)}`);
    const hours = timePicker.el.querySelectorAll('.tp-col')[1];
    centerCell(hours, hours.querySelector('.active'));
  } else if (action === 'clear') {
    setPickedTime('');
    closeTimePicker();
  } else if (action === 'done') {
    closeTimePicker();
  }
});

// 點選擇器以外的地方關閉
document.addEventListener('mousedown', (e) => {
  if (timePicker.el && !timePicker.el.contains(e.target) && e.target !== timePicker.input) closeTimePicker();
});

document.addEventListener('keydown', (e) => {
  const input = e.target.closest?.('input[data-time-picker]');
  if (!input) return;
  if (e.key === 'Escape' && timePicker.el) {
    e.stopPropagation();
    closeTimePicker();
  } else if (['Enter', ' ', 'ArrowDown'].includes(e.key) && !timePicker.el) {
    e.preventDefault();
    openTimePicker(input);
  } else if (e.key === 'Enter') {
    closeTimePicker();
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && input.value) {
    if (timePicker.input !== input) openTimePicker(input);
    setPickedTime('');
  }
}, true);

// 欄位跟著面板捲動或視窗改變大小時，選擇器位置會跑掉，直接關閉
window.addEventListener('resize', closeTimePicker);
document.addEventListener('scroll', (e) => {
  if (timePicker.el && !timePicker.el.contains(e.target)) closeTimePicker();
}, true);

// ---------------------------------------------------------------------------
// 地點庫：匯入 Google 地圖「已儲存」清單（Google Takeout 匯出的 CSV）
//   每個清單建立一個同名分類；CSV 的解析與地點查詢在 gmaps.js（parseSavedList、resolveSavedPlace）。
// ---------------------------------------------------------------------------

let importingSavedList = false;

async function importSavedLists(files) {
  if (!mapReady()) {
    toast('地圖尚未載入完成，請稍後再試');
    return;
  }
  importingSavedList = true;
  renderPanel();
  // 每個檔案的結果，全部完成後合併成一則提示
  const summaries = [];
  try {
    for (const file of files) {
      let list;
      try {
        list = parseSavedList(await file.text(), file.name);
      } catch (err) {
        console.error(err);
      }
      if (!list?.items.length) {
        summaries.push(`「${file.name}」不是 Google 地圖匯出的清單，或沒有地點`);
        continue;
      }
      // 已有同名分類時合併進去（略過重複的地點）
      const col = state.library.collections.find((c) => c.name === list.name) || createCollection(list.name);
      const total = list.items.length;
      let done = 0;
      toast(`匯入「${col.name}」中… 0/${total}`, 60000);
      const resolved = await mapLimit(list.items, 3, async (item) => {
        const place = await resolveSavedPlace(item);
        toast(`匯入「${col.name}」中… ${++done}/${total}`, 60000);
        return place;
      });

      const existing = new Set(col.places.map(placeKey));
      let added = 0;
      let duplicate = 0;
      const missing = [];
      resolved.forEach(({ place, error }, i) => {
        if (error) {
          missing.push(list.items[i].title || list.items[i].url);
          return;
        }
        if (existing.has(placeKey(place))) {
          duplicate++;
          return;
        }
        existing.add(placeKey(place));
        col.places.push(toPlace({ ...place, id: uid() }));
        added++;
      });
      if (missing.length) console.warn('無法匯入的地點：', missing);
      state.library.activeCollectionId = col.id;
      commit({ fit: true });
      summaries.push([
        `已匯入 ${added} 個地點到「${col.name}」`,
        duplicate ? `略過 ${duplicate} 個重複的地點` : '',
        missing.length ? `${missing.length} 個已不存在於 Google 地圖：${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}` : '',
      ].filter(Boolean).join('，'));
    }
  } finally {
    importingSavedList = false;
    renderPanel();
    if (summaries.length) toast(summaries.join('；'), 4000 + 2000 * summaries.length);
  }
}

$('#savedListFile').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importSavedLists(files);
});

// ---------------------------------------------------------------------------
// 地點庫：從其他地點庫匯入（本工具「匯出」的 JSON）
//   只取出檔案中的地點庫分類，勾選後合併到目前的地點庫，不影響行程。
//   同名分類合併在一起，已有的地點（同 placeId 或同座標）略過。
// ---------------------------------------------------------------------------

let libImportMenuOpen = false;
// 挑選中的匯入：{ fileName, collections: [{ name, places }], selected: Set<index> }
let libImport = null;

function renderLibraryImport() {
  const { fileName, collections, selected } = libImport;
  const existing = (name) => state.library.collections.some((c) => c.name === name);
  const total = [...selected].reduce((n, i) => n + collections[i].places.length, 0);
  return `
    <div class="section-detail">
      <div class="picker-head"><b>${msIcon('collections_bookmark')}從「${esc(fileName)}」匯入</b><button class="icon-btn" data-action="close-lib-import" title="關閉">✕</button></div>
      <label class="picker-all"><input type="checkbox" data-libimp-all ${selected.size === collections.length ? 'checked' : ''}> 全選</label>
      <ul class="picker-list">
        ${collections.map((c, i) => `
          <li>
            <label class="picker-item">
              <input type="checkbox" data-libimp="${i}" ${selected.has(i) ? 'checked' : ''}>
              <span class="picker-name">${esc(c.name)}</span>
              <span class="picker-tag">${c.places.length} 個地點${existing(c.name) ? ' · 合併到現有分類' : ''}</span>
            </label>
          </li>`).join('')}
      </ul>
      <div class="picker-actions">
        <button class="btn" data-action="close-lib-import">取消</button>
        <button class="btn primary" data-action="confirm-lib-import" ${selected.size ? '' : 'disabled'}>
          ${selected.size ? `匯入 ${selected.size} 個分類（${total} 個地點）` : '匯入'}</button>
      </div>
    </div>`;
}

function importLibraryCollections() {
  let added = 0;
  let duplicate = 0;
  let last = null;
  [...libImport.selected].sort((a, b) => a - b).forEach((i) => {
    const src = libImport.collections[i];
    const col = state.library.collections.find((c) => c.name === src.name) || createCollection(src.name);
    const keys = new Set(col.places.map(placeKey));
    src.places.forEach((p) => {
      if (keys.has(placeKey(p))) {
        duplicate++;
        return;
      }
      keys.add(placeKey(p));
      col.places.push(toPlace({ ...p, id: uid() }));
      added++;
    });
    last = col;
  });
  const count = libImport.selected.size;
  libImport = null;
  state.library.activeCollectionId = last?.id ?? null;
  commit({ fit: true });
  // 舊版匯出檔可能沒有分類圖示，補查一次
  if (mapReady()) backfillPlaceTypes();
  toast(`已從 ${count} 個分類匯入 ${added} 個地點${duplicate ? `，略過 ${duplicate} 個重複的地點` : ''}`, 4000);
}

$('#libraryFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let collections = null;
  try {
    collections = collectionsFromJson(JSON.parse(await file.text()));
  } catch (err) {
    console.error(err);
  }
  if (!collections) {
    toast(`「${file.name}」不是本工具匯出的檔案`, 4000);
    return;
  }
  if (!collections.length) {
    toast(`「${file.name}」的地點庫沒有地點`, 4000);
    return;
  }
  libImport = { fileName: file.name.replace(/\.json$/i, ''), collections, selected: new Set(collections.map((_, i) => i)) };
  editingCollectionId = null;
  renderPanel();
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer;
function toast(msg, duration = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ---------------------------------------------------------------------------
// 地圖
// ---------------------------------------------------------------------------

// 目前畫在地圖上的行程 / 地點庫標記與圖形（搜尋結果的標記另外管理）
let markers = [];
let shapes = [];

function showMapError(html) {
  const el = $('#mapError');
  el.innerHTML = `<div>${html}</div>`;
  el.hidden = false;
}

const apiKeyUrlHint = () => `請在網址後加上 <code>#key=你的金鑰</code> 重新開啟，例如：<br><code>${esc(location.origin + location.pathname)}#key=AIza…</code>`;

// Google Maps 金鑰驗證失敗時會呼叫這個全域函式；忘掉存在瀏覽器的金鑰，下次才能換一把
window.gm_authFailure = () => {
  forgetSavedApiKey();
  showMapError(`Google Maps API 金鑰驗證失敗。<br>請確認金鑰正確、HTTP referrer 限制允許這個網址，且已在 Google Cloud 啟用<br>Maps JavaScript API、Places API、Geocoding API。<br><br>${apiKeyUrlHint()}`);
};

async function initMap() {
  if (!hasApiKey()) {
    showMapError(`尚未設定 Google Maps API 金鑰。<br>${apiKeyUrlHint()}`);
    return;
  }
  await initGoogleMaps($('#map'), { controls: isWide(), onMapClick, onInfoWindowReady: keepInfoWindowVisible });
  backfillPlaceTypes();
  renderMap({ fit: state.activeSectionId ? 'section' : 'day' });
}

// ---------- Search ----------
// 打字時顯示建議（Autocomplete）；按 Enter 或選「搜尋」列時用 Text Search 列出多筆結果，
// 結果都以目前地圖範圍為優先

const searchEls = {
  input: $('#searchInput'), list: $('#suggestions'), panel: $('#searchPanel'), filters: $('#searchFilters'), filterBtn: $('#filterBtn'),
};
// 建議清單：第 0 列固定是「搜尋關鍵字」，之後是地點建議 { main, sub, placeId, prediction }
let suggestions = [];
let suggestIndex = -1;
let suggestTimer;
let suggestSeq = 0;
// 一次輸入到選定地點共用同一個 session token（Google 合併計費）
let sessionToken = null;
// 搜尋結果：{ query, items: [candidate], open, loading, area, activeIndex }
let search = null;
let searchSeq = 0;
let resultMarkers = [];

function showSearchResult(candidate) {
  panMapTo(latLng(candidate), 15);
  showCandidate(candidate);
}

function renderSuggestions() {
  const q = searchEls.input.value.trim();
  searchEls.list.hidden = !q || document.activeElement !== searchEls.input;
  if (searchEls.list.hidden) return;
  const row = (i, icon, main, sub) => `
    <li class="suggestion ${i === suggestIndex ? 'active' : ''}" data-index="${i}" role="option">
      <span class="sg-icon">${icon}</span>
      <span class="sg-text"><b>${main}</b>${sub ? `<small>${sub}</small>` : ''}</span>
    </li>`;
  searchEls.list.innerHTML = [
    row(0, '🔍', `搜尋「${esc(q)}」`, '在地圖上列出所有結果'),
    ...suggestions.map((s, i) => row(i + 1, '📍', esc(s.main), esc(s.sub))),
  ].join('');
}

function closeSuggestions() {
  clearTimeout(suggestTimer);
  suggestSeq++;
  suggestIndex = -1;
  searchEls.list.hidden = true;
  searchEls.input.blur(); // 手機上收起鍵盤
}

function chooseSuggestion(index) {
  const q = searchEls.input.value.trim();
  if (!q) return;
  if (index <= 0) runTextSearch(q);
  else pickSuggestion(suggestions[index - 1]);
}

// 選了某個建議地點：只顯示這一個地點
async function pickSuggestion(s) {
  closeSuggestions();
  const token = sessionToken;
  sessionToken = null;
  setSearch(null);
  try {
    showSearchResult(await fetchSuggestionPlace(s, token));
  } catch (err) {
    console.error(err);
    toast('無法取得地點資訊');
  }
}

searchEls.input.addEventListener('input', () => {
  suggestIndex = -1;
  clearTimeout(suggestTimer);
  const q = searchEls.input.value.trim();
  if (!q) suggestions = [];
  renderSuggestions();
  if (!q || !mapReady()) return;
  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    let list = [];
    sessionToken ??= newSessionToken();
    try { list = await fetchSuggestions(q, sessionToken, mapBounds()); } catch (err) { console.error(err); }
    if (seq !== suggestSeq) return;
    suggestions = list;
    renderSuggestions();
  }, 250);
});

searchEls.input.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 中文輸入法選字中
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (searchEls.list.hidden) return;
    e.preventDefault();
    suggestIndex = Math.max(-1, Math.min(suggestions.length, suggestIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    chooseSuggestion(suggestIndex);
  } else if (e.key === 'Escape') {
    searchEls.list.hidden = true;
  }
});

searchEls.input.addEventListener('focus', renderSuggestions);
searchEls.input.addEventListener('blur', () => { searchEls.list.hidden = true; });
// 點建議時不要讓輸入框先失去焦點
searchEls.list.addEventListener('mousedown', (e) => e.preventDefault());
searchEls.list.addEventListener('click', (e) => {
  const item = e.target.closest('[data-index]');
  if (item) chooseSuggestion(Number(item.dataset.index));
});

// ---------- 進階搜尋：營業時間 ----------
// hours: 'any' 不限 / 'now' 現在營業中 / 'at' 指定時間；when: 'd:<dayId>'（行程中的某天）或 'w:<0-6>'（星期）
const hoursFilter = { hours: 'any', when: '', time: '12:00' };
let filtersOpen = false;

// 選的那一天被刪除、清掉出發日或還沒選過時，改用預設（目前這天或今天的星期）
function ensureValidWhen() {
  const [kind, value] = hoursFilter.when.split(':');
  const valid = kind === 'w' || (kind === 'd' && state.startDate && findDay(value));
  if (!valid) hoursFilter.when = state.startDate ? `d:${activeDay().id}` : `w:${new Date().getDay()}`;
}

// 把篩選設定換成搜尋用的條件；行程中的某天依出發日換成星期幾
function resolveHoursFilter() {
  const f = hoursFilter;
  // label：完整說明；short：結果標題列用的短標籤
  if (f.hours === 'now') return { hours: 'now', label: '現在營業中', short: '營業中' };
  if (f.hours !== 'at') return null;
  ensureValidWhen();
  const [kind, value] = f.when.split(':');
  const day = kind === 'd' ? findDay(value) : null;
  const date = day && dayDateObj(day);
  const weekday = date ? date.getDay() : Number(value);
  const [h, m] = f.time.split(':').map(Number);
  const when = day ? `${dayLabel(day)}（週${WEEKDAYS[weekday]}）` : `週${WEEKDAYS[weekday]}`;
  return { hours: 'at', weekday, minutes: h * 60 + m, label: `${when} ${f.time} 營業`, short: `週${WEEKDAYS[weekday]} ${f.time}` };
}

function renderFilters() {
  const panel = searchEls.filters;
  panel.hidden = !filtersOpen;
  els.overlay.classList.toggle('filters-open', filtersOpen);
  searchEls.filterBtn.classList.toggle('active', hoursFilter.hours !== 'any');
  searchEls.filterBtn.setAttribute('aria-expanded', String(filtersOpen));
  if (!filtersOpen) {
    panel.innerHTML = '';
    return;
  }
  const f = hoursFilter;
  const seg = (value, label) => `<button class="seg ${f.hours === value ? 'active' : ''}" data-hours="${value}">${label}</button>`;
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map((w) => `<option value="w:${w}">週${WEEKDAYS[w]}</option>`).join('');
  const days = state.startDate
    ? state.days.map((d) => `<option value="d:${d.id}">${esc(dayLabel(d))} · ${esc(dayDate(d))}</option>`).join('')
    : '';
  panel.innerHTML = `
    <div class="sf-row">
      <span class="sf-label">營業時間</span>
      <div class="seg-group">${seg('any', '不限')}${seg('now', '現在營業中')}${seg('at', '指定時間')}</div>
    </div>
    ${f.hours === 'at' ? `
      <div class="sf-row sf-when">
        <select data-filter="when" aria-label="哪一天">
          ${days ? `<optgroup label="行程">${days}</optgroup><optgroup label="星期">${weekdays}</optgroup>` : weekdays}
        </select>
        ${timeInput('data-filter="time" aria-label="時間"', f.time)}
      </div>
      <div class="sf-note">${state.startDate ? '' : '在選單設定出發日後，可直接選行程中的某一天。'}時間以地點當地時間計算。</div>` : ''}
    <div class="sf-actions">
      <button class="btn" data-filter-action="close">關閉</button>
      <button class="btn primary" data-filter-action="apply">${searchEls.input.value.trim() || search ? '套用並搜尋' : '套用'}</button>
    </div>`;
  const select = panel.querySelector('[data-filter="when"]');
  if (select) select.value = f.when;
}

function toggleFilters(open = !filtersOpen) {
  filtersOpen = open;
  if (open) ensureValidWhen();
  renderFilters();
}

searchEls.filterBtn.addEventListener('click', () => toggleFilters());

searchEls.filters.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-hours]');
  if (seg) {
    hoursFilter.hours = seg.dataset.hours;
    renderFilters();
    return;
  }
  const action = e.target.closest('[data-filter-action]')?.dataset.filterAction;
  if (!action) return;
  toggleFilters(false);
  if (action !== 'apply') return;
  const query = searchEls.input.value.trim() || search?.query;
  if (query) runTextSearch(query);
});

searchEls.filters.addEventListener('change', (e) => {
  const key = e.target.dataset.filter;
  if (key && e.target.value) hoursFilter[key] = e.target.value;
});

function setSearch(s) {
  search = s;
  searchSeq++;
  renderSearch();
  renderResultMarkers();
}

async function runTextSearch(query, { area = false } = {}) {
  if (!mapReady()) return;
  closeSuggestions();
  sessionToken = null;
  const bounds = mapBounds();
  const filter = resolveHoursFilter();
  setSearch({ query, items: [], open: true, loading: true, area, activeIndex: -1, filter, unknown: 0 });
  const s = search;
  const seq = searchSeq;
  try {
    let items = await textSearch(query, bounds, area, filter);
    if (seq !== searchSeq) return;
    if (filter) {
      const result = await applyHoursFilter(items, filter);
      if (seq !== searchSeq) return;
      ({ items, unknown: s.unknown } = result);
    }
    s.items = items;
  } catch (err) {
    console.error(err);
    if (seq !== searchSeq) return;
    toast('搜尋失敗，請稍後再試');
  }
  s.loading = false;
  renderSearch();
  renderResultMarkers({ fit: !area });
}

function renderSearch() {
  const panel = searchEls.panel;
  panel.hidden = !search;
  els.overlay.classList.toggle('search-open', !!search?.open);
  if (!search) {
    panel.innerHTML = '';
    return;
  }
  const { query, items, loading, open, filter } = search;
  const count = loading ? (filter && !useNewPlacesApi() ? '確認營業時間…' : '搜尋中…') : `${items.length} 個結果`;
  const empty = `${search.area ? '這個區域內' : ''}找不到${filter ? `${filter.label}的` : ''}「${esc(query)}」`;
  panel.classList.toggle('collapsed', !open);
  // 重繪時保留清單捲動位置
  const scroll = panel.querySelector('.sr-list')?.scrollTop || 0;
  panel.innerHTML = `
    <div class="sr-head">
      <button class="sr-toggle" data-action="toggle-results" aria-expanded="${open}">
        <span class="sr-title">🔍 ${esc(query)}</span>
        ${filter ? `<span class="sr-filter" title="${esc(filter.label)}">⏰ ${esc(filter.short)}</span>` : ''}
        <span class="sr-count">${count}</span>
        <span class="sr-hint">${open ? '收起 ▴' : '展開 ▾'}</span>
      </button>
      <button class="icon-btn" data-action="clear-search" title="清除搜尋結果">✕</button>
    </div>
    ${open ? `
      ${items.length ? `<ol class="sr-list">${items.map(renderResult).join('')}</ol>` : ''}
      ${!loading && !items.length ? `<div class="sd-empty sr-empty">${empty}</div>` : ''}
      ${!loading && search.unknown ? `<div class="sr-note">另有 ${search.unknown} 個地點沒有營業時間資料，未列出</div>` : ''}
      <div class="sr-drag">
        <div class="sr-foot">
          <button class="btn small" data-action="search-area" title="以目前地圖範圍重新搜尋">⟳ 搜尋此區域</button>
        </div>
        <div class="sr-grip" title="往上滑收起"></div>
      </div>` : ''}`;
  const list = panel.querySelector('.sr-list');
  if (list) list.scrollTop = scroll;
}

function renderResult(c, i) {
  const rating = c.details?.rating ? `<span class="iw-rating">★ ${c.details.rating.toFixed(1)}</span> · ` : '';
  // 指定時間搜尋時顯示那一天的營業時間，取代地址
  const filter = search.filter;
  const hours = filter?.hours === 'at' && c.details?.hours?.[(filter.weekday + 6) % 7];
  const sub = hours ? `<span class="iw-open">週${WEEKDAYS[filter.weekday]}</span> ${esc(hours.replace(/^[^:：]+[:：]\s*/, ''))}` : esc(c.address);
  return `
    <li>
      <button class="sr-item ${i === search.activeIndex ? 'active' : ''}" data-action="focus-result" data-result-index="${i}">
        ${renderPlaceIcon(c)}
        <span class="sr-text"><b>${esc(c.name)}</b><small>${rating}${sub}</small></span>
      </button>
    </li>`;
}

function focusResult(i) {
  const c = search.items[i];
  if (!c) return;
  search.activeIndex = i;
  // 手機：收起清單，讓出地圖與資訊視窗的空間
  if (isMobile()) search.open = false;
  renderSearch();
  renderResultMarkers();
  els.overlay.querySelector(`.sr-item[data-result-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  panMapTo(latLng(c));
  showCandidate(c);
}

function toggleResults() {
  search.open = !search.open;
  renderSearch();
}

// 手機：把結果面板底部往上滑收起，收起時在標題列往下滑展開；清單高度跟著手指變化
function enableSwipeToggle(panel) {
  let drag = null;
  panel.addEventListener('pointerdown', (e) => {
    if (!isMobile() || !search) return;
    if (!e.target.closest(search.open ? '.sr-drag' : '.sr-head')) return;
    const list = panel.querySelector('.sr-list');
    drag = { id: e.pointerId, y: e.clientY, list, height: list?.offsetHeight || 0, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 8) return;
    drag.moved = true;
    if (search.open && drag.list) {
      drag.list.style.transition = 'none';
      drag.list.style.maxHeight = `${Math.max(0, drag.height + Math.min(0, dy))}px`;
    }
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, list } = drag;
    const dy = e.clientY - drag.y;
    drag = null;
    if (!moved) return;
    // 拖曳結束時不要觸發按鈕的點擊
    const block = (ev) => ev.stopPropagation();
    panel.addEventListener('click', block, { capture: true, once: true });
    setTimeout(() => panel.removeEventListener('click', block, { capture: true }), 0);
    if (search.open ? dy < -40 : dy > 30) {
      toggleResults();
    } else if (list) {
      // 滑動距離不夠：彈回原本高度
      list.style.transition = '';
      list.style.maxHeight = '';
    }
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}
enableSwipeToggle(searchEls.panel);

function renderResultMarkers({ fit = false } = {}) {
  removeFromMap(resultMarkers);
  resultMarkers = [];
  if (!mapReady() || !search) return;
  search.items.forEach((c, i) => {
    const active = i === search.activeIndex;
    const el = document.createElement('div');
    el.className = `result-pin${active ? ' active' : ''}`;
    appendPinGlyph(el, c);
    if (active) withLabel(el, c.name);
    resultMarkers.push(createMarker({
      position: latLng(c), content: el, title: c.name, zIndex: active ? 4000 : 500, onClick: () => focusResult(i),
    }));
  });
  if (fit) fitTo(search.items.map(latLng));
}

// 資訊視窗中 Google 地點資訊的部分：名稱、評分、營業時間、網站（照片在標題列）
function renderPlaceInfo(p, extra = '') {
  const d = p.details || {};
  const meta = [];
  if (d.rating) meta.push(`<span class="iw-rating">★ ${d.rating.toFixed(1)}</span>${d.ratingCount ? ` (${d.ratingCount.toLocaleString()})` : ''}`);
  if (d.openNow === true) meta.push('<span class="iw-open">營業中</span>');
  if (d.openNow === false) meta.push('<span class="iw-closed">休息中</span>');
  // weekday 文字從星期一開始
  const today = d.hours?.[(new Date().getDay() + 6) % 7];
  let site = d.website;
  try { site = d.website && new URL(d.website).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }

  return `
    <div class="iw-name">${esc(p.name)}</div>
    ${meta.length ? `<div class="iw-meta">${meta.join(' · ')}</div>` : ''}
    ${extra}
    ${today ? `<div class="iw-line">🕘 ${esc(today)}</div>` : ''}
    ${d.website ? `<div class="iw-line">🌐 <a href="${esc(d.website)}" target="_blank" rel="noopener">${esc(site)}</a></div>` : ''}
    <a class="iw-gmaps" href="${esc(googleMapsUrl(p))}" target="_blank" rel="noopener">在 Google 地圖查看 ↗</a>`;
}

// 舊資料沒有地點類型與圖示：查一次 Google 地點資訊補上並儲存
function backfillPlaceTypes() {
  const pending = [
    ...state.days.flatMap((d) => d.sections.flatMap((s) => [s.center, ...s.places])),
    ...state.library.collections.flatMap((c) => c.places),
  ].filter((p) => p.icon === undefined);
  pending.forEach((p) => {
    if (!p.placeId) {
      p.types ??= [];
      p.icon = null;
      return;
    }
    getPlaceDetails(p.placeId)
      .then((c) => { p.types = c.types; p.icon = c.icon; })
      .catch(() => { p.types ??= []; p.icon = null; })
      .finally(() => {
        save();
        const editing = els.dayPanel.contains(document.activeElement) || els.libraryPanel.contains(document.activeElement);
        if (!editing) renderPanel();
      });
  });
  if (pending.length) save();
}

// ---------- Map click → candidate popup ----------

// 點到地圖上的 POI 時顯示該地點（gmaps.js 已擋下 Google 預設的資訊視窗）；
// 車站點擊時沒有 placeId，改找附近的車站；都沒有才以點選的座標當作自訂地點
async function onMapClick({ latLng: point, placeId }) {
  showLoading(point);
  const id = placeId || await findStationNear(point);
  if (id) {
    try {
      showCandidate(await getPlaceDetails(id));
      return;
    } catch (err) {
      console.error(err);
    }
  }
  showCandidateFromLatLng(point);
}

// 資訊視窗被疊加的 UI 擋住時，移動地圖讓它露出來（等內建的 auto-pan 結束再檢查）
let infoWindowCheckTimer;
function keepInfoWindowVisible() {
  clearTimeout(infoWindowCheckTimer);
  infoWindowCheckTimer = setTimeout(() => {
    const iw = document.querySelector('.gm-style-iw-c');
    if (!iw) return;
    const a = iw.getBoundingClientRect();
    const blockers = [...els.overlay.children]
      .filter((el) => !el.hidden)
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.left < a.right && r.right > a.left && r.top < a.bottom && r.bottom > a.top);
    if (!blockers.length) return;
    const gap = 12;
    if (isWide()) panMapBy(-(Math.max(...blockers.map((r) => r.right)) + gap - a.left), 0);
    else panMapBy(0, -(Math.max(...blockers.map((r) => r.bottom)) + gap - a.top));
  }, 350);
}

function showLoading(point) {
  openInfoWindow('<div class="iw">載入中…</div>', { position: point });
}

async function showCandidateFromLatLng(point) {
  const candidate = {
    name: '自訂地點',
    address: `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`,
    ...point,
    placeId: '',
    types: [],
    icon: null,
  };
  // 查不到地址時（例如沒啟用 Geocoding API）仍可用座標加入
  const address = await reverseGeocode(point);
  if (address) {
    candidate.address = address;
    candidate.name = address.replace(/^\d{3,6}\s*/, '').slice(0, 40);
  }
  showCandidate(candidate);
}

// 候選地點：建立新區塊，或加入當日的某個區塊
function showCandidate(c) {
  if (isLibrary()) {
    showLibraryCandidate(c);
    return;
  }
  const day = activeDay();
  const sec = activeSection();
  // 編輯中的區塊可以把這個地點設為新的中心；按了「更換中心」時預設選這一項
  const editingSec = day.sections.find((s) => s.id === editingSectionId);
  const replacing = editingSec && isReplacingCenter(editingSec);
  const options = [
    ...(editingSec ? [`<option value="${REPLACE_CENTER}" ${replacing ? 'selected' : ''}>◎ 設為「${esc(sectionName(editingSec))}」的新中心</option>`] : []),
    `<option value="${NEW_SECTION}">＋ 建立新區塊（以此為中心）</option>`,
    ...day.sections.map((s, i) =>
      `<option value="${s.id}" ${s === sec && !replacing ? 'selected' : ''}>加入區塊 ${i + 1}：${esc(sectionName(s))}</option>`),
  ].join('');

  const el = document.createElement('div');
  el.className = 'iw';
  el.innerHTML = `
    ${renderPlaceInfo(c)}
    <div class="iw-day" style="--day-color:${dayColor(day)}"><span class="dot"></span>${esc(dayOptionLabel(day))}</div>
    <div class="iw-actions">
      <select aria-label="加入方式">${options}</select>
      <button class="btn primary">確定</button>
    </div>`;
  el.querySelector('button').addEventListener('click', () => {
    const value = el.querySelector('select').value;
    closeInfoWindow();
    const target = day.sections.find((s) => s.id === value);
    if (value === REPLACE_CENTER) replaceCenter(editingSec, c);
    else if (target) addPlaceToSection(day, target, c);
    else addSection(day, c);
  });
  openInfoWindow(el, { photo: c, position: latLng(c) });
}

// 地點庫模式的候選地點：加入既有分類或新建分類
function showLibraryCandidate(c) {
  const cols = state.library.collections;
  const active = activeCollection() || cols[0];
  const options = [
    ...cols.map((col) => `<option value="${col.id}" ${col === active ? 'selected' : ''}>加入：${esc(col.name)}</option>`),
    `<option value="${NEW_SECTION}" ${cols.length ? '' : 'selected'}>＋ 新分類…</option>`,
  ].join('');

  const el = document.createElement('div');
  el.className = 'iw';
  el.innerHTML = `
    ${renderPlaceInfo(c)}
    <div class="iw-actions">
      <select aria-label="加入哪個分類">${options}</select>
      <input class="iw-input" placeholder="新分類名稱" ${cols.length ? 'hidden' : ''}>
      <button class="btn primary">加入地點庫</button>
    </div>`;
  const select = el.querySelector('select');
  const input = el.querySelector('input');
  select.addEventListener('change', () => {
    input.hidden = select.value !== NEW_SECTION;
    if (!input.hidden) input.focus();
  });
  el.querySelector('button').addEventListener('click', () => {
    const col = cols.find((x) => x.id === select.value) || createCollection(input.value.trim());
    closeInfoWindow();
    addPlaceToCollection(col, c);
  });
  openInfoWindow(el, { photo: c, position: latLng(c) });
}

// 點地圖上地點庫的標記：切換到該分類並標示地點
function selectLibraryPlace(col, place) {
  const changed = state.library.activeCollectionId !== col.id;
  state.library.activeCollectionId = col.id;
  editingCollectionId = null;
  expandedPlaceId = place.id;
  save();
  render();
  if (changed) renderMap();
  showPlaceInfo(place, markers.find((m) => m.key === place.id));
  scrollToPlace(place.id);
}

function showPlaceInfo(place, anchor) {
  const el = document.createElement('div');
  el.className = 'iw';
  // 行程中自己填的時間與備註
  const own = [
    place.time ? `<div class="iw-line">⏰ ${esc(place.time)}</div>` : '',
    place.note ? `<div class="iw-note">${esc(place.note)}</div>` : '',
  ].join('');
  const owner = findPlaceOwner(place.id);
  el.innerHTML = `<div class="iw-body">${renderPlaceInfo(place, own)}</div>
    ${owner ? `<div class="iw-actions"><button class="btn danger">${msIcon('delete')}${esc(deleteLabel(owner))}</button></div>` : ''}`;
  el.querySelector('.btn.danger')?.addEventListener('click', () => deleteSavedPlace(place, owner));
  openInfoWindow(el, { photo: place, anchor, position: latLng(place) });
  // 背景補上 Google 地點資訊；若使用者已經點了別的地點就不覆蓋
  if (place.placeId) {
    getPlaceDetails(place.placeId).then((c) => {
      if (!isInfoWindowShowing(el)) return;
      el.querySelector('.iw-body').innerHTML = renderPlaceInfo({ ...place, details: c.details }, own);
      setInfoWindowPhoto(c);
    }).catch(() => { /* 保留基本資訊 */ });
  }
}

function deleteLabel(owner) {
  if (owner.kind === 'center') return `刪除區塊「${sectionName(owner.sec)}」`;
  if (owner.kind === 'section') return `從「${sectionName(owner.sec)}」移除`;
  return `從「${owner.col.name}」移除`;
}

function deleteSavedPlace(place, owner) {
  if (owner.kind === 'center') {
    // 中心無法單獨移除：刪除整個區塊
    const { day, sec } = owner;
    const extra = sec.places.length ? `以及其中 ${sec.places.length} 個周邊地點` : '';
    if (!confirm(`確定刪除區塊「${sectionName(sec)}」${extra}？`)) return;
    day.sections = day.sections.filter((s) => s !== sec);
    closeInfoWindow();
    if (state.activeSectionId === sec.id) selectSection(null);
    else commit();
    toast(`已刪除區塊：${sectionName(sec)}`);
    return;
  }
  const holder = owner.kind === 'section' ? owner.sec : owner.col;
  const holderName = owner.kind === 'section' ? sectionName(owner.sec) : owner.col.name;
  if (!confirm(`確定從「${holderName}」移除「${place.name}」？`)) return;
  holder.places = holder.places.filter((p) => p.id !== place.id);
  if (expandedPlaceId === place.id) expandedPlaceId = null;
  closeInfoWindow();
  commit();
  toast(`已移除：${place.name}`);
}

function focusPlaceOnMap(place) {
  if (!mapReady()) return;
  panMapTo(latLng(place));
  showPlaceInfo(place, markers.find((m) => m.key === place.id));
}

// 點地圖上的 marker：切換到該天 / 區塊並展開
function selectFromMap(day, sec, place) {
  const changed = state.activeDayId !== day.id || state.activeSectionId !== sec.id;
  state.activeDayId = day.id;
  state.activeSectionId = sec.id;
  state.dayOpen = true;
  expandedPlaceId = place === sec.center ? null : place.id;
  // 不改變地點面板的展開狀態：收起中就維持收起，只在地圖上顯示資訊
  save();
  render();
  if (changed) renderMap();
  showPlaceInfo(place, markers.find((m) => m.key === place.id));
  if (expandedPlaceId) scrollToPlace(place.id);
}

// ---------- Map drawing ----------

// 標記旁的地點名稱
function withLabel(el, text, className = '') {
  const label = document.createElement('span');
  label.className = `map-label ${className}`.trim();
  label.textContent = text;
  el.appendChild(label);
  return el;
}

// key：對應的地點 id，用來找出資訊視窗要接在哪個標記上
function addMarker({ key, ...options }) {
  const marker = createMarker(options);
  marker.key = key;
  markers.push(marker);
  return marker;
}

function renderMap({ fit = false } = {}) {
  if (!mapReady()) return;
  removeFromMap([...markers, ...shapes]);
  markers = [];
  shapes = [];

  if (isLibrary()) {
    renderLibraryMap(fit);
    return;
  }

  const active = activeDay();
  const activeSec = activeSection();
  // 選擇天數時顯示所有天的總覽
  const overview = !state.dayOpen;
  const days = state.showAll || overview ? state.days : [active];

  days.forEach((day) => {
    const color = dayColor(day);
    const isActiveDay = !overview && day === active;

    day.sections.forEach((sec, si) => {
      const isActiveSec = sec === activeSec;
      const center = latLng(sec.center);

      const pin = createPin({ color, text: String(si + 1), scale: isActiveSec ? 1.35 : isActiveDay || overview ? 1.1 : 0.8 });
      let content = pin;
      if (isActiveDay) {
        content = document.createElement('div');
        content.className = 'center-marker';
        content.appendChild(pin);
        // 展開中的區塊顯示中心地點名稱，其他區塊顯示區塊名稱
        withLabel(content, isActiveSec ? sec.center.name : sectionName(sec), 'center');
      }
      addMarker({
        key: sec.center.id,
        position: center,
        content,
        title: `${dayLabel(day)} 區塊 ${si + 1}：${sectionName(sec)}`,
        zIndex: isActiveSec ? 3000 : isActiveDay ? 2000 + si : si,
        onClick: () => selectFromMap(day, sec, sec.center),
      });

      if (!isActiveDay) return;

      shapes.push(drawCircle({
        center, radius: sectionRadius(sec), color, opacity: isActiveSec ? 0.9 : 0.45, weight: isActiveSec ? 2 : 1,
      }));

      sec.places.forEach((p, pi) => {
        const el = document.createElement('div');
        el.className = `place-pin${isActiveSec ? '' : ' dim'}`;
        el.style.setProperty('--c', color);
        el.textContent = String(pi + 1);
        if (isActiveSec) withLabel(el, p.name);
        addMarker({
          key: p.id,
          position: latLng(p),
          content: el,
          title: `${sectionName(sec)} · ${p.name}`,
          zIndex: isActiveSec ? 2500 + pi : 1000 + pi,
          onClick: () => selectFromMap(day, sec, p),
        });
      });

    });

    // 區塊之間的移動路線
    if (day.sections.length > 1) {
      shapes.push(drawRoute(day.sections.map((s) => latLng(s.center)), {
        color,
        opacity: isActiveDay || overview ? 0.85 : 0.4,
        weight: isActiveDay || overview ? 4 : 3,
        zIndex: isActiveDay ? 2 : 1,
      }));
    }
  });

  if (fit === 'section' && activeSec) {
    fitTo([activeSec.center, ...activeSec.places].map(latLng));
  } else if (fit) {
    fitTo(days.flatMap((d) => d.sections.flatMap((s) => [s.center, ...s.places])).map(latLng));
  }
}

// 圓形標記中的圖案：Google 分類圖示，沒有時用備用 emoji
function appendPinGlyph(el, p) {
  if (p.icon?.mask) {
    const glyph = document.createElement('span');
    glyph.className = 'lib-pin-glyph';
    glyph.style.setProperty('--icon-mask', `url('${p.icon.mask}')`);
    el.appendChild(glyph);
  } else {
    el.textContent = placeCategory(p).icon;
  }
}

// 地點庫：每個分類一種顏色，圖示用 Google 的分類圖示；選中分類時其他分類淡化
function renderLibraryMap(fit) {
  const cols = state.library.collections;
  const active = activeCollection();
  cols.forEach((col) => {
    const color = collectionColor(col);
    const isActive = col === active;
    col.places.forEach((p) => {
      const el = document.createElement('div');
      el.className = `lib-pin${active && !isActive ? ' dim' : ''}`;
      el.style.setProperty('--c', color);
      appendPinGlyph(el, p);
      if (isActive) withLabel(el, p.name);
      addMarker({
        key: p.id,
        position: latLng(p),
        content: el,
        title: `${col.name} · ${p.name}`,
        zIndex: isActive ? 2000 : 1000,
        onClick: () => selectLibraryPlace(col, p),
      });
    });
  });
  if (fit) fitTo((active ? active.places : cols.flatMap((c) => c.places)).map(latLng));
}

// 地圖可視範圍要避開疊加的 UI
function fitPadding() {
  const r = els.overlay.getBoundingClientRect();
  if (isWide()) return { top: 50, left: Math.min(r.right + 20, window.innerWidth * 0.6), right: 50, bottom: 50 };
  return { top: Math.min(r.bottom + 20, window.innerHeight * 0.7), left: 30, right: 30, bottom: 40 };
}

function fitTo(points) {
  fitMapTo(points, fitPadding());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

render();
initMap().catch((err) => {
  console.error(err);
  showMapError(`Google 地圖載入失敗：${esc(err.message)}<br>請確認網路連線與 API 金鑰設定。`);
});
