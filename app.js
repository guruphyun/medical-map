'use strict';

const RENDER_CHUNK = 100;

const state = {
  allFacilities: [],
  filteredFacilities: [],
  activeRegion1: null,
  activeRegion2: null,
  regionIndex: {},
  renderedCount: 0,
  activeCardId: null,
  kakaoMarkers: [],       // kakao.maps.Marker[]
  markerMap: new Map(),   // id → { marker, overlay }
  openOverlay: null,      // 현재 열린 infoWindow
};

let map, clusterer, geocoder;

// ── 도트 마커 이미지 (SVG → 카카오 MarkerImage) ──────────
function makeDotImage(color = '#2196F3', border = '#1565C0') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="6.5" fill="${color}" stroke="${border}" stroke-width="2"/>
  </svg>`;
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const size = new kakao.maps.Size(16, 16);
  const anchor = new kakao.maps.Point(8, 8);
  return new kakao.maps.MarkerImage(src, size, { offset: anchor });
}

const DOT_NORMAL  = () => makeDotImage('#2196F3', '#1565C0');
const DOT_ACTIVE  = () => makeDotImage('#FF5722', '#BF360C');

// ── 지도 초기화 ──────────────────────────────────────────
function initMap() {
  const container = document.getElementById('map');
  map = new kakao.maps.Map(container, {
    center: new kakao.maps.LatLng(36.5, 127.8),
    level: 8,
  });

  // 지도 컨트롤 추가
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  map.addControl(new kakao.maps.MapTypeControl(), kakao.maps.ControlPosition.TOPRIGHT);

  // 마커 클러스터러
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

  // 역지오코더
  geocoder = new kakao.maps.services.Geocoder();

  // 지도 클릭 이벤트
  kakao.maps.event.addListener(map, 'click', onMapClick);
}

// ── 데이터 로드 ──────────────────────────────────────────
async function loadData() {
  const res = await fetch('data/facilities.json');
  const data = await res.json();
  state.allFacilities = data;
  state.filteredFacilities = data;
  state.regionIndex = buildRegionIndex(data);
  populateRegion1Select();
  updateStats(data);
  render();
}

function buildRegionIndex(facilities) {
  const index = {};
  for (const f of facilities) {
    if (!index[f.region1]) index[f.region1] = new Set();
    index[f.region1].add(f.region2);
  }
  for (const r1 in index) index[r1] = [...index[r1]].sort();
  return index;
}

// ── 필터 드롭다운 ─────────────────────────────────────────
function populateRegion1Select() {
  const sel = document.getElementById('region1-select');
  sel.innerHTML = '<option value="">전체 지역</option>';
  for (const r of Object.keys(state.regionIndex).sort()) {
    const opt = document.createElement('option');
    opt.value = r; opt.textContent = r;
    sel.appendChild(opt);
  }
}

function populateRegion2Select(region1) {
  const sel = document.getElementById('region2-select');
  sel.innerHTML = '<option value="">전체 구역</option>';
  if (!region1) { sel.disabled = true; return; }
  sel.disabled = false;
  for (const r of (state.regionIndex[region1] || [])) {
    const opt = document.createElement('option');
    opt.value = r; opt.textContent = r;
    sel.appendChild(opt);
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
  document.getElementById('region1-select').value = '';
  document.getElementById('region2-select').value = '';
  populateRegion2Select(null);
  document.getElementById('click-status').textContent = '';
  applyFilter();
  map.setCenter(new kakao.maps.LatLng(36.5, 127.8));
  map.setLevel(8);
});

function applyFilter() {
  closeOverlay();
  let result = state.allFacilities;
  if (state.activeRegion1) result = result.filter(f => f.region1 === state.activeRegion1);
  if (state.activeRegion2) result = result.filter(f => f.region2 === state.activeRegion2);
  state.filteredFacilities = result;
  state.renderedCount = 0;
  state.activeCardId = null;
  render();

  // 필터 적용 시 해당 지역으로 지도 이동
  const withCoords = result.filter(f => f.lat && f.lng);
  if (withCoords.length > 0 && state.activeRegion1) {
    const bounds = new kakao.maps.LatLngBounds();
    withCoords.forEach(f => bounds.extend(new kakao.maps.LatLng(f.lat, f.lng)));
    map.setBounds(bounds, 50);
  }
}

// ── 지도 클릭 → 역지오코딩 ───────────────────────────────
function onMapClick(mouseEvent) {
  const latlng = mouseEvent.latLng;
  const statusEl = document.getElementById('click-status');
  statusEl.textContent = '지역 정보를 가져오는 중...';

  geocoder.coord2RegionCode(latlng.getLng(), latlng.getLat(), function (result, status) {
    if (status !== kakao.maps.services.Status.OK) {
      statusEl.textContent = '지역 정보를 가져올 수 없습니다.';
      return;
    }

    // H(행정동) 타입에서 지역 추출
    const region = result.find(r => r.region_type === 'H') || result[0];
    const r1 = region.region_1depth_name; // 시/도
    const r2 = region.region_2depth_name; // 구/군/시

    const matched1 = findMatchingRegion1(r1);
    if (matched1) {
      state.activeRegion1 = matched1;
      state.activeRegion2 = null;
      const matched2 = r2 ? findMatchingRegion2(matched1, r2) : null;
      if (matched2) state.activeRegion2 = matched2;

      document.getElementById('region1-select').value = state.activeRegion1;
      populateRegion2Select(state.activeRegion1);
      if (state.activeRegion2) {
        document.getElementById('region2-select').value = state.activeRegion2;
      }

      statusEl.textContent = `📍 ${state.activeRegion1}${state.activeRegion2 ? ' ' + state.activeRegion2 : ''}`;
      applyFilter(false); // 지도 이동 없이 필터만
    } else {
      statusEl.textContent = '해당 지역의 검진기관 데이터가 없습니다.';
    }
  });
}

// applyFilter에 moveMap 옵션 추가
function applyFilter(moveMap = true) {
  closeOverlay();
  let result = state.allFacilities;
  if (state.activeRegion1) result = result.filter(f => f.region1 === state.activeRegion1);
  if (state.activeRegion2) result = result.filter(f => f.region2 === state.activeRegion2);
  state.filteredFacilities = result;
  state.renderedCount = 0;
  state.activeCardId = null;
  render();

  if (moveMap && state.activeRegion1) {
    const withCoords = result.filter(f => f.lat && f.lng);
    if (withCoords.length > 0) {
      const bounds = new kakao.maps.LatLngBounds();
      withCoords.forEach(f => bounds.extend(new kakao.maps.LatLng(f.lat, f.lng)));
      map.setBounds(bounds, 50);
    }
  }
}

function findMatchingRegion1(name) {
  const keys = Object.keys(state.regionIndex);
  if (keys.includes(name)) return name;
  return keys.find(k =>
    k.startsWith(name.slice(0, 2)) || name.startsWith(k.slice(0, 2))
  ) || null;
}

function findMatchingRegion2(region1, name) {
  const list = state.regionIndex[region1] || [];
  if (list.includes(name)) return name;
  return list.find(d =>
    d.startsWith(name.slice(0, 2)) || name.startsWith(d.slice(0, 2))
  ) || null;
}

// ── 렌더링 ───────────────────────────────────────────────
function render() {
  renderMarkers();
  renderListOnly();
  renderListCount();
}

function renderMarkers() {
  closeOverlay();
  // 기존 마커 제거
  clusterer.clear();
  state.markerMap.clear();
  state.kakaoMarkers = [];

  const dotImg = DOT_NORMAL();
  const toShow = state.filteredFacilities.filter(f => f.lat && f.lng);

  toShow.forEach(f => {
    const pos = new kakao.maps.LatLng(f.lat, f.lng);
    const marker = new kakao.maps.Marker({ position: pos, image: dotImg });

    // 인포윈도우
    const infoWindow = new kakao.maps.InfoWindow({
      content: makeInfoWindowHtml(f),
      removable: true,
    });

    kakao.maps.event.addListener(marker, 'click', () => {
      closeOverlay();
      infoWindow.open(map, marker);
      state.openOverlay = infoWindow;
      highlightCard(f.id);
      marker.setImage(DOT_ACTIVE());
    });

    state.kakaoMarkers.push(marker);
    state.markerMap.set(f.id, { marker, infoWindow });
  });

  clusterer.addMarkers(state.kakaoMarkers);
}

function makeInfoWindowHtml(f) {
  return `<div style="padding:10px 14px;min-width:200px;font-family:'맑은 고딕',sans-serif;">
    <div style="font-weight:700;font-size:14px;color:#1565C0;margin-bottom:5px;">${escHtml(f.name)}</div>
    <div style="font-size:11px;color:#888;margin-bottom:3px;">${escHtml(f.region1)} · ${escHtml(f.region2)}</div>
    <div style="font-size:12px;color:#444;line-height:1.6;">${escHtml(f.address)}</div>
  </div>`;
}

function closeOverlay() {
  if (state.openOverlay) {
    state.openOverlay.close();
    state.openOverlay = null;
  }
  // 활성 마커 색상 복원
  if (state.activeCardId) {
    const item = state.markerMap.get(state.activeCardId);
    if (item) item.marker.setImage(DOT_NORMAL());
  }
}

// ── 목록 렌더링 ───────────────────────────────────────────
function renderListOnly() {
  const list = document.getElementById('facility-list');
  list.innerHTML = '';
  state.renderedCount = 0;

  if (state.filteredFacilities.length === 0) {
    list.innerHTML = '<div class="list-empty">해당 지역의 검진기관이 없습니다.<br>다른 지역을 선택해 주세요.</div>';
    renderListCount();
    return;
  }

  appendFacilityCards(Math.min(RENDER_CHUNK, state.filteredFacilities.length));
  if (state.filteredFacilities.length > RENDER_CHUNK) addMoreButton();
  renderListCount();
}

function appendFacilityCards(upTo) {
  const list = document.getElementById('facility-list');
  const oldBtn = list.querySelector('.list-more-btn');
  if (oldBtn) oldBtn.remove();

  const end = Math.min(upTo, state.filteredFacilities.length);
  for (let i = state.renderedCount; i < end; i++) {
    list.appendChild(makeFacilityCard(state.filteredFacilities[i]));
  }
  state.renderedCount = end;
}

function makeFacilityCard(f) {
  const card = document.createElement('div');
  card.className = 'facility-card' + (f.id === state.activeCardId ? ' active' : '');
  card.dataset.id = f.id;
  const noLoc = !f.lat || !f.lng;
  card.innerHTML = `
    <div class="facility-name">${escHtml(f.name)}</div>
    <div class="facility-region">${escHtml(f.region1)} · ${escHtml(f.region2)}</div>
    <div class="facility-address">${escHtml(f.address)}</div>
    ${noLoc ? '<span class="no-location-badge">위치 미등록</span>' : ''}
  `;

  card.addEventListener('click', () => {
    if (f.lat && f.lng) {
      closeOverlay();
      map.setCenter(new kakao.maps.LatLng(f.lat, f.lng));
      map.setLevel(4);
      const item = state.markerMap.get(f.id);
      if (item) {
        item.infoWindow.open(map, item.marker);
        item.marker.setImage(DOT_ACTIVE());
        state.openOverlay = item.infoWindow;
      }
    }
    highlightCard(f.id);
  });

  return card;
}

function addMoreButton() {
  const list = document.getElementById('facility-list');
  const remaining = state.filteredFacilities.length - state.renderedCount;
  const btn = document.createElement('button');
  btn.className = 'list-more-btn';
  btn.textContent = `더 보기 (${remaining}개 남음)`;
  btn.addEventListener('click', () => {
    appendFacilityCards(state.renderedCount + RENDER_CHUNK);
    if (state.renderedCount < state.filteredFacilities.length) addMoreButton();
  });
  list.appendChild(btn);
}

function highlightCard(id) {
  document.querySelectorAll('.facility-card.active').forEach(el => el.classList.remove('active'));
  state.activeCardId = id;
  const card = document.querySelector(`.facility-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderListCount() {
  document.getElementById('list-count').textContent =
    state.activeRegion1
      ? `${state.activeRegion1}${state.activeRegion2 ? ' ' + state.activeRegion2 : ''}`
      : '전체 기관';
  document.getElementById('list-total').textContent =
    `${state.filteredFacilities.length.toLocaleString()}개`;
}

function updateStats(data) {
  const withCoords = data.filter(f => f.lat && f.lng).length;
  document.getElementById('stats').innerHTML =
    `전체 기관: <b>${data.length}개</b><br>지도 표시: <b>${withCoords}개</b>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 앱 시작 (카카오 SDK 로드 완료 후 실행) ───────────────
kakao.maps.load(function () {
  initMap();
  loadData().catch(err => {
    document.getElementById('facility-list').innerHTML =
      `<div class="list-empty">데이터 로드 실패.<br>로컬 서버에서 실행해 주세요.<br><small>${err.message}</small></div>`;
  });
});
