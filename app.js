'use strict';

const RENDER_CHUNK = 100;
const LS_ADDED   = 'medicalmap_added';
const LS_EDITED  = 'medicalmap_edited';

const state = {
  allFacilities: [],
  filteredFacilities: [],
  activeRegion1: null,
  activeRegion2: null,
  searchQuery: '',
  regionIndex: {},
  renderedCount: 0,
  activeCardId: null,
  markerMap: new Map(),   // id → { marker, infoWindow }
  openOverlay: null,
  editingId: null,        // 수정 중인 기관 id (null=신규)
  pendingLat: null,       // 모달에서 검색된 좌표
  pendingLng: null,
};

let map, clusterer, geocoder;

// ── LocalStorage 유틸 ────────────────────────────────────
function lsGet(key)      { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function getAdded()  { return lsGet(LS_ADDED)  || []; }
function getEdited() { return lsGet(LS_EDITED) || {}; }

function saveAdded(arr)  { lsSet(LS_ADDED, arr); }
function saveEdited(obj) { lsSet(LS_EDITED, obj); }

// ── 지역 추출 ─────────────────────────────────────────────
function extractRegions(address) {
  const tokens = String(address).trim().split(/\s+/);
  return {
    region1: tokens[0] || '기타',
    region2: tokens[1] || '기타',
  };
}

// ── 도트 마커 이미지 ──────────────────────────────────────
function makeDotImage(fill = '#2196F3', stroke = '#1565C0') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="6.5" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
  </svg>`;
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const size   = new kakao.maps.Size(16, 16);
  const offset = new kakao.maps.Point(8, 8);
  return new kakao.maps.MarkerImage(src, size, { offset });
}

const IMG_NORMAL = () => makeDotImage('#2196F3', '#1565C0');
const IMG_ACTIVE = () => makeDotImage('#FF5722', '#BF360C');
const IMG_NEW    = () => makeDotImage('#43A047', '#1B5E20');  // 신규 추가 기관

// ── 지도 초기화 ──────────────────────────────────────────
function initMap() {
  const container = document.getElementById('map');
  map = new kakao.maps.Map(container, {
    center: new kakao.maps.LatLng(36.5, 127.8),
    level: 8,
    draggable: true,
    scrollwheel: true,
  });

  map.addControl(new kakao.maps.ZoomControl(),    kakao.maps.ControlPosition.RIGHT);
  map.addControl(new kakao.maps.MapTypeControl(), kakao.maps.ControlPosition.TOPRIGHT);

  clusterer = new kakao.maps.MarkerClusterer({
    map,
    averageCenter: true,
    minLevel: 5,
    disableClickZoom: false,
    styles: [{
      width: '44px', height: '44px',
      background: 'rgba(21,101,192,0.85)',
      borderRadius: '50%',
      color: '#fff',
      textAlign: 'center',
      lineHeight: '44px',
      fontSize: '13px',
      fontWeight: '700',
    }],
  });

  geocoder = new kakao.maps.services.Geocoder();
  kakao.maps.event.addListener(map, 'click', onMapClick);
}

// ── 데이터 로드 ──────────────────────────────────────────
async function loadData() {
  const res  = await fetch('data/facilities.json');
  const base = await res.json();

  const edited  = getEdited();
  const added   = getAdded();

  // 수정 사항 적용
  const merged = base.map(f => {
    const e = edited[f.id];
    return e ? { ...f, ...e } : f;
  });

  // 신규 기관 추가 (초록 도트 구분)
  const addedWithFlag = added.map(f => ({ ...f, isNew: true }));

  state.allFacilities    = [...merged, ...addedWithFlag];
  state.filteredFacilities = state.allFacilities;
  state.regionIndex      = buildRegionIndex(state.allFacilities);

  populateRegion1Select();
  updateStats();
  render();
}

function buildRegionIndex(facilities) {
  const idx = {};
  for (const f of facilities) {
    if (!idx[f.region1]) idx[f.region1] = new Set();
    idx[f.region1].add(f.region2);
  }
  for (const r in idx) idx[r] = [...idx[r]].sort();
  return idx;
}

// ── 필터 드롭다운 ─────────────────────────────────────────
function populateRegion1Select() {
  const sel = document.getElementById('region1-select');
  sel.innerHTML = '<option value="">전체 지역</option>';
  for (const r of Object.keys(state.regionIndex).sort()) {
    const o = document.createElement('option');
    o.value = r; o.textContent = r;
    sel.appendChild(o);
  }
}

function populateRegion2Select(r1) {
  const sel = document.getElementById('region2-select');
  sel.innerHTML = '<option value="">전체 구역</option>';
  if (!r1) { sel.disabled = true; return; }
  sel.disabled = false;
  for (const r of (state.regionIndex[r1] || [])) {
    const o = document.createElement('option');
    o.value = r; o.textContent = r;
    sel.appendChild(o);
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

document.getElementById('reset-btn').addEventListener('click', function () {
  state.activeRegion1 = null;
  state.activeRegion2 = null;
  state.searchQuery   = '';
  document.getElementById('region1-select').value = '';
  document.getElementById('region2-select').value = '';
  document.getElementById('search-input').value  = '';
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
  state.renderedCount = 0;
  state.activeCardId  = null;
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

  if (state.activeRegion1)  result = result.filter(f => f.region1 === state.activeRegion1);
  if (state.activeRegion2)  result = result.filter(f => f.region2 === state.activeRegion2);
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    result = result.filter(f => f.name.toLowerCase().includes(q));
  }

  state.filteredFacilities = result;
  state.renderedCount      = 0;
  state.activeCardId       = null;
  render();

  if (moveMap && state.activeRegion1) {
    const pts = result.filter(f => f.lat && f.lng);
    if (pts.length > 0) {
      const bounds = new kakao.maps.LatLngBounds();
      pts.forEach(f => bounds.extend(new kakao.maps.LatLng(f.lat, f.lng)));
      map.setBounds(bounds, 50);
    }
  }
}

// ── 지도 클릭 (역지오코딩) ───────────────────────────────
function onMapClick(mouseEvent) {
  const latlng   = mouseEvent.latLng;
  const statusEl = document.getElementById('click-status');
  statusEl.textContent = '지역 정보를 가져오는 중...';

  geocoder.coord2RegionCode(latlng.getLng(), latlng.getLat(), (result, status) => {
    if (status !== kakao.maps.services.Status.OK) {
      statusEl.textContent = '지역 정보를 가져올 수 없습니다.';
      return;
    }
    const region  = result.find(r => r.region_type === 'H') || result[0];
    const r1name  = region.region_1depth_name;
    const r2name  = region.region_2depth_name;
    const matched1 = findMatchingRegion1(r1name);
    if (!matched1) { statusEl.textContent = '해당 지역 데이터가 없습니다.'; return; }

    state.activeRegion1 = matched1;
    state.activeRegion2 = r2name ? findMatchingRegion2(matched1, r2name) : null;

    document.getElementById('region1-select').value = state.activeRegion1;
    populateRegion2Select(state.activeRegion1);
    if (state.activeRegion2) document.getElementById('region2-select').value = state.activeRegion2;

    statusEl.textContent = `📍 ${state.activeRegion1}${state.activeRegion2 ? ' ' + state.activeRegion2 : ''}`;
    applyFilter(false);
  });
}

function findMatchingRegion1(name) {
  const keys = Object.keys(state.regionIndex);
  if (keys.includes(name)) return name;
  return keys.find(k => k.startsWith(name.slice(0, 2)) || name.startsWith(k.slice(0, 2))) || null;
}
function findMatchingRegion2(r1, name) {
  const list = state.regionIndex[r1] || [];
  if (list.includes(name)) return name;
  return list.find(d => d.startsWith(name.slice(0, 2)) || name.startsWith(d.slice(0, 2))) || null;
}

// ── 렌더링 ───────────────────────────────────────────────
function render() {
  renderMarkers();
  renderListOnly();
  renderListCount();
}

function renderMarkers() {
  closeOverlay();
  clusterer.clear();
  state.markerMap.clear();

  const toShow = state.filteredFacilities.filter(f => f.lat && f.lng);
  const markers = [];

  toShow.forEach(f => {
    const pos    = new kakao.maps.LatLng(f.lat, f.lng);
    const marker = new kakao.maps.Marker({
      position: pos,
      image: f.isNew ? IMG_NEW() : IMG_NORMAL(),
    });
    const iw = new kakao.maps.InfoWindow({ content: makeIWHtml(f), removable: true });

    kakao.maps.event.addListener(marker, 'click', () => {
      closeOverlay();
      iw.open(map, marker);
      state.openOverlay = iw;
      marker.setImage(IMG_ACTIVE());
      highlightCard(f.id);
    });

    markers.push(marker);
    state.markerMap.set(f.id, { marker, iw });
  });

  clusterer.addMarkers(markers);
}

function makeIWHtml(f) {
  const badge = f.isNew ? '<span style="background:#43A047;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:4px;">신규</span>' : '';
  return `<div style="padding:10px 14px;min-width:210px;font-family:'맑은 고딕',sans-serif;">
    <div style="font-weight:700;font-size:14px;color:#1565C0;margin-bottom:4px;">${escHtml(f.name)}${badge}</div>
    <div style="font-size:11px;color:#888;margin-bottom:4px;">${escHtml(f.region1)} · ${escHtml(f.region2)}</div>
    <div style="font-size:12px;color:#444;line-height:1.6;">${escHtml(f.address)}</div>
  </div>`;
}

function closeOverlay() {
  if (state.openOverlay) { state.openOverlay.close(); state.openOverlay = null; }
  if (state.activeCardId !== null) {
    const item = state.markerMap.get(state.activeCardId);
    if (item) {
      const f = state.allFacilities.find(x => x.id === state.activeCardId);
      item.marker.setImage(f?.isNew ? IMG_NEW() : IMG_NORMAL());
    }
  }
}

// ── 목록 렌더링 ───────────────────────────────────────────
function renderListOnly() {
  const list = document.getElementById('facility-list');
  list.innerHTML = '';
  state.renderedCount = 0;

  if (state.filteredFacilities.length === 0) {
    list.innerHTML = '<div class="list-empty">검색 결과가 없습니다.<br>다른 조건으로 시도해 주세요.</div>';
    renderListCount();
    return;
  }

  appendCards(Math.min(RENDER_CHUNK, state.filteredFacilities.length));
  if (state.filteredFacilities.length > RENDER_CHUNK) appendMoreBtn();
  renderListCount();
}

function appendCards(upTo) {
  const list = document.getElementById('facility-list');
  list.querySelector('.list-more-btn')?.remove();
  const end = Math.min(upTo, state.filteredFacilities.length);
  for (let i = state.renderedCount; i < end; i++) {
    list.appendChild(makeCard(state.filteredFacilities[i]));
  }
  state.renderedCount = end;
}

function makeCard(f) {
  const card = document.createElement('div');
  card.className = 'facility-card' + (f.id === state.activeCardId ? ' active' : '') + (f.isNew ? ' is-new' : '');
  card.dataset.id = f.id;

  const noLoc = !f.lat || !f.lng;
  const q     = state.searchQuery.toLowerCase();
  const name  = q ? highlightText(f.name, q) : escHtml(f.name);

  card.innerHTML = `
    <div class="card-main">
      <div class="facility-name">${name}${f.isNew ? '<span class="new-badge">신규</span>' : ''}</div>
      <div class="facility-region">${escHtml(f.region1)} · ${escHtml(f.region2)}</div>
      <div class="facility-address">${escHtml(f.address)}</div>
      ${noLoc ? '<span class="no-location-badge">위치 미등록</span>' : ''}
    </div>
    <button class="edit-btn" data-id="${f.id}" title="수정">✏️</button>
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
  card.querySelector('.edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    openModal(f.id);
  });

  return card;
}

function highlightText(text, query) {
  const esc  = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const safe = escHtml(text);
  return safe.replace(new RegExp(esc, 'gi'), m => `<mark>${m}</mark>`);
}

function appendMoreBtn() {
  const list      = document.getElementById('facility-list');
  const remaining = state.filteredFacilities.length - state.renderedCount;
  const btn       = document.createElement('button');
  btn.className   = 'list-more-btn';
  btn.textContent = `더 보기 (${remaining}개 남음)`;
  btn.addEventListener('click', () => {
    appendCards(state.renderedCount + RENDER_CHUNK);
    if (state.renderedCount < state.filteredFacilities.length) appendMoreBtn();
  });
  list.appendChild(btn);
}

function highlightCard(id) {
  document.querySelectorAll('.facility-card.active').forEach(el => el.classList.remove('active'));
  state.activeCardId = id;
  const card = document.querySelector(`.facility-card[data-id="${id}"]`);
  if (card) { card.classList.add('active'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
}

function renderListCount() {
  let label = '전체 기관';
  if (state.searchQuery)    label = `"${state.searchQuery}" 검색 결과`;
  else if (state.activeRegion1) label = state.activeRegion1 + (state.activeRegion2 ? ' ' + state.activeRegion2 : '');
  document.getElementById('list-count').textContent = label;
  document.getElementById('list-total').textContent = `${state.filteredFacilities.length.toLocaleString()}개`;
}

function updateStats() {
  const total      = state.allFacilities.length;
  const withCoords = state.allFacilities.filter(f => f.lat && f.lng).length;
  const newCount   = getAdded().length;
  document.getElementById('stats').innerHTML =
    `전체: <b>${total}개</b> · 지도표시: <b>${withCoords}개</b>${newCount ? ` · 신규추가: <b>${newCount}개</b>` : ''}`;
}

// ── 모달 ──────────────────────────────────────────────────
document.getElementById('add-btn').addEventListener('click',     () => openModal(null));
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
      // 행정 지역명 자동 입력
      const addrObj = r.address;
      document.getElementById('modal-region1').value = addrObj.region_1depth_name || '';
      document.getElementById('modal-region2').value = addrObj.region_2depth_name || '';
      showGeocodeStatus(`✅ 위치 확인: ${r.address_name}`, 'ok');
    } else {
      state.pendingLat = null;
      state.pendingLng = null;
      showGeocodeStatus('❌ 주소를 찾을 수 없습니다. 정확한 도로명 주소를 입력하세요.', 'error');
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
    const f = state.allFacilities.find(x => x.id === id);
    if (f) {
      document.getElementById('modal-name').value    = f.name;
      document.getElementById('modal-address').value = f.address;
      document.getElementById('modal-region1').value = f.region1;
      document.getElementById('modal-region2').value = f.region2;
      state.pendingLat = f.lat;
      state.pendingLng = f.lng;
    }
  } else {
    document.getElementById('modal-name').value    = '';
    document.getElementById('modal-address').value = '';
    document.getElementById('modal-region1').value = '';
    document.getElementById('modal-region2').value = '';
  }

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-name').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  state.editingId  = null;
  state.pendingLat = null;
  state.pendingLng = null;
}

document.getElementById('modal-save').addEventListener('click', () => {
  const name    = document.getElementById('modal-name').value.trim();
  const address = document.getElementById('modal-address').value.trim();
  const region1 = document.getElementById('modal-region1').value.trim();
  const region2 = document.getElementById('modal-region2').value.trim();

  if (!name)    { alert('기관명을 입력해 주세요.'); return; }
  if (!address) { alert('주소를 입력해 주세요.'); return; }

  const autoReg = region1 ? { region1, region2 } : extractRegions(address);

  if (state.editingId === null) {
    // ── 신규 추가
    const added = getAdded();
    const newId = 'new_' + Date.now();
    const newFac = {
      id: newId,
      name,
      address,
      region1: autoReg.region1,
      region2: autoReg.region2,
      lat: state.pendingLat,
      lng: state.pendingLng,
      geocode_quality: state.pendingLat ? 'manual' : 'failed',
      isNew: true,
    };
    added.push(newFac);
    saveAdded(added);
  } else {
    // ── 기존 수정
    const edited = getEdited();
    edited[state.editingId] = {
      name,
      address,
      region1: autoReg.region1,
      region2: autoReg.region2,
      lat: state.pendingLat,
      lng: state.pendingLng,
    };
    saveEdited(edited);
  }

  closeModal();
  reloadData();
});

// 데이터 새로고침 (geocoding 없이 localStorage 재반영)
async function reloadData() {
  const res  = await fetch('data/facilities.json');
  const base = await res.json();
  const edited  = getEdited();
  const added   = getAdded();

  const merged   = base.map(f => { const e = edited[f.id]; return e ? { ...f, ...e } : f; });
  const newItems = added.map(f => ({ ...f, isNew: true }));

  state.allFacilities  = [...merged, ...newItems];
  state.regionIndex    = buildRegionIndex(state.allFacilities);

  populateRegion1Select();
  if (state.activeRegion1) populateRegion2Select(state.activeRegion1);
  updateStats();
  applyFilter(false);
}

// ── 유틸 ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 앱 시작 ───────────────────────────────────────────────
window.addEventListener('load', function () {
  if (typeof kakao === 'undefined') {
    document.getElementById('facility-list').innerHTML =
      '<div class="list-empty">카카오 지도 SDK를 불러올 수 없습니다.<br>네트워크 연결을 확인해 주세요.</div>';
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
