'use strict';

// ── 상수 ──────────────────────────────────────────────────
const PAGE_SIZE = 30;

const LS = {
  FAC_ADDED:   'medicalmap_added',
  FAC_EDITED:  'medicalmap_edited',
  FAC_DELETED: 'medicalmap_deleted',
  CLI_ADDED:   'medicalmap_cli_added',
  CLI_EDITED:  'medicalmap_cli_edited',
  CLI_DELETED: 'medicalmap_cli_deleted',
};

const KAKAO_KEY = '7a76de0b02013eb8152525457963d805';

// ── 상태 ──────────────────────────────────────────────────
const app = {
  tab: 'facility',
  facilities: [], clients: [],
  filtered: [],
  page: 1,
  search: '',
  region1: '', region2: '',
  editingId: null,
  pendingLat: null, pendingLng: null,
  regionIndex: {},
};

// ── 유틸 ──────────────────────────────────────────────────
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const NORMALIZE = {
  '서울':'서울특별시','서울시':'서울특별시','부산':'부산광역시','대구':'대구광역시',
  '인천':'인천광역시','광주':'광주광역시','대전':'대전광역시','울산':'울산광역시',
  '세종':'세종특별자치시','경기':'경기도','강원':'강원특별자치도','강원도':'강원특별자치도',
  '충북':'충청북도','충남':'충청남도','전남':'전라남도','전북':'전북특별자치도',
  '전라북도':'전북특별자치도','경북':'경상북도','경남':'경상남도',
  '제주':'제주특별자치도','제주도':'제주특별자치도',
};
function normalize(n) { return NORMALIZE[n] || n; }

// ── 데이터 로드 ──────────────────────────────────────────
async function init() {
  const [fr, cr] = await Promise.all([
    fetch('data/facilities.json').then(r => r.json()),
    fetch('data/clients.json').then(r => r.json()).catch(() => []),
  ]);

  // 검진기관 머지
  const fe = lsGet(LS.FAC_EDITED) || {};
  const fa = lsGet(LS.FAC_ADDED)  || [];
  const fd = lsGet(LS.FAC_DELETED)|| [];
  app.facilities = [
    ...fr.filter(f => !fd.includes(String(f.id))).map(f => {
      const e = fe[f.id] || fe[String(f.id)];
      const obj = e ? { ...f, ...e } : f;
      return { ...obj, region1: normalize(obj.region1 || '') };
    }),
    ...fa.filter(f => !fd.includes(String(f.id))).map(f => ({ ...f, isNew: true, region1: normalize(f.region1||'') })),
  ];

  // 고객사 머지
  const ce = lsGet(LS.CLI_EDITED) || {};
  const ca = lsGet(LS.CLI_ADDED)  || [];
  const cd = lsGet(LS.CLI_DELETED)|| [];
  app.clients = [
    ...cr.filter(c => !cd.includes(String(c.id))).map(c => {
      const e = ce[c.id] || ce[String(c.id)];
      return e ? { ...c, ...e } : c;
    }),
    ...ca.filter(c => !cd.includes(String(c.id))).map(c => ({ ...c, isNew: true })),
  ];

  buildRegionIndex();
  populateRegion1();
  renderTable();
  updateTabCounts();
}

function buildRegionIndex() {
  app.regionIndex = {};
  const list = app.tab === 'facility' ? app.facilities : app.clients;
  list.forEach(item => {
    const r1 = item.region1 || '';
    if (!app.regionIndex[r1]) app.regionIndex[r1] = new Set();
    app.regionIndex[r1].add(item.region2 || '');
  });
}

// ── 탭 전환 ──────────────────────────────────────────────
window.switchTab = function(tab) {
  app.tab = tab;
  app.page = 1;
  app.search = '';
  app.region1 = '';
  app.region2 = '';
  document.getElementById('list-search').value = '';
  document.getElementById('list-region1').value = '';
  document.getElementById('list-region2').value = '';
  document.getElementById('list-search-clear').classList.add('hidden');
  document.getElementById('tab-facility').classList.toggle('active', tab === 'facility');
  document.getElementById('tab-client').classList.toggle('active', tab === 'client');
  buildRegionIndex();
  populateRegion1();
  renderTable();
};

function updateTabCounts() {
  document.getElementById('fac-count').textContent = `(${app.facilities.length})`;
  document.getElementById('cli-count').textContent = `(${app.clients.length})`;
}

// ── 지역 드롭다운 ────────────────────────────────────────
function populateRegion1() {
  const sel = document.getElementById('list-region1');
  sel.innerHTML = '<option value="">전체 시/도</option>';
  Object.keys(app.regionIndex).sort().forEach(r1 => {
    if (!r1) return;
    const o = document.createElement('option');
    o.value = r1; o.textContent = r1; sel.appendChild(o);
  });
  document.getElementById('list-region2').innerHTML = '<option value="">전체 구/군</option>';
  document.getElementById('list-region2').disabled = true;
}

function populateRegion2(r1) {
  const sel = document.getElementById('list-region2');
  sel.innerHTML = '<option value="">전체 구/군</option>';
  if (!r1) { sel.disabled = true; return; }
  sel.disabled = false;
  [...(app.regionIndex[r1] || [])].sort().forEach(r2 => {
    if (!r2) return;
    const o = document.createElement('option');
    o.value = r2; o.textContent = r2; sel.appendChild(o);
  });
}

// ── 테이블 렌더링 ─────────────────────────────────────────
function getFilteredData() {
  const list = app.tab === 'facility' ? app.facilities : app.clients;
  const q = app.search.toLowerCase();
  return list.filter(item =>
    (!q || item.name.toLowerCase().includes(q)) &&
    (!app.region1 || item.region1 === app.region1) &&
    (!app.region2 || item.region2 === app.region2)
  );
}

function renderTable() {
  const data = getFilteredData();
  app.filtered = data;
  const start = (app.page - 1) * PAGE_SIZE;
  const page  = data.slice(start, start + PAGE_SIZE);

  const isFac = app.tab === 'facility';
  const head = document.getElementById('table-head');
  head.innerHTML = `<tr>
    <th class="col-no">No</th>
    <th class="col-name">이름</th>
    <th class="col-r1">시/도</th>
    <th class="col-r2">구/군</th>
    <th class="col-addr">주소</th>
    ${isFac ? '' : '<th class="col-detail">상세주소</th>'}
    <th class="col-loc">위치</th>
    <th class="col-act">관리</th>
  </tr>`;

  const body = document.getElementById('table-body');
  if (!page.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty-cell">데이터가 없습니다.</td></tr>`;
    renderPagination(0);
    updateInfo(0, data.length);
    return;
  }

  body.innerHTML = page.map((item, i) => {
    const sid = String(item.id).replace(/'/g, "\\'");
    const no  = start + i + 1;
    const newBadge = item.isNew ? '<span class="badge-new">신규</span>' : '';
    const locIcon  = item.lat && item.lng ? '📍' : '<span style="color:#E53935">⚠</span>';
    return `<tr data-id="${item.id}">
      <td class="col-no">${no}</td>
      <td class="col-name">${esc(item.name)}${newBadge}</td>
      <td class="col-r1">${esc(item.region1||'')}</td>
      <td class="col-r2">${esc(item.region2||'')}</td>
      <td class="col-addr">${esc(item.address||'')}</td>
      ${isFac ? '' : `<td class="col-detail">${esc(item.detail||'')}</td>`}
      <td class="col-loc">${locIcon}</td>
      <td class="col-act">
        <button class="btn-edit" onclick="openModal('${sid}')">수정</button>
        <button class="btn-del"  onclick="deleteItem('${sid}')">삭제</button>
      </td>
    </tr>`;
  }).join('');

  renderPagination(data.length);
  updateInfo(page.length, data.length);
}

function updateInfo(shown, total) {
  document.getElementById('list-info').textContent =
    `${total.toLocaleString()}건 중 ${shown}건 표시`;
}

function renderPagination(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const el = document.getElementById('pagination');
  if (pages <= 1) { el.innerHTML = ''; return; }
  const buttons = [];
  const p = app.page;
  if (p > 1) buttons.push(`<button onclick="goPage(${p-1})">◀</button>`);
  const start = Math.max(1, p - 3), end = Math.min(pages, p + 3);
  if (start > 1) buttons.push(`<button onclick="goPage(1)">1</button>`, start > 2 ? '<span>…</span>' : '');
  for (let i = start; i <= end; i++)
    buttons.push(`<button onclick="goPage(${i})" class="${i===p?'active':''}">${i}</button>`);
  if (end < pages) buttons.push(end < pages-1 ? '<span>…</span>' : '', `<button onclick="goPage(${pages})">${pages}</button>`);
  if (p < pages) buttons.push(`<button onclick="goPage(${p+1})">▶</button>`);
  el.innerHTML = buttons.join('');
}

window.goPage = function(p) { app.page = p; renderTable(); window.scrollTo(0,0); };

// ── 이벤트 ───────────────────────────────────────────────
document.getElementById('list-search').addEventListener('input', function() {
  app.search = this.value.trim();
  app.page = 1;
  document.getElementById('list-search-clear').classList.toggle('hidden', !this.value);
  renderTable();
});
document.getElementById('list-search-clear').addEventListener('click', () => {
  app.search = '';
  document.getElementById('list-search').value = '';
  document.getElementById('list-search-clear').classList.add('hidden');
  app.page = 1;
  renderTable();
});
document.getElementById('list-region1').addEventListener('change', function() {
  app.region1 = this.value;
  app.region2 = '';
  app.page = 1;
  populateRegion2(this.value);
  renderTable();
});
document.getElementById('list-region2').addEventListener('change', function() {
  app.region2 = this.value;
  app.page = 1;
  renderTable();
});

// ── CRUD 모달 ─────────────────────────────────────────────
window.openModal = function(id) {
  app.editingId = id;
  app.pendingLat = null;
  app.pendingLng = null;

  const list = app.tab === 'facility' ? app.facilities : app.clients;
  const isFac = app.tab === 'facility';

  document.getElementById('detail-wrap').style.display = isFac ? 'none' : 'block';

  if (id !== null) {
    const item = list.find(x => String(x.id) === String(id));
    if (!item) return;
    document.getElementById('modal-title').textContent = isFac ? '검진기관 수정' : '고객사 수정';
    document.getElementById('m-name').value    = item.name || '';
    document.getElementById('m-address').value = item.address || '';
    document.getElementById('m-detail').value  = item.detail || '';
    document.getElementById('m-region1').value = item.region1 || '';
    document.getElementById('m-region2').value = item.region2 || '';
    app.pendingLat = item.lat;
    app.pendingLng = item.lng;
    document.getElementById('m-loc-status').textContent =
      item.lat ? `📍 ${parseFloat(item.lat).toFixed(5)}, ${parseFloat(item.lng).toFixed(5)}` : '⚠️ 위치 없음';
  } else {
    document.getElementById('modal-title').textContent = isFac ? '검진기관 추가' : '고객사 추가';
    ['m-name','m-address','m-detail','m-region1','m-region2'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('m-loc-status').textContent = '';
    document.getElementById('geocode-status').textContent = '';
  }
  document.getElementById('edit-modal').classList.remove('hidden');
};

window.closeModal = function() {
  document.getElementById('edit-modal').classList.add('hidden');
};

window.saveModal = function() {
  const name    = document.getElementById('m-name').value.trim();
  const address = document.getElementById('m-address').value.trim();
  if (!name)    { alert('이름을 입력해 주세요.'); return; }
  if (!address) { alert('주소를 입력해 주세요.'); return; }

  const data = {
    name, address,
    detail:  document.getElementById('m-detail').value.trim(),
    region1: normalize(document.getElementById('m-region1').value.trim()),
    region2: document.getElementById('m-region2').value.trim(),
    lat: app.pendingLat, lng: app.pendingLng,
  };

  const isFac = app.tab === 'facility';
  const LS_ADDED  = isFac ? LS.FAC_ADDED  : LS.CLI_ADDED;
  const LS_EDITED = isFac ? LS.FAC_EDITED : LS.CLI_EDITED;

  if (app.editingId === null) {
    const added = lsGet(LS_ADDED) || [];
    const nid = (isFac ? 'new_' : 'c_') + Date.now();
    added.push({ id: nid, ...data, isNew: true });
    lsSet(LS_ADDED, added);
  } else {
    const edited = lsGet(LS_EDITED) || {};
    edited[app.editingId] = data;
    lsSet(LS_EDITED, edited);
  }

  closeModal();
  init();
};

window.deleteItem = function(id) {
  const list = app.tab === 'facility' ? app.facilities : app.clients;
  const item = list.find(x => String(x.id) === String(id));
  if (!item || !confirm(`"${item.name}"을(를) 삭제하시겠습니까?\n삭제 후 복구할 수 없습니다.`)) return;

  const isFac = app.tab === 'facility';
  const LS_DEL = isFac ? LS.FAC_DELETED : LS.CLI_DELETED;
  const deleted = lsGet(LS_DEL) || [];
  deleted.push(String(id));
  lsSet(LS_DEL, deleted);
  init();
};

// ── 지오코딩 (카카오 REST API) ────────────────────────────
document.getElementById('geocode-btn').addEventListener('click', async () => {
  const addr = document.getElementById('m-address').value.trim();
  if (!addr) { alert('주소를 입력해 주세요.'); return; }
  const statusEl = document.getElementById('geocode-status');
  statusEl.textContent = '검색 중...';
  try {
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(addr)}`;
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    const data = await res.json();
    const docs = data.documents || [];
    if (!docs.length) { statusEl.textContent = '주소를 찾을 수 없습니다.'; return; }
    const d = docs[0];
    app.pendingLat = parseFloat(d.y);
    app.pendingLng = parseFloat(d.x);
    document.getElementById('m-region1').value = normalize(d.address?.region_1depth_name || '');
    document.getElementById('m-region2').value = d.address?.region_2depth_name || '';
    document.getElementById('m-loc-status').textContent =
      `📍 ${app.pendingLat.toFixed(5)}, ${app.pendingLng.toFixed(5)}`;
    statusEl.textContent = '✅ 위치 검색 완료';
  } catch (e) {
    statusEl.textContent = '오류가 발생했습니다.';
  }
});

// ── 시작 ─────────────────────────────────────────────────
init();
