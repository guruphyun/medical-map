'use strict';

const RENDER_CHUNK = 100; // 초기 렌더링 개수

const state = {
  allFacilities: [],
  filteredFacilities: [],
  activeRegion1: null,
  activeRegion2: null,
  regionIndex: {},      // { 지역1: [지역2, ...] }
  renderedCount: 0,
  activeCardId: null,
  markers: new Map(),   // id → marker
};

let map, markerCluster;

// ── 지도 초기화 ──────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [36.5, 127.8],
    zoom: 7,
    maxBounds: [[32.5, 123.5], [39.0, 132.5]],
    maxBoundsViscosity: 0.8,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  markerCluster = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 60,
    showCoverageOnHover: false,
  });
  map.addLayer(markerCluster);

  // 지도 클릭 → 역지오코딩으로 지역 감지
  map.on('click', onMapClick);
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
  for (const r1 in index) {
    index[r1] = [...index[r1]].sort();
  }
  return index;
}

// ── 필터 드롭다운 ─────────────────────────────────────────
function populateRegion1Select() {
  const sel = document.getElementById('region1-select');
  const regions = Object.keys(state.regionIndex).sort();
  sel.innerHTML = '<option value="">전체 지역</option>';
  for (const r of regions) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    sel.appendChild(opt);
  }
}

function populateRegion2Select(region1) {
  const sel = document.getElementById('region2-select');
  sel.innerHTML = '<option value="">전체 구역</option>';
  if (!region1) {
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const regions = state.regionIndex[region1] || [];
  for (const r of regions) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
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
  map.setView([36.5, 127.8], 7);
});

function applyFilter() {
  let result = state.allFacilities;
  if (state.activeRegion1) {
    result = result.filter(f => f.region1 === state.activeRegion1);
  }
  if (state.activeRegion2) {
    result = result.filter(f => f.region2 === state.activeRegion2);
  }
  state.filteredFacilities = result;
  state.renderedCount = 0;
  state.activeCardId = null;
  render();
}

// ── 지도 클릭 (역지오코딩) ───────────────────────────────
async function onMapClick(e) {
  const { lat, lng } = e.latlng;
  const statusEl = document.getElementById('click-status');
  statusEl.textContent = '지역 정보를 가져오는 중...';

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ko`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'ko' } });
    const data = await res.json();

    const addr = data.address || {};
    // 시/도 추출 시도 (province > state > city)
    const province = addr.province || addr.state || addr.city || addr.county || null;
    // 구/군/시 추출
    const district = addr.city_district || addr.suburb || addr.town || addr.city || null;

    if (province) {
      // 지역1 매칭: 정규화된 이름 찾기
      const matched1 = findMatchingRegion1(province);
      if (matched1) {
        state.activeRegion1 = matched1;
        state.activeRegion2 = null;

        // district 매칭 시도
        if (district) {
          const matched2 = findMatchingRegion2(matched1, district);
          if (matched2) state.activeRegion2 = matched2;
        }

        // UI 동기화
        const sel1 = document.getElementById('region1-select');
        sel1.value = state.activeRegion1;
        populateRegion2Select(state.activeRegion1);
        if (state.activeRegion2) {
          document.getElementById('region2-select').value = state.activeRegion2;
        }

        statusEl.textContent = `📍 ${state.activeRegion1}${state.activeRegion2 ? ' ' + state.activeRegion2 : ''}`;
        applyFilter();
        return;
      }
    }

    // 역지오코딩 실패 → 뷰포트 기반 폴백
    statusEl.textContent = '클릭 위치 주변 기관을 표시합니다.';
    showViewportFacilities();
  } catch {
    statusEl.textContent = '지역 정보를 가져올 수 없습니다.';
    showViewportFacilities();
  }
}

function findMatchingRegion1(province) {
  const keys = Object.keys(state.regionIndex);
  // 완전 일치
  if (keys.includes(province)) return province;
  // 부분 일치 (앞 2글자 공통)
  return keys.find(k => k.startsWith(province.slice(0, 2)) || province.startsWith(k.slice(0, 2))) || null;
}

function findMatchingRegion2(region1, district) {
  const list = state.regionIndex[region1] || [];
  if (list.includes(district)) return district;
  return list.find(d => d.startsWith(district.slice(0, 2)) || district.startsWith(d.slice(0, 2))) || null;
}

function showViewportFacilities() {
  const bounds = map.getBounds();
  const visible = state.allFacilities.filter(
    f => f.lat && f.lng && bounds.contains([f.lat, f.lng])
  );
  state.filteredFacilities = visible;
  state.renderedCount = 0;
  state.activeCardId = null;
  renderListOnly();
}

// ── 렌더링 ───────────────────────────────────────────────
function render() {
  renderMarkers();
  renderListOnly();
  renderListCount();

  // 필터 적용 시 지도 뷰 조정
  if ((state.activeRegion1 || state.activeRegion2) && markerCluster.getLayers().length > 0) {
    try {
      map.fitBounds(markerCluster.getBounds(), { padding: [40, 40], maxZoom: 13 });
    } catch {}
  }
}

function renderMarkers() {
  markerCluster.clearLayers();
  state.markers.clear();

  const toShow = state.filteredFacilities.filter(f => f.lat && f.lng);
  for (const f of toShow) {
    const marker = L.circleMarker([f.lat, f.lng], {
      radius: 7,
      fillColor: '#2196F3',
      color: '#1565C0',
      weight: 1.5,
      fillOpacity: 0.85,
    });

    marker.bindPopup(makePopupHtml(f));
    marker.bindTooltip(f.name, { direction: 'top', offset: [0, -8] });
    marker.on('click', () => highlightCard(f.id));

    markerCluster.addLayer(marker);
    state.markers.set(f.id, marker);
  }
}

function makePopupHtml(f) {
  return `
    <div class="popup-name">${escHtml(f.name)}</div>
    <div class="popup-region">${escHtml(f.region1)} ${escHtml(f.region2)}</div>
    <div class="popup-address">${escHtml(f.address)}</div>
  `;
}

function renderListOnly() {
  const list = document.getElementById('facility-list');
  list.innerHTML = '';
  state.renderedCount = 0;

  const facilities = state.filteredFacilities;
  if (facilities.length === 0) {
    list.innerHTML = '<div class="list-empty">해당 지역의 검진기관이 없습니다.<br>다른 지역을 선택해 주세요.</div>';
    renderListCount();
    return;
  }

  appendFacilityCards(Math.min(RENDER_CHUNK, facilities.length));

  if (facilities.length > RENDER_CHUNK) {
    addMoreButton();
  }
  renderListCount();
}

function appendFacilityCards(upTo) {
  const list = document.getElementById('facility-list');
  const oldMoreBtn = list.querySelector('.list-more-btn');
  if (oldMoreBtn) oldMoreBtn.remove();

  const facilities = state.filteredFacilities;
  const end = Math.min(upTo, facilities.length);

  for (let i = state.renderedCount; i < end; i++) {
    list.appendChild(makeFacilityCard(facilities[i]));
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
      map.setView([f.lat, f.lng], 16);
      const marker = state.markers.get(f.id);
      if (marker) {
        markerCluster.zoomToShowLayer(marker, () => marker.openPopup());
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
    if (state.renderedCount < state.filteredFacilities.length) {
      addMoreButton();
    }
  });
  list.appendChild(btn);
}

function highlightCard(id) {
  // 이전 활성 카드 해제
  const prev = document.querySelector('.facility-card.active');
  if (prev) prev.classList.remove('active');

  state.activeCardId = id;
  const card = document.querySelector(`.facility-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderListCount() {
  const total = state.filteredFacilities.length;
  const all = state.allFacilities.length;
  document.getElementById('list-count').textContent =
    state.activeRegion1
      ? `${state.activeRegion1}${state.activeRegion2 ? ' ' + state.activeRegion2 : ''}`
      : '전체 기관';
  document.getElementById('list-total').textContent = `${total.toLocaleString()}개`;
}

function updateStats(data) {
  const withCoords = data.filter(f => f.lat && f.lng).length;
  const without = data.length - withCoords;
  const byQuality = {};
  for (const f of data) byQuality[f.geocode_quality] = (byQuality[f.geocode_quality] || 0) + 1;

  document.getElementById('stats').innerHTML = `
    전체 기관: <b>${data.length}개</b><br>
    지도 표시: <b>${withCoords}개</b>
    ${without > 0 ? `<br>위치 미등록: ${without}개` : ''}
  `;
}

// ── 유틸 ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 앱 시작 ───────────────────────────────────────────────
initMap();
loadData().catch(err => {
  document.getElementById('facility-list').innerHTML =
    `<div class="list-empty">데이터 로드 실패.<br>로컬 서버에서 실행해 주세요.<br><small>${err.message}</small></div>`;
});
