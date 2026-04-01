'use strict';

const RENDER_CHUNK = 100;
const LS_ADDED    = 'medicalmap_added';
const LS_EDITED   = 'medicalmap_edited';
const LS_DELETED  = 'medicalmap_deleted';
const LS_GROUPS   = 'medicalmap_groups';
const LS_GMEMBERS = 'medicalmap_group_members';

const REGION1_NORMALIZE = {
  '서울': '서울특별시', '서울시': '서울특별시',
  '부산': '부산광역시', '부산시': '부산광역시',
  '대구': '대구광역시', '대구시': '대구광역시',
  '인천': '인천광역시', '인천시': '인천광역시',
  '광주': '광주광역시', '광주시': '광주광역시',
  '대전': '대전광역시', '대전시': '대전광역시',
  '울산': '울산광역시', '울산시': '울산광역시',
  '세종': '세종특별자치시', '세종시': '세종특별자치시',
  '경기': '경기도',
  '강원': '강원특별자치도', '강원도': '강원특별자치도',
  '충북': '충청북도', '충남': '충청남도',
  '전남': '전라남도', '전북': '전북특별자치도',
  '전라북도': '전북특별자치도',
  '경북': '경상북도', '경남': '경상남도',
  '제주': '제주특별자치도', '제주도': '제주특별자치도',
};
function normalizeRegion1(n) { return REGION1_NORMALIZE[n] || n; }

// ── LocalStorage ─────────────────────────────────────────
function lsGet(k)        { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v)     { localStorage.setItem(k, JSON.stringify(v)); }
function getAdded()      { return lsGet(LS_ADDED)    || []; }
function getEdited()     { return lsGet(LS_EDITED)   || {}; }
function getDeleted()    { return lsGet(LS_DELETED)  || []; }
function getGroups()     { return lsGet(LS_GROUPS)   || []; }
function getGMembers()   { return lsGet(LS_GMEMBERS) || {}; }
function saveAdded(a)    { lsSet(LS_ADDED,    a); }
function saveEdited(o)   { lsSet(LS_EDITED,   o); }
function saveDeleted(a)  { lsSet(LS_DELETED,  a); }
function saveGroups(g)   { lsSet(LS_GROUPS,   g); }
function saveGMembers(m) { lsSet(LS_GMEMBERS, m); }

function extractRegions(addr) {
  const t = String(addr).trim().split(/\s+/);
  return { region1: t[0] || '기타', region2: t[1] || '기타' };
}

// ── 컬러 유틸 ─────────────────────────────────────────────
function darkenHex(hex) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  const d = v => Math.round(v * 0.65).toString(16).padStart(2, '0');
  return `#${d(r)}${d(g)}${d(b)}`;
}

// ── 상태 ─────────────────────────────────────────────────
const state = {
  allFacilities: [], filteredFacilities: [],
  activeRegion1: null, activeRegion2: null,
  activeGroups: new Set(), searchQuery: '', mapBoundsActive: false,
  regionIndex: {}, renderedCount: 0, activeCardId: null,
  markerMap: new Map(), openOverlay: null,
  editingId: null, pendingLat: null, pendingLng: null,
};

let map, clusterer, geocoder;

// ── 마커 이미지 ───────────────────────────────────────────
function makeDotImg(fill, stroke) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="6.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
  </svg>`;
  const size = new kakao.maps.Size(16, 16);
  const off  = new kakao.maps.Point(8, 8);
  return new kakao.maps.MarkerImage(
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), size, { offset: off });
}
const IMG_NORMAL  = () => makeDotImg('#2196F3', '#1565C0');
const IMG_ACTIVE  = () => makeDotImg('#FF5722', '#BF360C');
const IMG_NEW     = () => makeDotImg('#43A047', '#1B5E20');
const IMG_GROUP   = c  => makeDotImg(c, darkenHex(c));

// ── 지도 초기화 ──────────────────────────────────────────
function initMap() {
  map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(36.5, 127.8),
    level: 8, draggable: true, scrollwheel: true,
  });
  map.addControl(new kakao.maps.ZoomControl(),    kakao.maps.ControlPosition.RIGHT);
  map.addControl(new kakao.maps.MapTypeControl(), kakao.maps.ControlPosition.TOPRIGHT);

  clusterer = new kakao.maps.MarkerClusterer({
    map, averageCenter: true, minLevel: 5,
    styles: [{
      width:'44px', height:'44px', background:'rgba(21,101,192,0.85)',
      borderRadius:'50%', color:'#fff', textAlign:'center',
      lineHeight:'44px', fontSize:'13px', fontWeight:'700',
    }],
  });
  geocoder = new kakao.maps.services.Geocoder();
  kakao.maps.event.addListener(map, 'dragend',      onMapMoved);
  kakao.maps.event.addListener(map, 'zoom_changed', onMapMoved);
}

function onMapMoved() {
  document.getElementById('map-search-btn').classList.remove('hidden');
}

// ── 데이터 로드 ──────────────────────────────────────────
async function loadData() {
  const res  = await fetch('data/facilities.json');
  const base = await res.json();
  mergeAndSet(base);
  populateRegion1Select();
  populateGroupSelects();
  renderGroupLegend();
  updateStats();
  render();
  fitAllMarkers();
}

function mergeAndSet(base) {
  const edited  = getEdited();
  const added   = getAdded();
  const deleted = getDeleted();

  const merged = base
    .filter(f => !deleted.includes(String(f.id)))
    .map(f => {
      const e = edited[f.id] || edited[String(f.id)];
      const obj = e ? { ...f, ...e } : f;
      return { ...obj, region1: normalizeRegion1(obj.region1 || '') };
    });

  const newItems = added
    .filter(f => !deleted.includes(String(f.id)))
    .map(f => ({ ...f, isNew: true, region1: normalizeRegion1(f.region1 || '') }));

  state.allFacilities = [...merged, ...newItems];
  state.regionIndex   = buildRegionIndex(state.allFacilities);
}

function buildRegionIndex(facs) {
  const idx = {};
  for (const f of facs) {
    const r1 = normalizeRegion1(f.region1 || '');
    if (!idx[r1]) idx[r1] = new Set();
    idx[r1].add(f.region2);
  }
  for (const r in idx) idx[r] = [...idx[r]].sort();
  return idx;
}

// ── 지역 드롭다운 ─────────────────────────────────────────
function populateRegion1Select() {
  const sel = document.getElementById('region1-select');
  sel.innerHTML = '<option value="">전체 지역</option>';
  for (const r of Object.keys(state.regionIndex).sort()) {
    const o = document.createElement('option');
    o.value = r; o.textContent = r; sel.appendChild(o);
  }
}
function populateRegion2Select(r1) {
  const sel = document.getElementById('region2-select');
  sel.innerHTML = '<option value="">전체 구역</option>';
  if (!r1) { sel.disabled = true; return; }
  sel.disabled = false;
  for (const r of (state.regionIndex[r1] || [])) {
    const o = document.createElement('option');
    o.value = r; o.textContent = r; sel.appendChild(o);
  }
}

// ── 그룹 드롭다운 & 범례 ──────────────────────────────────
function populateGroupSelects() {
  const groups = getGroups();
  const msel = document.getElementById('modal-group');
  const mcur = msel.value;
  msel.innerHTML = '<option value="">그룹 없음</option>';
  groups.forEach(g => {
    const o = document.createElement('option');
    o.value = g.id; o.textContent = g.name; msel.appendChild(o);
  });
  msel.value = mcur;
}

function renderGroupLegend() {
  const groups = getGroups();
  const el = document.getElementById('group-legend');
  const clearBtn = document.getElementById('group-filter-clear');
  if (!groups.length) {
    el.innerHTML = '<span class="legend-none">그룹 없음</span>';
    clearBtn.classList.add('hidden');
    return;
  }
  el.innerHTML = groups.map(g => {
    const active = state.activeGroups.has(g.id);
    return `<span class="legend-item${active ? ' active' : ''}" data-gid="${g.id}"
      style="${active ? `background:${g.color}22;border-color:${g.color};` : ''}"
      onclick="window.toggleGroupFilter('${g.id}')">
      <span class="legend-dot" style="background:${g.color};"></span>
      <span class="legend-name">${escHtml(g.name)}</span>
    </span>`;
  }).join('');
  clearBtn.classList.toggle('hidden', state.activeGroups.size === 0);
}

window.toggleGroupFilter = function(gid) {
  if (state.activeGroups.has(gid)) state.activeGroups.delete(gid);
  else state.activeGroups.add(gid);
  renderGroupLegend();
  applyFilter();
};

// ── 전체 마커 맞춤 ────────────────────────────────────────
function fitAllMarkers() {
  const pts = state.allFacilities.filter(f => f.lat && f.lng);
  if (!pts.length) return;
  const b = new kakao.maps.LatLngBounds();
  pts.forEach(f => b.extend(new kakao.maps.LatLng(f.lat, f.lng)));
  map.setBounds(b, 60);
}

// ── 필터 이벤트 ───────────────────────────────────────────
document.getElementById('region1-select').addEventListener('change', function () {
  state.activeRegion1 = this.value || null;
  state.activeRegion2 = null;
  document.getElementById('region2-select').value = '';
  populateRegion2Select(state.activeRegion1);
  applyFilter();
});
document.getElementById('region2-select').addEventListener('change', function () {
  state.activeRegion2 = this.value || null;
  applyFilter();
});
document.getElementById('group-filter-clear').addEventListener('click', () => {
  state.activeGroups = new Set();
  renderGroupLegend();
  applyFilter();
});
document.getElementById('reset-btn').addEventListener('click', () => {
  state.activeRegion1 = null; state.activeRegion2 = null;
  state.searchQuery   = '';   state.activeGroups  = new Set();
  state.mapBoundsActive = false;
  document.getElementById('region1-select').value = '';
  document.getElementById('region2-select').value = '';
  document.getElementById('search-input').value   = '';
  document.getElementById('search-clear').classList.add('hidden');
  document.getElementById('map-search-btn').classList.add('hidden');
  renderGroupLegend();
  populateRegion2Select(null);
  applyFilter(false); // 지도 배율/위치 유지
});

// ── 검색 이벤트 ───────────────────────────────────────────
document.getElementById('search-input').addEventListener('input', function () {
  state.searchQuery = this.value.trim();
  document.getElementById('search-clear').classList.toggle('hidden', !state.searchQuery);
  applyFilter();
});
document.getElementById('search-clear').addEventListener('click', function () {
  state.searchQuery = '';
  document.getElementById('search-input').value = '';
  this.classList.add('hidden');
  applyFilter();
});

// ── 현 지도에서 검색 ──────────────────────────────────────
document.getElementById('map-search-btn').addEventListener('click', () => {
  state.mapBoundsActive = true;
  document.getElementById('map-search-btn').classList.add('hidden');
  applyFilter(false);
});

// ── 필터 적용 ─────────────────────────────────────────────
function applyFilter(moveMap = true) {
  closeOverlay();

  // 검색어가 있으면 다른 필터와 무관하게 전체 기관에서 검색
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    state.filteredFacilities = state.allFacilities.filter(f => f.name.toLowerCase().includes(q));
    state.renderedCount = 0;
    state.activeCardId  = null;
    render();
    return;
  }

  let result = state.allFacilities;
  if (state.activeRegion1) result = result.filter(f => f.region1 === state.activeRegion1);
  if (state.activeRegion2) result = result.filter(f => f.region2 === state.activeRegion2);
  if (state.activeGroups.size > 0) {
    const members = getGMembers();
    result = result.filter(f => state.activeGroups.has(members[String(f.id)]));
  }
  if (state.mapBoundsActive && map) {
    const bounds = map.getBounds();
    result = result.filter(f => f.lat && f.lng && bounds.contain(new kakao.maps.LatLng(f.lat, f.lng)));
  }
  state.filteredFacilities = result;
  state.renderedCount = 0;
  state.activeCardId  = null;
  render();
  if (moveMap && state.activeRegion1) {
    const pts = result.filter(f => f.lat && f.lng);
    if (pts.length) {
      const b = new kakao.maps.LatLngBounds();
      pts.forEach(f => b.extend(new kakao.maps.LatLng(f.lat, f.lng)));
      map.setBounds(b, 50);
    }
  }
}


// ── 렌더링 ───────────────────────────────────────────────
function render() { renderMarkers(); renderListOnly(); renderListCount(); }

function renderMarkers() {
  closeOverlay();
  clusterer.clear();
  state.markerMap.clear();

  const toShow   = state.filteredFacilities.filter(f => f.lat && f.lng);
  const members  = getGMembers();
  const groups   = getGroups();
  const gColorMap = {};
  groups.forEach(g => { gColorMap[g.id] = g.color; });

  const markers = [];
  toShow.forEach(f => {
    const gid    = members[String(f.id)];
    const gColor = gid ? gColorMap[gid] : null;
    const imgNormal = gColor ? IMG_GROUP(gColor) : (f.isNew ? IMG_NEW() : IMG_NORMAL());

    const marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(f.lat, f.lng),
      image: imgNormal,
    });
    const iw = new kakao.maps.InfoWindow({ content: makeIWHtml(f), removable: true });

    kakao.maps.event.addListener(marker, 'click', () => {
      closeOverlay();
      iw.open(map, marker);
      marker.setImage(IMG_ACTIVE());
      state.openOverlay  = iw;
      ensureCardRendered(f.id);
      highlightCard(f.id);
    });

    markers.push(marker);
    state.markerMap.set(f.id, { marker, iw, imgNormal });
  });

  clusterer.addMarkers(markers);
}

function makeIWHtml(f) {
  const sid  = String(f.id).replace(/'/g, "\\'");
  const badge = f.isNew
    ? '<span style="background:#43A047;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;">신규</span>'
    : '';
  const members = getGMembers();
  const groups  = getGroups();
  const g = groups.find(x => x.id === members[String(f.id)]);
  const groupBadge = g
    ? `<span style="background:${g.color};color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;">${escHtml(g.name)}</span>`
    : '';
  return `<div style="padding:12px 14px;min-width:230px;max-width:280px;font-family:'맑은 고딕',sans-serif;">
    <div style="font-weight:700;font-size:14px;color:#1565C0;margin-bottom:4px;line-height:1.4;">${escHtml(f.name)}${badge}${groupBadge}</div>
    <div style="font-size:11px;color:#999;margin-bottom:5px;">${escHtml(f.region1)} · ${escHtml(f.region2)}</div>
    <div style="font-size:12px;color:#444;line-height:1.6;margin-bottom:10px;">${escHtml(f.address)}</div>
    <div style="display:flex;gap:6px;border-top:1px solid #eee;padding-top:8px;">
      <button onclick="window.kmapEdit('${sid}')"
        style="flex:1;padding:6px;background:#1565C0;color:#fff;border:none;border-radius:5px;font-size:12px;cursor:pointer;font-family:'맑은 고딕',sans-serif;">
        ✏️ 수정
      </button>
      <button onclick="window.kmapDelete('${sid}')"
        style="flex:1;padding:6px;background:#fff;color:#E53935;border:1px solid #E53935;border-radius:5px;font-size:12px;cursor:pointer;font-family:'맑은 고딕',sans-serif;">
        🗑️ 삭제
      </button>
    </div>
  </div>`;
}

// ── 전역 함수 (InfoWindow 버튼에서 호출) ─────────────────
window.kmapEdit = function(id) {
  closeOverlay();
  const f = state.allFacilities.find(x => String(x.id) === String(id));
  if (f) openModal(f.id);
};

window.kmapDelete = function(id) {
  const f = state.allFacilities.find(x => String(x.id) === String(id));
  if (!f) return;
  if (!confirm(`⚠️ 기관 삭제 확인\n\n"${f.name}"\n\n정말 삭제하시겠습니까?\n삭제 후에는 복구할 수 없습니다.`)) return;

  const deleted = getDeleted();
  if (!deleted.includes(String(id))) { deleted.push(String(id)); saveDeleted(deleted); }
  saveAdded(getAdded().filter(x => String(x.id) !== String(id)));

  // 그룹 멤버십도 제거
  const members = getGMembers();
  delete members[String(id)];
  saveGMembers(members);

  closeOverlay();
  reloadData();
};

window.deleteGroup = function(gid) {
  const g = getGroups().find(x => x.id === gid);
  if (!g) return;
  if (!confirm(`"${g.name}" 그룹을 삭제하시겠습니까?\n기관의 그룹 지정이 해제됩니다.`)) return;
  saveGroups(getGroups().filter(x => x.id !== gid));
  const members = getGMembers();
  for (const k in members) { if (members[k] === gid) delete members[k]; }
  saveGMembers(members);
  state.activeGroups.delete(gid);
  renderGroupManageList();
};

function closeOverlay() {
  if (state.openOverlay) { state.openOverlay.close(); state.openOverlay = null; }
  if (state.activeCardId !== null) {
    const item = state.markerMap.get(state.activeCardId);
    if (item) item.marker.setImage(item.imgNormal);
  }
}

// ── 목록 렌더링 ───────────────────────────────────────────
function renderListOnly() {
  const list = document.getElementById('facility-list');
  list.innerHTML = '';
  state.renderedCount = 0;

  if (!state.filteredFacilities.length) {
    list.innerHTML = '<div class="list-empty">검색 결과가 없습니다.</div>';
    renderListCount(); return;
  }
  appendCards(Math.min(RENDER_CHUNK, state.filteredFacilities.length));
  if (state.filteredFacilities.length > RENDER_CHUNK) appendMoreBtn();
  renderListCount();
}

function appendCards(upTo) {
  const list = document.getElementById('facility-list');
  list.querySelector('.list-more-btn')?.remove();
  const end = Math.min(upTo, state.filteredFacilities.length);
  for (let i = state.renderedCount; i < end; i++) list.appendChild(makeCard(state.filteredFacilities[i]));
  state.renderedCount = end;
}

function ensureCardRendered(id) {
  const idx = state.filteredFacilities.findIndex(f => String(f.id) === String(id));
  if (idx < 0) return;
  if (idx >= state.renderedCount) {
    appendCards(idx + 1);
    if (state.filteredFacilities.length > state.renderedCount) appendMoreBtn();
  }
}

function makeCard(f) {
  const card = document.createElement('div');
  card.className = 'facility-card' + (f.isNew ? ' is-new' : '');
  card.dataset.id = String(f.id);

  const q    = state.searchQuery.toLowerCase();
  const name = q ? highlightText(f.name, q) : escHtml(f.name);
  const noLoc = !f.lat || !f.lng;

  const members = getGMembers();
  const groups  = getGroups();
  const g = groups.find(x => x.id === members[String(f.id)]);
  const groupBadge = g
    ? `<span class="group-badge" style="background:${g.color};">${escHtml(g.name)}</span>`
    : '';

  card.innerHTML = `
    <div class="card-main">
      <div class="facility-name">${name}${f.isNew ? '<span class="new-badge">신규</span>' : ''}${groupBadge}</div>
      <div class="facility-region">${escHtml(f.region1)} · ${escHtml(f.region2)}</div>
      <div class="facility-address">${escHtml(f.address)}</div>
      ${noLoc ? '<span class="no-location-badge">위치 미등록</span>' : ''}
    </div>
    <div class="card-actions">
      <button class="btn-group"  title="그룹 지정">🏷</button>
      <button class="btn-edit"   title="수정">✏️</button>
      <button class="btn-delete" title="삭제">🗑️</button>
    </div>
  `;

  card.querySelector('.card-main').addEventListener('click', () => {
    if (f.lat && f.lng) {
      closeOverlay();
      map.setCenter(new kakao.maps.LatLng(f.lat, f.lng));
      map.setLevel(4);
      const item = state.markerMap.get(f.id);
      if (item) {
        item.iw.open(map, item.marker);
        item.marker.setImage(IMG_ACTIVE());
        state.openOverlay = item.iw;
      }
    }
    highlightCard(f.id);
  });

  card.querySelector('.btn-group').addEventListener('click', e => {
    e.stopPropagation();
    openGroupDropdown(e.currentTarget, f.id);
  });

  card.querySelector('.btn-edit').addEventListener('click', e => {
    e.stopPropagation();
    openModal(f.id);
  });

  card.querySelector('.btn-delete').addEventListener('click', e => {
    e.stopPropagation();
    window.kmapDelete(f.id);
  });

  return card;
}

function highlightText(text, q) {
  const safe = escHtml(text);
  const esc  = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(esc, 'gi'), m => `<mark>${m}</mark>`);
}

function appendMoreBtn() {
  const list = document.getElementById('facility-list');
  const rem  = state.filteredFacilities.length - state.renderedCount;
  const btn  = document.createElement('button');
  btn.className   = 'list-more-btn';
  btn.textContent = `더 보기 (${rem}개 남음)`;
  btn.addEventListener('click', () => {
    appendCards(state.renderedCount + RENDER_CHUNK);
    if (state.renderedCount < state.filteredFacilities.length) appendMoreBtn();
  });
  list.appendChild(btn);
}

function highlightCard(id) {
  document.querySelectorAll('.facility-card.active').forEach(el => el.classList.remove('active'));
  state.activeCardId = id;
  const card = document.querySelector(`.facility-card[data-id="${String(id)}"]`);
  if (card) { card.classList.add('active'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

function renderListCount() {
  let label = '전체 기관';
  if (state.searchQuery)        label = `"${state.searchQuery}" 검색 결과`;
  else if (state.mapBoundsActive) label = '현 지도 영역';
  else if (state.activeGroups.size > 0) {
    const groups = getGroups();
    const names = [...state.activeGroups].map(gid => groups.find(g => g.id === gid)?.name).filter(Boolean);
    label = `그룹: ${names.join(', ')}`;
  }
  else if (state.activeRegion1) label = state.activeRegion1 + (state.activeRegion2 ? ' ' + state.activeRegion2 : '');
  document.getElementById('list-count').textContent = label;
  document.getElementById('list-total').textContent = `${state.filteredFacilities.length.toLocaleString()}개`;
}

function updateStats() {
  const total = state.allFacilities.length;
  const wc    = state.allFacilities.filter(f => f.lat && f.lng).length;
  const nc    = getAdded().length;
  const dc    = getDeleted().length;
  const gc    = getGroups().length;
  document.getElementById('stats').innerHTML =
    `전체: <b>${total}개</b> · 지도표시: <b>${wc}개</b>` +
    (gc ? ` · 그룹: <b>${gc}개</b>` : '') +
    (nc ? ` · 신규: <b>${nc}개</b>` : '') +
    (dc ? ` · 삭제됨: <b>${dc}개</b>` : '');
}

// ── 그룹 관리 모달 ────────────────────────────────────────
document.getElementById('group-manage-btn').addEventListener('click', () => {
  renderGroupManageList();
  document.getElementById('group-modal-overlay').classList.remove('hidden');
});
document.getElementById('group-modal-close').addEventListener('click', closeGroupModal);
document.getElementById('group-modal-done').addEventListener('click',  closeGroupModal);
document.getElementById('group-modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeGroupModal();
});

function closeGroupModal() {
  document.getElementById('group-modal-overlay').classList.add('hidden');
  populateGroupSelects();
  renderGroupLegend();
  updateStats();
  renderMarkers(); // 그룹 색상 재적용
}

function renderGroupManageList() {
  const groups  = getGroups();
  const members = getGMembers();
  const el = document.getElementById('group-list-container');
  if (!groups.length) {
    el.innerHTML = '<div class="group-empty">그룹이 없습니다. 아래에서 새 그룹을 추가하세요.</div>';
    return;
  }
  el.innerHTML = '';
  groups.forEach(g => {
    const memberIds = Object.entries(members).filter(([,v]) => v === g.id).map(([k]) => k);
    const cnt = memberIds.length;
    const row = document.createElement('div');
    row.className = 'group-row-wrap';

    // 멤버 목록 HTML
    const memberFacs = memberIds
      .map(id => state.allFacilities.find(f => String(f.id) === id))
      .filter(Boolean);
    const memberHtml = memberFacs.length
      ? memberFacs.map(f => `
          <div class="group-member-item">
            <span class="group-member-name">${escHtml(f.name)}</span>
            <span class="group-member-region">${escHtml(f.region1)} ${escHtml(f.region2)}</span>
            <button class="group-member-del" onclick="window.removeFromGroup('${String(f.id)}','${g.id}')">✕</button>
          </div>`).join('')
      : '<div class="group-member-empty">기관 없음</div>';

    row.innerHTML = `
      <div class="group-row">
        <span class="group-color-dot" style="background:${g.color}; cursor:pointer;" title="색상 변경" onclick="window.editGroupColor('${g.id}')"></span>
        <input class="group-color-input" type="color" value="${g.color}" data-gid="${g.id}" style="display:none;">
        <span class="group-row-name" id="gname-${g.id}">${escHtml(g.name)}</span>
        <span class="group-row-count">${cnt}개 기관</span>
        <button class="group-row-rename" title="이름 수정" onclick="window.startRenameGroup('${g.id}')">✏️</button>
        <button class="group-row-expand" onclick="window.toggleGroupMembers('${g.id}')">▾ 멤버</button>
        <button class="group-row-del" onclick="window.deleteGroup('${g.id}')">✕</button>
      </div>
      <div class="group-members" id="gm-${g.id}" style="display:none;">
        ${memberHtml}
      </div>
    `;
    el.appendChild(row);

    // 색상 input 변경 이벤트
    const colorInput = row.querySelector('.group-color-input');
    colorInput.addEventListener('change', () => {
      const newColor = colorInput.value;
      const gs = getGroups();
      const gi = gs.find(x => x.id === g.id);
      if (gi) { gi.color = newColor; saveGroups(gs); }
      renderGroupManageList();
    });
  });
}

// ── 그룹 색상 편집 ───────────────────────────────────────
window.editGroupColor = function(gid) {
  const input = document.querySelector(`.group-color-input[data-gid="${gid}"]`);
  if (input) input.click();
};

// ── 그룹명 수정 ──────────────────────────────────────────
window.startRenameGroup = function(gid) {
  const nameEl = document.getElementById(`gname-${gid}`);
  if (!nameEl || nameEl.querySelector('input')) return;
  const current = nameEl.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'group-name-edit-input';
  input.onclick = e => e.stopPropagation();

  const saveBtn = document.createElement('button');
  saveBtn.textContent = '저장';
  saveBtn.className = 'group-name-save-btn';

  const doSave = () => {
    const newName = input.value.trim();
    if (!newName) { alert('그룹명을 입력해 주세요.'); return; }
    const gs = getGroups();
    const gi = gs.find(x => x.id === gid);
    if (gi) { gi.name = newName; saveGroups(gs); }
    renderGroupManageList();
    renderGroupLegend();
    populateGroupSelects();
  };

  saveBtn.onclick = doSave;
  input.onkeydown = e => {
    if (e.key === 'Enter') doSave();
    if (e.key === 'Escape') renderGroupManageList();
  };

  nameEl.innerHTML = '';
  nameEl.appendChild(input);
  nameEl.appendChild(saveBtn);
  input.focus();
  input.select();
};

// ── 그룹 멤버 접기/펼치기 ────────────────────────────────
window.toggleGroupMembers = function(gid) {
  const el = document.getElementById(`gm-${gid}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

// ── 그룹에서 기관 제거 ───────────────────────────────────
window.removeFromGroup = function(id, gid) {
  const members = getGMembers();
  if (members[id] === gid) { delete members[id]; saveGMembers(members); }
  renderGroupManageList();
  renderMarkers();
};

// ── 카드에서 빠른 그룹 지정 드롭다운 ────────────────────
function openGroupDropdown(btn, facilityId) {
  // 기존 드롭다운 제거
  document.querySelectorAll('.group-quick-dropdown').forEach(el => el.remove());

  const groups  = getGroups();
  const members = getGMembers();
  const curGid  = members[String(facilityId)];

  const dropdown = document.createElement('div');
  dropdown.className = 'group-quick-dropdown';

  const items = [{ id: '', name: '그룹 없음', color: '#aaa' }, ...groups];
  items.forEach(g => {
    const item = document.createElement('div');
    item.className = 'group-dropdown-item' + (curGid === g.id || (!curGid && g.id === '') ? ' selected' : '');
    item.innerHTML = `
      <span class="gd-dot" style="background:${g.color};"></span>
      <span>${escHtml(g.name)}</span>
    `;
    item.addEventListener('click', e => {
      e.stopPropagation();
      const m = getGMembers();
      if (g.id) m[String(facilityId)] = g.id;
      else      delete m[String(facilityId)];
      saveGMembers(m);
      dropdown.remove();
      reloadData();
    });
    dropdown.appendChild(item);
  });

  document.body.appendChild(dropdown);

  // 위치 결정
  const rect = btn.getBoundingClientRect();
  dropdown.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
  dropdown.style.left = (rect.left  + window.scrollX - dropdown.offsetWidth + btn.offsetWidth) + 'px';

  // 바깥 클릭 닫기
  setTimeout(() => {
    document.addEventListener('click', function close() {
      dropdown.remove();
      document.removeEventListener('click', close);
    });
  }, 0);
}

document.getElementById('add-group-btn').addEventListener('click', () => {
  const name = document.getElementById('new-group-name').value.trim();
  if (!name) { alert('그룹명을 입력해 주세요.'); return; }
  const color  = document.getElementById('new-group-color').value;
  const groups = getGroups();
  if (groups.some(g => g.name === name)) { alert('이미 같은 이름의 그룹이 있습니다.'); return; }
  const nid = 'grp_' + Date.now();
  groups.push({ id: nid, name, color });
  saveGroups(groups);
  document.getElementById('new-group-name').value = '';
  renderGroupManageList();
});

// ── 추가/수정 모달 ────────────────────────────────────────
document.getElementById('add-btn').addEventListener('click', () => openModal(null));
document.getElementById('modal-close').addEventListener('click',  closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

document.getElementById('modal-geocode').addEventListener('click', () => {
  const addr = document.getElementById('modal-address').value.trim();
  if (!addr) { showGeocodeStatus('주소를 입력해 주세요.', 'error'); return; }
  showGeocodeStatus('검색 중...', '');
  geocoder.addressSearch(addr, (result, status) => {
    if (status === kakao.maps.services.Status.OK) {
      const r = result[0];
      state.pendingLat = parseFloat(r.y);
      state.pendingLng = parseFloat(r.x);
      const r1 = normalizeRegion1(r.address.region_1depth_name || '');
      const r2 = r.address.region_2depth_name || '';
      document.getElementById('modal-region1').value = r1;
      document.getElementById('modal-region2').value = r2;
      showGeocodeStatus(`✅ 위치 확인: ${r.address_name}`, 'ok');
    } else {
      showGeocodeStatus('❌ 주소를 찾을 수 없습니다. 정확한 도로명/지번 주소를 입력하세요.', 'error');
    }
  });
});

function showGeocodeStatus(msg, type) {
  const el = document.getElementById('geocode-status');
  el.textContent = msg;
  el.className = `geocode-status ${type}`;
}

function openModal(id) {
  state.editingId  = id;
  state.pendingLat = null;
  state.pendingLng = null;
  document.getElementById('geocode-status').textContent = '';
  document.getElementById('modal-title').textContent = id === null ? '검진기관 추가' : '검진기관 수정';
  document.getElementById('modal-save').textContent  = id === null ? '추가' : '저장';
  populateGroupSelects();

  if (id !== null) {
    const f = state.allFacilities.find(x => String(x.id) === String(id));
    if (f) {
      document.getElementById('modal-name').value    = f.name;
      document.getElementById('modal-address').value = f.address;
      document.getElementById('modal-region1').value = f.region1;
      document.getElementById('modal-region2').value = f.region2;
      state.pendingLat = f.lat;
      state.pendingLng = f.lng;
      const members = getGMembers();
      document.getElementById('modal-group').value = members[String(id)] || '';
    }
  } else {
    ['modal-name','modal-address','modal-region1','modal-region2'].forEach(i => {
      document.getElementById(i).value = '';
    });
    document.getElementById('modal-group').value = '';
  }
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-name').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  state.editingId = null; state.pendingLat = null; state.pendingLng = null;
}

document.getElementById('modal-save').addEventListener('click', () => {
  const name    = document.getElementById('modal-name').value.trim();
  const address = document.getElementById('modal-address').value.trim();
  const region1 = document.getElementById('modal-region1').value.trim();
  const region2 = document.getElementById('modal-region2').value.trim();
  const groupId = document.getElementById('modal-group').value;

  if (!name)    { alert('기관명을 입력해 주세요.'); return; }
  if (!address) { alert('주소를 입력해 주세요.'); return; }

  const autoReg = region1 ? { region1, region2 } : extractRegions(address);
  let focusId;

  if (state.editingId === null) {
    const added = getAdded();
    const nid   = 'new_' + Date.now();
    added.push({
      id: nid, name, address,
      region1: autoReg.region1, region2: autoReg.region2,
      lat: state.pendingLat, lng: state.pendingLng,
      geocode_quality: state.pendingLat ? 'manual' : 'failed', isNew: true,
    });
    saveAdded(added);
    focusId = nid;
  } else {
    const edited  = getEdited();
    const origFac = state.allFacilities.find(f => String(f.id) === String(state.editingId));
    edited[state.editingId] = {
      name, address,
      region1: autoReg.region1, region2: autoReg.region2,
      lat: state.pendingLat ?? origFac?.lat ?? null,
      lng: state.pendingLng ?? origFac?.lng ?? null,
    };
    saveEdited(edited);
    focusId = state.editingId;
  }

  // 그룹 멤버십 저장
  const members = getGMembers();
  if (groupId) members[String(focusId)] = groupId;
  else         delete members[String(focusId)];
  saveGMembers(members);

  closeModal();

  state.activeRegion1 = null; state.activeRegion2 = null;
  state.searchQuery   = name;
  document.getElementById('region1-select').value = '';
  document.getElementById('region2-select').value = '';
  document.getElementById('search-input').value   = name;
  document.getElementById('search-clear').classList.remove('hidden');
  populateRegion2Select(null);

  reloadData(focusId);
});

// ── 데이터 새로고침 ───────────────────────────────────────
async function reloadData(focusId = null) {
  const res  = await fetch('data/facilities.json');
  const base = await res.json();
  mergeAndSet(base);
  populateRegion1Select();
  populateGroupSelects();
  renderGroupLegend();
  if (state.activeRegion1) populateRegion2Select(state.activeRegion1);
  updateStats();
  applyFilter(false);

  if (focusId !== null) {
    setTimeout(() => {
      ensureCardRendered(focusId);
      highlightCard(focusId);
      const f = state.allFacilities.find(x => String(x.id) === String(focusId));
      if (f?.lat && f?.lng) {
        map.setCenter(new kakao.maps.LatLng(f.lat, f.lng));
        map.setLevel(5);
        const item = state.markerMap.get(f.id);
        if (item) { item.iw.open(map, item.marker); item.marker.setImage(IMG_ACTIVE()); state.openOverlay = item.iw; }
      }
    }, 150);
  }
}

// ── 유틸 ─────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 앱 시작 ───────────────────────────────────────────────
window.addEventListener('load', function () {
  if (typeof kakao === 'undefined') {
    document.getElementById('facility-list').innerHTML =
      '<div class="list-empty">카카오 지도 SDK를 불러올 수 없습니다.</div>';
    return;
  }
  kakao.maps.load(function () {
    initMap();
    loadData().catch(err => {
      document.getElementById('facility-list').innerHTML =
        `<div class="list-empty">데이터 로드 실패.<br><small>${err.message}</small></div>`;
    });
  });
});
