'use strict';

// ===========================================================================
// 選單中的遠端介面：設定 GitHub repo、推送更新、拉取最新版本、切換到某一個 commit。
// 請求與資料轉換在 github.js、三方合併在 merge.js；目前所在的 commit 記錄在 state.local。
//
// 協作時的處理：
//   - 推送被拒（遠端在上次同步後有新版本）→ 和遠端三方合併，沒有衝突就自動合併後推送，有衝突時讓使用者逐項選擇
//   - 拉取時本機有未推送的修改 → 一樣三方合併，保留本機修改
//   - 任何會丟掉本機修改的動作（使用遠端版本、切換版本、衝突選遠端）之前，先把本機內容另存成備份專案
// ===========================================================================

// 'status'：目前狀態與操作；'settings'：設定遠端；'history'：版本紀錄；'share'：分享連結與 QR code；'merge'：合併衝突
let remoteView = 'status';
let remoteBusy = false;
// 版本紀錄：{ commits, page, more }；null 表示還沒載入
let remoteHistory = null;
// 尚未送出的提交訊息（重繪時保留）
let remoteMessage = '';
// 等待使用者處理的合併：{ kind: 'push' | 'pull', head, base, remote, choices }（base 為 null 表示無法合併）
let remoteMerge = null;
// 上面的介面狀態屬於哪個專案；切換專案時重設
let remoteProjectId = projects.activeId;

const remoteEl = $('#remotePanel');
const shortSha = (sha) => (sha ? sha.slice(0, 7) : '');
const firstLine = (msg) => String(msg || '').split('\n')[0];

function formatCommitDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function remoteStatus() {
  const { local } = state;
  if (!local.commit) return { cls: 'pending', text: '尚未同步' };
  if (hasLocalChanges(state)) return { cls: 'dirty', text: '有未推送的變更' };
  return { cls: 'clean', text: '已同步' };
}

function renderRemotePanel() {
  if (remoteProjectId !== projects.activeId) {
    remoteProjectId = projects.activeId;
    remoteView = 'status';
    remoteHistory = null;
    remoteMessage = '';
    remoteMerge = null;
  }
  if (remoteView === 'merge' && !remoteMerge) remoteView = 'status';
  const remote = state.local.remote;
  if (!remote && remoteView === 'history') remoteView = 'status';
  const status = remote ? remoteStatus() : null;
  const head = `<div class="menu-section-title">遠端
    ${status ? `<span class="remote-badge ${status.cls}">${status.text}</span>` : ''}
    ${remoteBusy ? '<span class="remote-busy">處理中…</span>' : ''}</div>`;
  const disabled = remoteBusy ? 'disabled' : '';

  if (remoteView === 'settings') {
    const hasToken = !!getGithubToken();
    remoteEl.innerHTML = `${head}
      <label class="field">GitHub repo
        <input data-remote-field="repo" placeholder="owner/repo" value="${esc(remote ? remoteLabel(remote) : '')}" autocomplete="off" spellcheck="false">
      </label>
      <label class="field">存取權杖（只存在這個瀏覽器，不會推送或匯出）
        <input data-remote-field="token" type="password" autocomplete="off"
          placeholder="${hasToken ? '已設定（留空則不變更）' : 'github_pat_… 或 ghp_…'}">
      </label>
      <div class="menu-actions">
        ${remote ? `<button class="btn small danger" data-remote="unlink" ${disabled}>移除遠端</button>` : ''}
        ${hasToken ? `<button class="btn small" data-remote="clear-token" ${disabled}>清除權杖</button>` : ''}
        <span class="spacer"></span>
        <button class="btn small" data-remote="cancel" ${disabled}>取消</button>
        <button class="btn small primary" data-remote="save-settings" ${disabled}>儲存</button>
      </div>`;
    return;
  }

  if (remoteView === 'share') {
    renderSharePanel(head);
    return;
  }

  if (remoteView === 'merge') {
    renderMergePanel(head, disabled);
    return;
  }

  if (!remote) {
    remoteEl.innerHTML = `${head}
      <p class="remote-note">把專案推送到 GitHub repo，可在不同裝置同步，並保留每次更新的版本。</p>
      <div class="menu-actions">
        <button class="btn small" data-remote="settings">設定遠端</button>
        <span class="spacer"></span>
        <button class="btn small" data-remote="share">分享連結</button>
      </div>`;
    return;
  }

  const { local } = state;
  const info = `<div class="remote-info">
      <div class="remote-target" title="${esc(remoteLabel(remote))}"><b>${esc(remoteLabel(remote))}</b></div>
      <div class="remote-commit">${local.commit
        ? `目前版本 <code>${shortSha(local.commit)}</code> ${esc(firstLine(local.commitMessage))}
           <small>${formatCommitDate(local.commitDate)}</small>`
        : '尚未推送或拉取'}</div>
    </div>`;

  if (remoteView === 'history') {
    const list = remoteHistory
      ? (remoteHistory.commits.length
        ? remoteHistory.commits.map((c) => `
          <li class="remote-commit-item ${c.sha === local.commit ? 'current' : ''}">
            <div class="rc-text">
              <span><code>${shortSha(c.sha)}</code> ${esc(firstLine(c.message))}</span>
              <small>${formatCommitDate(c.date)}${c.author ? ` · ${esc(c.author)}` : ''}</small>
            </div>
            ${c.sha === local.commit
              ? '<span class="rc-current">目前</span>'
              : `<button class="btn small" data-remote="checkout" data-sha="${esc(c.sha)}" ${disabled}>切換</button>`}
          </li>`).join('')
        : '<li class="remote-note">遠端還沒有這個檔案的版本</li>')
      : '<li class="remote-note">載入中…</li>';
    remoteEl.innerHTML = `${head}${info}
      <ul class="remote-history">${list}</ul>
      <div class="menu-actions">
        ${remoteHistory?.more ? `<button class="btn small" data-remote="more-history" ${disabled}>載入更多</button>` : ''}
        <span class="spacer"></span>
        <button class="btn small" data-remote="back">返回</button>
      </div>`;
    return;
  }

  remoteEl.innerHTML = `${head}${info}
    <input class="remote-message" data-remote-field="message" value="${esc(remoteMessage)}"
      placeholder="提交訊息（選填，預設自動產生）" enterkeyhint="send" ${disabled}>
    <div class="menu-actions">
      <button class="btn small primary" data-remote="push" ${disabled}>推送</button>
      <button class="btn small" data-remote="pull" ${disabled}>拉取最新</button>
      <button class="btn small" data-remote="history" ${disabled}>版本紀錄</button>
      <span class="spacer"></span>
      <button class="btn small" data-remote="share" ${disabled}>分享</button>
      <button class="btn small" data-remote="settings" ${disabled}>設定</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// 分享連結：目前的網址，加上目前專案的 Google 地圖金鑰、GitHub repo 與存取權杖，
// 開啟後會自動打開這個 repo（見下方 openRemoteFromUrl）。QR code 用 qrcode-generator 產生
// ---------------------------------------------------------------------------

const QR_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
let qrLibPromise = null;
// 連結要包含哪些機密參數（repo 本身不是機密，有設定就一定帶入）
const shareOptions = { key: true, token: true };

// 只在第一次分享時載入
function loadQrLib() {
  qrLibPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = QR_LIB_URL;
    script.onload = () => {
      window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
      resolve(window.qrcode);
    };
    script.onerror = () => {
      qrLibPromise = null;
      script.remove();
      reject(new Error('QR code 元件載入失敗，請檢查網路連線'));
    };
    document.head.append(script);
  });
  return qrLibPromise;
}

function shareParams() {
  const remote = state.local.remote;
  const token = remote ? getGithubToken() : '';
  return {
    key: shareOptions.key ? CONFIG.googleMapsApiKey || '' : '',
    repo: remote ? remoteLabel(remote) : '',
    token: shareOptions.token ? token : '',
    hasKey: !!CONFIG.googleMapsApiKey,
    hasToken: !!token,
  };
}

function shareLink() {
  const p = shareParams();
  const parts = [];
  if (p.key) parts.push(`key=${encodeURIComponent(p.key)}`);
  // repo 的斜線保留原樣，網址比較好讀
  if (p.repo) parts.push(`repo=${p.repo.split('/').map(encodeURIComponent).join('/')}`);
  if (p.token) parts.push(`token=${encodeURIComponent(p.token)}`);
  const base = location.origin + location.pathname;
  return parts.length ? `${base}#${parts.join('&')}` : base;
}

function renderSharePanel(head) {
  const p = shareParams();
  const link = shareLink();
  remoteEl.innerHTML = `${head}
    <div class="share-qr" data-share-qr>產生 QR code 中…</div>
    ${p.hasKey ? `<label class="check"><input type="checkbox" data-share="key" ${shareOptions.key ? 'checked' : ''}> 包含 Google 地圖金鑰</label>` : ''}
    ${p.hasToken ? `<label class="check"><input type="checkbox" data-share="token" ${shareOptions.token ? 'checked' : ''}> 包含 GitHub 存取權杖</label>` : ''}
    <input class="remote-message share-link" data-share-link readonly value="${esc(link)}" aria-label="分享連結">
    ${p.token ? '<p class="remote-note warn">連結含有存取權杖，拿到的人就能存取這個 repo，請只分享給信任的人。</p>' : ''}
    ${p.repo ? '' : '<p class="remote-note">這個專案還沒有設定遠端，連結只會開啟網頁（不含行程）。</p>'}
    <div class="menu-actions">
      <button class="btn small primary" data-remote="copy-link">複製網址</button>
      <button class="btn small" data-remote="download-qr">下載 QR code</button>
      <span class="spacer"></span>
      <button class="btn small" data-remote="back">返回</button>
    </div>`;
  const box = remoteEl.querySelector('[data-share-qr]');
  loadQrLib().then((qrcode) => {
    // 等待載入期間可能已離開分享畫面或改了選項
    if (!box.isConnected) return;
    const qr = qrcode(0, 'M');
    qr.addData(link, 'Byte');
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }).catch((err) => {
    if (box.isConnected) box.textContent = err.message;
  });
}

async function copyShareLink() {
  const input = remoteEl.querySelector('[data-share-link]');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast('已複製網址');
}

function downloadShareQr() {
  const svg = remoteEl.querySelector('[data-share-qr] svg');
  if (!svg) return;
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.title || 'trip').replace(/[\\/:*?"<>|]/g, '_')}-qrcode.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// 執行遠端操作：期間鎖住按鈕，失敗時顯示錯誤
// 處理中不能切換、新增或刪除專案，也不能匯入或清空（結果會記錄到目前的專案）
const PROJECT_CONTROLS = ['#projectSelect', '#newProjectBtn', '#deleteProjectBtn', '#importBtn', '#resetBtn'];

function setRemoteBusy(busy) {
  remoteBusy = busy;
  PROJECT_CONTROLS.forEach((sel) => { $(sel).disabled = busy; });
}

async function remoteTask(fn) {
  if (remoteBusy) return;
  setRemoteBusy(true);
  renderRemotePanel();
  try {
    await fn();
  } catch (err) {
    toast(err.message || '遠端操作失敗', 4000);
  } finally {
    setRemoteBusy(false);
    renderRemotePanel();
  }
}

function ensureToken() {
  if (getGithubToken()) return true;
  toast('請先設定 GitHub 存取權杖');
  remoteView = 'settings';
  renderRemotePanel();
  return false;
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function saveRemoteSettings() {
  const field = (name) => remoteEl.querySelector(`[data-remote-field="${name}"]`).value.trim();
  const repo = parseRepo(field('repo'));
  if (!repo) {
    toast('請輸入 owner/repo 或 GitHub repo 網址');
    return;
  }
  const next = repo;
  const prev = state.local.remote;
  const changed = !prev || ['owner', 'repo'].some((k) => prev[k] !== next[k]);
  // 換了遠端位置：原本記錄的 commit 不再適用
  state.local = changed ? { ...defaultLocal(), remote: next, token: state.local.token } : { ...state.local, remote: next };
  const token = field('token');
  if (token) setGithubToken(token);
  save();
  remoteView = 'status';
  remoteHistory = null;
  renderRemotePanel();
  toast(changed ? `已連結 ${remoteLabel(next)}` : '已儲存遠端設定');
}

function unlinkRemote() {
  if (!confirm('移除這個專案的遠端設定？（遠端上的檔案不會被刪除）')) return;
  state.local = defaultLocal();
  save();
  remoteView = 'status';
  remoteHistory = null;
  renderRemotePanel();
}

// ---------------------------------------------------------------------------
// 本機備份：本機內容要被取代前另存成一個專案
// ---------------------------------------------------------------------------

function hasNoContent(s) {
  return s.days.length === 1 && !s.days[0].sections.length && !s.library.collections.length;
}

// 有尚未推送的修改，或從沒同步過且有內容
function needsBackup(s) {
  return hasLocalChanges(s) || (!s.local.commit && !hasNoContent(s));
}

// 回傳備份專案的名稱；不需要備份時回傳 ''
function backupLocal() {
  if (!needsBackup(state)) return '';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const title = `${state.title || '未命名旅程'}（本機備份 ${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}）`;
  try {
    saveProjectCopy(state, title);
  } catch {
    throw new Error('無法儲存本機備份（儲存空間不足），已取消');
  }
  return title;
}

const backupNote = (title) => (title ? `，本機修改已另存為「${title}」` : '');

// ---------------------------------------------------------------------------
// 推送、拉取與合併
// ---------------------------------------------------------------------------

// 推送目前內容，取代 base 這個 commit 上的版本；遠端在 base 之後有新版本時拋出 err.conflict
async function pushOnto(base) {
  const commit = await pushRemoteState(state, { message: remoteMessage, base });
  markSynced(state, commit);
  save();
  remoteMessage = '';
  remoteHistory = null;
  return commit;
}

// 準備和遠端 head 合併：base 是上次同步的版本（從沒同步過或取不到時為 null，無法合併）
async function prepareMerge(kind, head) {
  const remote = state.local.remote;
  const [base, remoteState] = await Promise.all([
    state.local.commit ? fetchRemoteState(remote, state.local.commit).catch(() => null) : null,
    fetchRemoteState(remote, head.sha),
  ]);
  return { kind, head, base, remote: remoteState, choices: {} };
}

// 以目前的本機內容計算合併結果（使用者在處理衝突期間可能又改了內容）
const computeMerge = (m) => (m.base ? mergeProject(m.base, state, m.remote, m.choices) : null);

// 套用合併結果：目前所在版本變成遠端 head，合併進來的本機修改算尚未推送
function applyMerge(m, { menu = true } = {}) {
  const result = computeMerge(m);
  // 有衝突選了遠端：本機的部分修改會被取代，先備份
  const backup = result.conflicts.some((c) => c.choice === 'remote') ? backupLocal() : '';
  state = result.state;
  markSynced(state, { ...m.head, hash: contentHash(m.remote) });
  save();
  if (menu) afterProjectChanged();
  else afterStateReplaced();
  return backup;
}

// 切換到指定的 commit：用遠端內容取代目前專案的行程（有本機修改時先備份）；回傳備份名稱
async function checkoutCommit(commit, { menu = true } = {}) {
  const remote = state.local.remote;
  const next = await fetchRemoteState(remote, commit.sha);
  const backup = backupLocal();
  next.local = state.local;
  state = next;
  markSynced(state, commit);
  // 重繪地圖與選單內容（旅程名稱、出發日等）
  if (menu) afterProjectChanged();
  else afterStateReplaced();
  return backup;
}

function confirmDiscard() {
  if (hasLocalChanges(state)) return confirm('目前有尚未推送的變更，切換版本後會先把目前內容另存成一個備份專案，確定嗎？');
  if (!state.local.commit && !hasNoContent(state)) return confirm('目前專案的內容還沒有和遠端同步過，切換後會先把目前內容另存成一個備份專案，確定嗎？');
  return true;
}

function showMerge(m, { menu = true } = {}) {
  remoteMerge = m;
  remoteView = 'merge';
  if (menu) renderRemotePanel();
  else openMenu();
}

function pushRemote() {
  if (!ensureToken()) return;
  remoteTask(async () => {
    try {
      const commit = await pushOnto(state.local.commit);
      toast(`已推送 ${shortSha(commit.sha)}`);
      return;
    } catch (err) {
      if (!err.conflict) throw err;
    }
    // 遠端在上次同步後有新版本：合併
    const head = await fetchRemoteHead(state.local.remote);
    if (!head) throw new Error('推送失敗，請再試一次');
    const m = await prepareMerge('push', head);
    const result = computeMerge(m);
    if (result && !result.conflicts.length) {
      applyMerge(m);
      const commit = await pushOnto(head.sha);
      toast(`遠端有新版本，已自動合併後推送 ${shortSha(commit.sha)}`, 3500);
      return;
    }
    showMerge(m);
    toast(result ? `和遠端有 ${result.conflicts.length} 項衝突，請選擇要保留的版本` : '遠端有新版本，請選擇處理方式', 3500);
  });
}

// 拉取遠端最新版本；本機有未推送的修改時合併。回傳要顯示的訊息（顯示了合併畫面時為 ''）
async function pullLatest({ menu = true } = {}) {
  const head = await fetchRemoteHead(state.local.remote);
  if (!head) return `遠端還沒有 ${REMOTE_PATH}，編輯後可從選單推送`;
  const dirty = hasLocalChanges(state);
  if (head.sha === state.local.commit) return dirty ? '遠端沒有新版本（本機有尚未推送的變更）' : '已經是最新版本';
  if (dirty) {
    const m = await prepareMerge('pull', head);
    const result = computeMerge(m);
    if (result && !result.conflicts.length) {
      applyMerge(m, { menu });
      return `已合併遠端版本 ${shortSha(head.sha)}，本機的修改仍保留（尚未推送）`;
    }
    if (result) {
      showMerge(m, { menu });
      return '';
    }
  }
  // 沒有本機修改（或無法合併）：直接換成遠端版本，需要時先備份
  if (needsBackup(state) && !confirmDiscard()) return '已取消拉取';
  const backup = await checkoutCommit(head, { menu });
  return `已更新到最新版本 ${shortSha(head.sha)}${backupNote(backup)}`;
}

function pullRemote() {
  if (!ensureToken()) return;
  remoteTask(async () => {
    const msg = await pullLatest();
    if (msg) toast(msg, 3500);
  });
}

function renderMergePanel(head, disabled) {
  const m = remoteMerge;
  const result = computeMerge(m);
  const remoteInfo = `遠端最新版本 <code>${shortSha(m.head.sha)}</code> ${esc(firstLine(m.head.message))}`;
  const pushing = m.kind === 'push';
  if (!result) {
    remoteEl.innerHTML = `${head}
      <p class="remote-note">${remoteInfo}。這個專案還沒有和遠端同步過，無法自動合併。</p>
      <div class="menu-actions">
        ${pushing ? `<button class="btn small" data-remote="merge-overwrite" ${disabled}>以本機覆蓋</button>` : ''}
        <button class="btn small" data-remote="merge-remote" ${disabled}>使用遠端（備份本機）</button>
        <span class="spacer"></span>
        <button class="btn small" data-remote="merge-cancel" ${disabled}>取消</button>
      </div>`;
    return;
  }
  const items = result.conflicts.map((c, i) => `
    <li class="merge-item">
      <div class="merge-where">${esc(c.where ? `${c.where} › ` : '')}<b>${esc(c.field)}</b></div>
      <label class="check"><input type="radio" name="merge-${i}" data-merge-key="${esc(c.key)}" value="local" ${c.choice === 'local' ? 'checked' : ''} ${disabled}>
        <span>本機：${esc(c.local)}</span></label>
      <label class="check"><input type="radio" name="merge-${i}" data-merge-key="${esc(c.key)}" value="remote" ${c.choice === 'remote' ? 'checked' : ''} ${disabled}>
        <span>遠端：${esc(c.remote)}</span></label>
    </li>`).join('');
  remoteEl.innerHTML = `${head}
    <p class="remote-note">${remoteInfo}。不衝突的修改會自動合併；下面 ${result.conflicts.length} 項兩邊都改了，請選擇要保留的版本${pushing ? '' : '（選遠端的項目會先備份本機內容）'}：</p>
    <ul class="merge-list">${items}</ul>
    <div class="menu-actions">
      <button class="btn small primary" data-remote="merge-apply" ${disabled}>${pushing ? '合併後推送' : '合併'}</button>
      ${pushing
        ? `<button class="btn small" data-remote="merge-overwrite" ${disabled}>以本機覆蓋</button>`
        : `<button class="btn small" data-remote="merge-remote" ${disabled}>使用遠端</button>`}
      <span class="spacer"></span>
      <button class="btn small" data-remote="merge-cancel" ${disabled}>取消</button>
    </div>`;
}

function closeMerge() {
  remoteMerge = null;
  remoteView = 'status';
}

function mergeAction(action) {
  const m = remoteMerge;
  if (!m) return;
  if (action === 'cancel') {
    closeMerge();
    renderRemotePanel();
    return;
  }
  if (action === 'remote' && !confirm('使用遠端版本？目前的內容會先另存成一個備份專案。')) return;
  if (action === 'overwrite' && !confirm('用本機內容覆蓋遠端最新版本？遠端的修改仍保留在版本紀錄中。')) return;
  remoteTask(async () => {
    closeMerge();
    if (action === 'remote') {
      const backup = await checkoutCommit(m.head);
      toast(`已使用遠端版本 ${shortSha(m.head.sha)}${backupNote(backup)}`, 4000);
    } else if (action === 'overwrite') {
      const commit = await pushOnto(m.head.sha);
      toast(`已以本機內容推送 ${shortSha(commit.sha)}`);
    } else {
      const backup = applyMerge(m);
      if (m.kind === 'push') {
        const commit = await pushOnto(m.head.sha);
        toast(`已合併並推送 ${shortSha(commit.sha)}${backupNote(backup)}`, 4000);
      } else {
        toast(`已合併遠端版本（尚未推送）${backupNote(backup)}`, 4000);
      }
    }
  });
}

function loadHistory(page = 1) {
  if (!ensureToken()) return;
  remoteView = 'history';
  if (page === 1) remoteHistory = null;
  remoteTask(async () => {
    const perPage = 30;
    const commits = await listRemoteCommits(state.local.remote, { page, perPage });
    remoteHistory = {
      commits: page === 1 ? commits : [...remoteHistory.commits, ...commits],
      page,
      more: commits.length === perPage,
    };
  });
}

function checkoutFromHistory(sha) {
  const commit = remoteHistory?.commits.find((c) => c.sha === sha);
  if (!commit || !confirmDiscard()) return;
  remoteTask(async () => {
    const backup = await checkoutCommit(commit);
    toast(`已切換到 ${shortSha(commit.sha)}${backupNote(backup)}`, backup ? 4000 : 2200);
  });
}

remoteEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remote]');
  if (!btn || btn.disabled) return;
  switch (btn.dataset.remote) {
    case 'settings': remoteView = 'settings'; renderRemotePanel(); break;
    case 'cancel':
    case 'back': remoteView = 'status'; renderRemotePanel(); break;
    case 'save-settings': saveRemoteSettings(); break;
    case 'unlink': unlinkRemote(); break;
    case 'clear-token':
      if (!confirm('清除這個瀏覽器中儲存的 GitHub 權杖？')) return;
      setGithubToken('');
      save();
      renderRemotePanel();
      break;
    case 'push': pushRemote(); break;
    case 'pull': pullRemote(); break;
    case 'history': loadHistory(); break;
    case 'more-history': loadHistory(remoteHistory.page + 1); break;
    case 'checkout': checkoutFromHistory(btn.dataset.sha); break;
    case 'share': remoteView = 'share'; renderRemotePanel(); break;
    case 'copy-link': copyShareLink(); break;
    case 'download-qr': downloadShareQr(); break;
    case 'merge-apply': mergeAction('apply'); break;
    case 'merge-overwrite': mergeAction('overwrite'); break;
    case 'merge-remote': mergeAction('remote'); break;
    case 'merge-cancel': mergeAction('cancel'); break;
  }
});

remoteEl.addEventListener('change', (e) => {
  if (e.target.dataset.mergeKey && remoteMerge) {
    remoteMerge.choices[e.target.dataset.mergeKey] = e.target.value;
    return;
  }
  const option = e.target.dataset.share;
  if (!option) return;
  shareOptions[option] = e.target.checked;
  renderRemotePanel();
});

remoteEl.addEventListener('input', (e) => {
  if (e.target.dataset.remoteField === 'message') remoteMessage = e.target.value;
});

remoteEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const field = e.target.dataset.remoteField;
  if (field === 'message') pushRemote();
  else if (field) saveRemoteSettings();
});

// ---------------------------------------------------------------------------
// 從網址開啟 repo：#repo=owner/repo&token=…（可和 Google 地圖的 #key=… 一起用）
// 已有專案連結到同一個 repo 時切換過去並沿用它的權杖；沒有時建立新專案。
// 接著自動拉取遠端最新版本（有未推送的變更時先詢問）。
// 讀到後從網址移除，避免權杖留在瀏覽紀錄、書籤或再分享出去的連結裡
// ---------------------------------------------------------------------------

function readRemoteFromUrl() {
  const params = new URLSearchParams(location.hash.slice(1));
  const repoText = params.get('repo')?.trim() || '';
  const token = params.get('token')?.trim() || '';
  if (!params.has('repo') && !params.has('token')) return null;
  params.delete('repo');
  params.delete('token');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  return { repoText, repo: parseRepo(repoText), token };
}

function findProjectByRepo(repo) {
  if (sameRepo(state.local.remote, repo)) return projects.activeId;
  return projects.list.find((p) => p.id !== projects.activeId && sameRepo(loadState(p.id).local.remote, repo))?.id || null;
}

function isBlankProject(s) {
  return !s.local.remote && hasNoContent(s);
}

function openRemoteFromUrl() {
  const req = readRemoteFromUrl();
  if (!req) return;
  if (!req.repoText) {
    // 只有權杖：給目前專案用
    if (!req.token) return;
    setGithubToken(req.token);
    save();
    toast('已更新目前專案的 GitHub 存取權杖');
    return;
  }
  if (!req.repo) {
    toast(`網址中的 repo 格式不正確：${req.repoText}`, 4000);
    return;
  }

  const existing = findProjectByRepo(req.repo);
  if (existing) switchProject(existing);
  else {
    // 目前是沒有內容、沒連結遠端的空白專案（例如第一次開啟）時直接沿用，不多留一個空專案
    if (!isBlankProject(state)) createProject(req.repo.repo);
    else state.title = req.repo.repo;
    state.local.remote = req.repo;
  }
  if (req.token) setGithubToken(req.token);
  save();
  afterStateReplaced();

  const name = remoteLabel(state.local.remote);
  if (!getGithubToken()) {
    toast(`請設定 ${name} 的存取權杖`, 4000);
    remoteView = 'settings';
    openMenu();
    return;
  }
  // 拉取最新版本：本機有未推送的修改時合併，需要時先備份
  remoteTask(async () => {
    const msg = await pullLatest({ menu: false });
    if (msg) toast(`已開啟 ${name}：「${state.title}」。${msg}`, 4000);
  });
}

openRemoteFromUrl();
// 頁面已開啟時貼上新的連結只會改變 #…：Google 地圖金鑰要重新載入才會生效，其他直接處理
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).has('key')) location.reload();
  else openRemoteFromUrl();
});
