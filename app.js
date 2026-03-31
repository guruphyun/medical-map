'use strict';

const RENDER_CHUNK = 100;
const LS_ADDED   = 'medicalmap_added';
const LS_EDITED  = 'medicalmap_edited';
const LS_DELETED = 'medicalmap_deleted';

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
function lsGet(k)      { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v)   { localStorage.setItem(k, JSON.stringify(v)); }
function getAdded()    { return lsGet(LS_ADDED)   || []; }
function getEdited()   { return lsGet(LS_EDITED)  || {}; }
function getDeleted()  { return lsGet(LS_DELETED) || []; }
function saveAdded(a)  { lsSet(LS_ADDED,   a); }
function saveEdited(o) { lsSet(LS_EDITED,  o); }
function saveDeleted(a){ lsSet(LS_DELETED, a); }

function extractRegions(addr) {
  const t = String(addr).trim().split(/\s+/);
  return { region1: t[0] || '기타', region2: t[1] || '기타' };
}

// ── 상태 ─────────────────────────────────────────────────
const state = {
  allFacilities: [], filteredFacilities: [],
  activeRegion1: null, activeRegion2: null, searchQuery: '',
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
const IMG_NORMAL = () => makeDotImg('#2196F3','#1565C0');
const IMG_ACTIVE = () => makeDotImg('#FF5722','#BF360C');
const IMG_NEW    = () => makeDotImg('#43A047','#1B5E20');

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
  kakao.maps.event.addListener(map, 'click', onMapClick);
}

// ── 데이터 로드 ──────────────────────────────────────────
async function loadData() {
  const res  = await fetch('data/facilities.json');
  const base = await res.json();
  mergeAndSet(base);
  populateRegion1Select();
  updateStats();
  render();
}

function mergeAndSet(base) {
  const edited  = getEdited();
  const added   = getAdded();
  const deleted = getDeleted();

  const merged = base
    .filter(f => !deleted.includes(String(f.id)))
    .map(f => {
      const e = edited[f.id] || edited[String(f.id)];
      return e ? { ...f, ...e } : f;
    });

  const newItems = added
    .filter(f => !deleted.includes(String(f.id)))
    .map(f => ({ ...f, isNew: true }));

  state.allFacilities = [...merged, ...newItems];
  state.regionIndex   = buildRegionIndex(state.allFacilities);
}

function buildRegionIndex(facs) {
  const idx = {};
  for (const f of facs) {
    if (!idx[f.region1]) idx[f.region1] = new Set();
    idx[f.region1].add(f.region2);
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
document.getElementById('reset-btn').addEventListener('click', () => {
  state.activeRegion1 = null; state.activeRegion2 = null; state.searchQuery = '';
  document.getElementById('region1-select').value = '';
  document.getElementById('region2-select').value = '';
  document.getElementById('search-input').value   = '';
  document.getElementById('search-clear').classList.add('hidden');
  populateRegion2Select(null);
  document.getElementById('click-status').textContent = '';
  applyFilter();
  map.setCenter(new kakao.maps.LatLng(36.5, 127.8));
  map.setLevel(8);
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

// ── 필터 적용 ─────────────────────────────────────────────
function applyFilter(moveMap = true) {
  closeOverlay();
  let result = state.allFacilities;
  if (state.activeRegion1) result = result.filter(f => f.region1 === state.activeRegion1);
  if (state.activeRegion2) result = result.filter(f => f.region2 === state.activeRegion2);
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    result = result.filter(f => f.name.toLowerCase().includes(q));
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

// ── 지도 클릭 ─────────────────────────────────────────────
function onMapClick(e) {
  const latlng = e.latLng;
  const el = document.getElementById('click-status');
  el.textContent = '지역 정보를 가져오는 중...';
  geocoder.coord2RegionCode(latlng.getLng(), latlng.getLat(), (result, status) => {
    if (status !== kakao.maps.services.Status.OK) { el.textContent = '지역 정보 없음'; return; }
    const reg = result.find(r => r.region_type === 'H') || result[0];
    const m1  = findMatchingRegion1(reg.region_1depth_name);
    if (!m1) { el.textContent = '해당 지역 데이터 없음'; return; }
    state.activeRegion1 = m1;
    state.activeRegion2 = findMatchingRegion2(m1, reg.region_2depth_name);
    document.getElementById('region1-select').value = m1;
    populateRegion2Select(m1);
    if (state.activeRegion2) document.getElementById('region2-select').value = state.activeRegion2;
    el.textContent = `📍 ${m1}${state.activeRegion2 ? ' ' + state.activeRegion2 : ''}`;
    applyFilter(false);
  });
}
function findMatchingRegion1(n) {
  const k = Object.keys(state.regionIndex);
  return k.find(x => x === n) || k.find(x => x.startsWith(n.slice(0,2)) || n.startsWith(x.slice(0,2))) || null;
}
function findMatchingRegion2(r1, n) {
  const l = state.regionIndex[r1] || [];
  return l.find(x => x === n) || l.find(x => x.startsWith(n.slice(0,2)) || n.startsWith(x.slice(0,2))) || null;
}

// ── 렌더링 ───────────────────────────────────────────────
function render() { renderMarkers(); renderListOnly(); renderListCount(); }

function renderMarkers() {
  closeOverlay();
  clusterer.clear();
  state.markerMap.clear();

  const toShow = state.filteredFacilities.filter(f => f.lat && f.lng);
  const markers = [];

  toShow.forEach(f => {
    const marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(f.lat, f.lng),
      image: f.isNew ? IMG_NEW() : IMG_NORMAL(),
    });
    const iw = new kakao.maps.InfoWindow({ content: makeIWHtml(f), removable: true });

    kakao.maps.event.addListener(marker, 'click', () => {
      closeOverlay();
      iw.open(map, marker);
      marker.setImage(IMG_ACTIVE());
      state.openOverlay = iw;
      // 목록에서 카드 스크롤 + 하이라이트
      ensureCardRendered(f.id);
      highlightCard(f.id);
    });

    markers.push(marker);
    state.markerMap.set(f.id, { marker, iw });
  });

  clusterer.addMarkers(markers);
}

// InfoWindow HTML (수정/삭제 버튼 포함)
function makeIWHtml(f) {
  const sid  = String(f.id).replace(/'/g, "\\'");
  const badge = f.isNew ? '<span style="background:#43A047;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;">신규</span>' : '';
  return `<div style="padding:12px 14px;min-width:230px;max-width:280px;font-family:'맑은 고딕',sans-serif;">
    <div style="font-weight:700;font-size:14px;color:#1565C0;margin-bottom:4px;line-height:1.4;">${escHtml(f.name)}${badge}</div>
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

  // 신규 추가 기관이면 added 목록에서도 제거
  const added = getAdded().filter(x => String(x.id) !== String(id));
  saveAdded(added);

  closeOverlay();
  reloadData();
};

function closeOverlay() {
  if (state.openOverlay) { state.openOverlay.close(); state.openOverlay = null; }
  if (state.activeCardId !== null) {
    const item = state.markerMap.get(state.activeCardId);
    if (item) {
      const f = state.allFacilities.find(x => String(x.id) === String(state.activeCardId));
      item.marker.setImage(f?.isNew ? IMG_NEW() : IMG_NORMAL());
    }
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

// 카드가 아직 렌더되지 않은 경우 강제 렌더
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

  card.innerHTML = `
    <div class="card-main">
      <div class="facility-name">${name}${f.isNew ? '<span class="new-badge">신규</span>' : ''}</div>
      <div class="facility-region">${escHtml(f.region1)} · ${escHtml(f.region2)}</div>
      <div class="facility-address">${escHtml(f.address)}</div>
      ${noLoc ? '<span class="no-location-badge">위치 미등록</span>' : ''}
    </div>
    <div class="card-actions">
      <button class="btn-edit"  title="수정">✏️</button>
      <button class="btn-delete" title="삭제">🗑️</button>
    </div>
  `;

  // 카드 클릭 → 지도 이동
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

  // 수정 버튼
  card.querySelector('.btn-edit').addEventListener('click', e => {
    e.stopPropagation();
    openModal(f.id);
  });

  // 삭제 버튼
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
  if (state.searchQuery)     label = `"${state.searchQuery}" 검색 결과`;
  else if (state.activeRegion1) label = state.activeRegion1 + (state.activeRegion2 ? ' ' + state.activeRegion2 : '');
  document.getElementById('list-count').textContent = label;
  document.getElementById('list-total').textContent = `${state.filteredFacilities.length.toLocaleString()}개`;
}

function updateStats() {
  const total = state.allFacilities.length;
  const wc    = state.allFacilities.filter(f => f.lat && f.lng).length;
  const nc    = getAdded().length;
  const dc    = getDeleted().length;
  document.getElementById('stats').innerHTML =
    `전체: <b>${total}개</b> · 지도표시: <b>${wc}개</b>${nc ? ` · 신규: <b>${nc}개</b>` : ''}${dc ? ` · 삭제됨: <b>${dc}개</b>` : ''}`;
}

// ── 모달 ──────────────────────────────────────────────────
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

  if (id !== null) {
    const f = state.allFacilities.find(x => String(x.id) === String(id));
    if (f) {
      document.getElementById('modal-name').value    = f.name;
      document.getElementById('modal-address').value = f.address;
      document.getElementById('modal-region1').value = f.region1;
      document.getElementById('modal-region2').value = f.region2;
      state.pendingLat = f.lat;
      state.pendingLng = f.lng;
    }
  } else {
    ['modal-name','modal-address','modal-region1','modal-region2'].forEach(i => { document.getElementById(i).value = ''; });
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

  if (!name)    { alert('기관명을 입력해 주세요.'); return; }
  if (!address) { alert('주소를 입력해 주세요.'); return; }

  const autoReg = region1 ? { region1, region2 } : extractRegions(address);
  const savedId = state.editingId;

  if (state.editingId === null) {
    const added = getAdded();
    const nid   = 'new_' + Date.now();
    added.push({ id: nid, name, address, region1: autoReg.region1, region2: autoReg.region2,
                 lat: state.pendingLat, lng: state.pendingLng,
                 geocode_quality: state.pendingLat ? 'manual' : 'failed', isNew: true });
    saveAdded(added);
  } else {
    const edited  = getEdited();
    const origFac = state.allFacilities.find(f => String(f.id) === String(state.editingId));
    edited[state.editingId] = {
      name, address, region1: autoReg.region1, region2: autoReg.region2,
      lat: state.pendingLat ?? origFac?.lat ?? null,
      lng: state.pendingLng ?? origFac?.lng ?? null,
    };
    saveEdited(edited);
  }

  closeModal();

  // 저장 후 기관명으로 검색하여 바로 보이게
  state.activeRegion1 = null; state.activeRegion2 = null;
  state.searchQuery   = name;
  document.getElementById('region1-select').value = '';
  document.getElementById('region2-select').value = '';
  document.getElementById('search-input').value   = name;
  document.getElementById('search-clear').classList.remove('hidden');
  populateRegion2Select(null);

  reloadData(savedId || ('new_' + (getAdded().slice(-1)[0]?.id || '')));
});

// ── 데이터 새로고침 ───────────────────────────────────────
async function reloadData(focusId = null) {
  const res  = await fetch('data/facilities.json');
  const base = await res.json();
  mergeAndSet(base);
  populateRegion1Select();
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
