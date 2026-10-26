'use strict';

// ===========================================================================
// 遠端（GitHub REST API）：把專案存成 repo 中的一個 JSON 檔，用 commit 記錄版本。
// 只處理請求與資料轉換，不碰 DOM；畫面與操作流程在 remote.js。
//
//   remote = { owner, repo }；分支與檔案路徑固定（REMOTE_BRANCH、REMOTE_PATH）
//
// 存取權杖（token）存在各專案的 local，只在這個瀏覽器，不會推送也不會匯出。
// ===========================================================================

const GITHUB_API = 'https://api.github.com';
// 舊版所有專案共用一個權杖；專案沒有自己的權杖時沿用
const LEGACY_TOKEN_KEY = 'map-planner-github-token';

function getGithubToken(s = state) {
  if (s.local.token) return s.local.token;
  try { return localStorage.getItem(LEGACY_TOKEN_KEY) || ''; } catch { return ''; }
}

// 呼叫端負責儲存專案
function setGithubToken(token, s = state) {
  s.local.token = token;
  if (!token) {
    try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch { /* ignore */ }
  }
}

// 同一個 repo（GitHub 的 owner / repo 名稱不分大小寫）
function sameRepo(a, b) {
  return !!(a && b) && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

// 支援「owner/repo」或 GitHub 網址（https://github.com/owner/repo(.git)）
function parseRepo(input) {
  const m = String(input || '').trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function remoteLabel(remote) {
  return `${remote.owner}/${remote.repo}`;
}

// 分支與檔案路徑固定：一個 repo 存一個專案
const REMOTE_BRANCH = 'main';
const REMOTE_PATH = 'plan.json';

// 版本紀錄另外顯示 commit 時間，訊息不重複帶日期
function defaultCommitMessage(s) {
  return `更新「${s.title || '旅程'}」`;
}

// ---------------------------------------------------------------------------
// 專案內容：推送的檔案不含 local；判斷是否有變更時另外忽略只影響畫面的欄位
// ---------------------------------------------------------------------------

function remoteContent(s) {
  const { local, ...rest } = s;
  return JSON.stringify(rest, null, 2);
}

// 切換天數、區塊或模式不算變更
function contentHash(s) {
  const { local, activeDayId, activeSectionId, dayOpen, mode, ...rest } = s;
  const text = JSON.stringify({ ...rest, library: { ...rest.library, activeCollectionId: null } });
  // cyrb53
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// 已連結遠端且推送或拉取過，之後內容又有改動
function hasLocalChanges(s) {
  return !!(s.local.remote && s.local.commit && contentHash(s) !== s.local.syncedHash);
}

// 記錄目前所在的 commit（推送或切換版本後呼叫）；
// 推送時用送出當下的內容 hash（等待回應期間的編輯仍算未推送的變更）
function markSynced(s, commit) {
  s.local.commit = commit.sha;
  s.local.commitMessage = commit.message;
  s.local.commitDate = commit.date;
  s.local.syncedHash = commit.hash || contentHash(s);
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// 請求
// ---------------------------------------------------------------------------

class GithubError extends Error {
  constructor(message, status, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function ghRequest(path, { method = 'GET', body, raw = false } = {}) {
  const token = getGithubToken();
  if (!token) throw new GithubError('尚未設定 GitHub 存取權杖', 0);
  let res;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GithubError('無法連線到 GitHub', 0);
  }
  if (res.ok) return raw ? res.text() : res.json();
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch { /* ignore */ }
  const messages = {
    401: '存取權杖無效或已過期',
    403: '權杖沒有這個 repo 的權限（或已達 API 使用上限）',
    404: '找不到 repo、分支或檔案（也可能是權杖沒有這個 repo 的權限）',
    409: '遠端已有更新的版本',
  };
  throw new GithubError(messages[res.status] || `GitHub 錯誤 ${res.status}${detail ? `：${detail}` : ''}`, res.status, detail);
}

const repoPath = (remote) => `/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}`;
const filePath = () => REMOTE_PATH.split('/').map(encodeURIComponent).join('/');

function toCommit(c) {
  return {
    sha: c.sha,
    message: c.commit.message,
    date: c.commit.committer?.date || c.commit.author?.date || '',
    author: c.author?.login || c.commit.author?.name || '',
  };
}

// 這個檔案在分支上的版本紀錄（新到舊）；檔案還不存在或 repo 是空的時回傳 []
async function listRemoteCommits(remote, { page = 1, perPage = 30 } = {}) {
  const q = new URLSearchParams({ path: REMOTE_PATH, sha: REMOTE_BRANCH, per_page: perPage, page });
  try {
    return (await ghRequest(`${repoPath(remote)}/commits?${q}`)).map(toCommit);
  } catch (err) {
    if (err.status === 409) return []; // 空的 repo
    throw err;
  }
}

async function fetchRemoteHead(remote) {
  return (await listRemoteCommits(remote, { perPage: 1 }))[0] || null;
}

// 取得某個 commit（或分支）上的專案內容
async function fetchRemoteState(remote, ref) {
  const q = new URLSearchParams({ ref });
  const text = await ghRequest(`${repoPath(remote)}/contents/${filePath()}?${q}`, { raw: true });
  let data;
  try { data = JSON.parse(text); } catch { throw new GithubError('遠端檔案不是 JSON', 0); }
  const s = normalizeState(data);
  if (!s) throw new GithubError('遠端檔案不是本工具的行程格式', 0);
  return s;
}

// 檔案在某個 commit 上的 blob sha；不存在時為 null
async function fetchFileSha(remote, ref) {
  const q = new URLSearchParams({ ref });
  try {
    return (await ghRequest(`${repoPath(remote)}/contents/${filePath()}?${q}`)).sha;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// 推送專案，取代 base 這個 commit 上的檔案版本（null 表示建立新檔案）。
// 送出的是 base 版本的 blob sha，由 GitHub 檢查：檔案在 base 之後被別人改過時拒絕（409），
// 檔案已存在卻沒有 base 時也拒絕（422），兩種都拋出 err.conflict，不會在檢查與上傳之間被別人插隊而默默覆蓋。
// 要覆蓋別人的版本時，以遠端最新的 commit 作為 base。
async function pushRemoteState(s, { message = '', base = s.local.commit } = {}) {
  const remote = s.local.remote;
  const sha = base ? await fetchFileSha(remote, base) : null;
  const hash = contentHash(s);
  let res;
  try {
    res = await ghRequest(`${repoPath(remote)}/contents/${filePath()}`, {
      method: 'PUT',
      body: {
        message: message.trim() || defaultCommitMessage(s),
        content: utf8ToBase64(remoteContent(s)),
        branch: REMOTE_BRANCH,
        ...(sha ? { sha } : {}),
      },
    });
  } catch (err) {
    if (err.status === 409 || (err.status === 422 && /sha/i.test(err.detail))) {
      const conflict = new GithubError('遠端已有更新的版本', 409);
      conflict.conflict = true;
      throw conflict;
    }
    throw err;
  }
  return {
    sha: res.commit.sha,
    message: res.commit.message,
    date: res.commit.committer?.date || new Date().toISOString(),
    hash,
  };
}
