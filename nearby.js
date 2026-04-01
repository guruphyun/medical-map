'use strict';

const LS_C_ADDED   = 'medmap_clients_added';
const LS_C_EDITED  = 'medmap_clients_edited';
const LS_C_DELETED = 'medmap_clients_deleted';

const state = {
  mode: 'client',
  base: null,
  radius: 10,
  clients: [],
  facilities: [],
  clientMarkers: new Map(),
  facilityMarkers: new Map(),
  resultMarkers: [],
  searchCircle: null,
  openIW: null,
  editingClientId: null,
  pendingLat: null,
  pendingLng: null,
};

let map, geocoder;

// ── LocalStorage ──────────────────────────────────────────
function lsGet(k)       { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v)    { localStorage.setItem(k, JSON.stringify(v)); }
function getCAdded()    { return lsGet(LS_C_ADDED)   || []; }
function getCEdited()   { return lsGet(LS_C_EDITED)  || {}; }
function getCDeleted()  { return lsGet(LS_C_DELETED) || []; }

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 지도 초기화 ──────────────────────────────────────────
function initMap() {
  map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(36.5, 127.8),
    level: 8, draggable: true, scrollwheel: true,
  });
  map.addControl(new kakao.maps.ZoomControl(),    kakao.maps.ControlPosition.RIGHT);
  map.addControl(new kakao.maps.MapTypeControl(), kakao.maps.ControlPosition.TOPRIGHT);
  geocoder = new kakao.maps.services.Geocoder();
}

// ── 마커 이미지 ──────────────────────────────────────────
function makeClientPin(active = false, isBase = false) {
  const fill   = isBase   ? '#FF8F00' : (active ? '#FF5722' : '#E53935');
  const stroke = isBase   ? '#E65100' : (active ? '#BF360C' : '#B71C1C');
  const r      = isBase   ? 5.5 : 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30">
    <path d="M11 0C4.9 0 0 4.9 0 11c0 8.3 11 19 11 19s11-10.7 11-19C22 4.9 17.1 0 11 0z"
      fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
    <circle cx="11" cy="11" r="${r}" fill="white" fill-opacity="0.9"/>
  </svg>`;
  return new kakao.maps.MarkerImage(
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
    new kakao.maps.Size(22, 30),
    { offset: new kakao.maps.Point(11, 30) }
  );
}

function makeFacilityDot(isBase = false) {
  const fill   = isBase ? '#FF8F00' : '#2196F3';
  const stroke = isBase ? '#E65100' : '#1565C0';
  const r      = isBase ? 7 : 5.5;
  const size   = isBase ? 18 : 14;
  const half   = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="${half}" cy="${half}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
  </svg>`;
  return new kakao.maps.MarkerImage(
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
    new kakao.maps.Size(size, size),
    { offset: new kakao.maps.Point(half, half) }
  );
}

// ── 데이터 로드 ──────────────────────────────────────────
async function loadData() {
  try {
    const [cr, fr] = await Promise.all([
      fetch('data/clients.json').then(r => r.json()).catch(() => []),
      fetch('data/facilities.json').then(r => r.json()).catch(() => []),
    ]);
    applyClientMods(cleanNan(cr));
    state.facilities = cleanNan(fr);
    updateStats();
  } catch(e) {
    document.getElementById('stats').textContent = '데이터 로드 오류: ' + e.message;
  }
}

function cleanNan(arr) {
  return (arr || []).map(item => {
    const cleaned = { ...item };
    ['name','address','detail','region1','region2'].forEach(k => {
      if (String(cleaned[k] || '').toLowerCase() === 'nan') cleaned[k] = '';
    });
    ['lat','lng'].forEach(k => {
      if (String(cleaned[k] || '').toLowerCase() === 'nan') cleaned[k] = null;
    });
    return cleaned;
  });
}

function applyClientMods(base) {
  const edited  = getCEdited();
  const added   = getCAdded();
  const deleted = getCDeleted();
  const merged = base
    .filter(c => !deleted.includes(String(c.id)))
    .map(c => {
      const e = edited[c.id] || edited[String(c.id)];
      return e ? { ...c, ...e } : c;
    });
  const newItems = added
    .filter(c => !deleted.includes(String(c.id)))
    .map(c => ({ ...c, isNew: true }));
  state.clients = [...merged, ...newItems];
}

// ── 마커 렌더링 ──────────────────────────────────────────
function clearMarkers(markerMap) {
  markerMap.forEach(({ marker }) => marker.setMap(null));
  markerMap.clear();
}

function renderClientMarkers() {
  clearMarkers(state.clientMarkers);
  state.clients.filter(c => c.lat && c.lng).forEach(c => {
    const isBase = state.base?.type === 'client' && String(state.base.id) === String(c.id);
    const marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(c.lat, c.lng),
      map, image: makeClientPin(false, isBase), title: c.name,
    });
    kakao.maps.event.addListener(marker, 'click', () => {
      if (state.mode === 'client') selectBase(c, 'client');
      else showClientIW(c, marker);
    });
    state.clientMarkers.set(String(c.id), { marker, data: c });
  });
}

function renderFacilityMarkers() {
  clearMarkers(state.facilityMarkers);
  state.facilities.filter(f => f.lat && f.lng).forEach(f => {
    const isBase = state.base?.type === 'facility' && String(state.base.id) === String(f.id);
    const marker = new kakao.maps.Marker({
      position: new kakao.maps.LatLng(f.lat, f.lng),
      map, image: makeFacilityDot(isBase), title: f.name,
    });
    kakao.maps.event.addListener(marker, 'click', () => {
      if (state.mode === 'facility') selectBase(f, 'facility');
    });
    state.facilityMarkers.set(String(f.id), { marker, data: f });
  });
}

function showClientIW(c, marker) {
  if (state.openIW) state.openIW.close();
  const sid = String(c.id).replace(/'/g, "\\'");
  const iw = new kakao.maps.InfoWindow({
    content: `<div style="padding:10px 12px;min-width:200px;font-family:'맑은 고딕',sans-serif;">
      <div style="font-weight:700;font-size:13px;color:#E53935;margin-bottom:3px;">🏢 ${escHtml(c.name)}</div>
      <div style="font-size:11px;color:#666;margin-bottom:8px;">${escHtml(c.region1)} · ${escHtml(c.region2)}</div>
      <div style="font-size:12px;color:#444;margin-bottom:8px;">${escHtml(c.address)}</div>
      <div style="display:flex;gap:6px;border-top:1px solid #eee;padding-top:8px;">
        <button onclick="openClientModal('${sid}')"
          style="flex:1;padding:5px;background:#1565C0;color:#fff;border:none;border-radius:4px;font-size:11px;cursor:pointer;">✏️ 수정</button>
        <button onclick="deleteClient('${sid}')"
          style="flex:1;padding:5px;background:#fff;color:#E53935;border:1px solid #E53935;border-radius:4px;font-size:11px;cursor:pointer;">🗑️ 삭제</button>
      </div>
    </div>`,
    removable: true,
  });
  iw.open(map, marker);
  state.openIW = iw;
}

// ── 기준 선택 & 반경 검색 ────────────────────────────────
function selectBase(item, type) {
  if (state.openIW) { state.openIW.close(); state.openIW = null; }

  // 이전 기준 마커 초기화
  if (state.base) {
    const prev = type === 'client'
      ? state.clientMarkers.get(String(state.base.id))
      : state.facilityMarkers.get(String(state.base.id));
    if (prev) prev.marker.setImage(type === 'client' ? makeClientPin(false, false) : makeFacilityDot(false));
  }

  state.base = { ...item, type };

  // 새 기준 마커 강조
  const cur = type === 'client'
    ? state.clientMarkers.get(String(item.id))
    : state.facilityMarkers.get(String(item.id));
  if (cur) cur.marker.setImage(type === 'client' ? makeClientPin(false, true) : makeFacilityDot(true));

  updateBaseDisplay();
  doSearch();
}

function doSearch() {
  if (!state.base || !state.base.lat || !state.base.lng) return;
  const { lat, lng } = state.base;
  const r = state.radius;

  // 원 그리기
  if (state.searchCircle) state.searchCircle.setMap(null);
  state.searchCircle = new kakao.maps.Circle({
    center: new kakao.maps.LatLng(lat, lng),
    radius: r * 1000,
    strokeWeight: 2, strokeColor: '#1565C0', strokeOpacity: 0.7, strokeStyle: 'dashed',
    fillColor: '#2196F3', fillOpacity: 0.06,
  });
  state.searchCircle.setMap(map);

  // 이전 결과 마커 제거
  state.resultMarkers.forEach(m => m.setMap(null));
  state.resultMarkers = [];

  let results = [];
  if (state.mode === 'client') {
    // 기준: 고객사 → 반경 내 검진기관
    results = state.facilities
      .filter(f => f.lat && f.lng)
      .map(f => ({ ...f, _type: 'facility', distance: haversine(lat, lng, f.lat, f.lng) }))
      .filter(f => f.distance <= r)
      .sort((a, b) => a.distance - b.distance);

    results.forEach(f => {
      const m = new kakao.maps.Marker({
        position: new kakao.maps.LatLng(f.lat, f.lng),
        map, image: makeFacilityDot(false), title: f.name,
      });
      kakao.maps.event.addListener(m, 'click', () => {
        if (state.openIW) state.openIW.close();
        const iw = new kakao.maps.InfoWindow({
          content: `<div style="padding:8px 10px;min-width:180px;font-family:'맑은 고딕',sans-serif;">
            <div style="font-weight:700;font-size:13px;color:#1565C0;">🏥 ${escHtml(f.name)}</div>
            <div style="font-size:11px;color:#666;margin-top:3px;">${escHtml(f.region1)} · ${escHtml(f.region2)}</div>
            <div style="font-size:12px;color:#444;margin-top:4px;">${escHtml(f.address)}</div>
            <div style="font-size:11px;color:#1565C0;margin-top:4px;font-weight:600;">${f.distance.toFixed(1)}km</div>
          </div>`,
          removable: true,
        });
        iw.open(map, m);
        state.openIW = iw;
      });
      state.resultMarkers.push(m);
    });
  } else {
    // 기준: 검진기관 → 반경 내 고객사
    results = state.clients
      .filter(c => c.lat && c.lng && String(c.id) !== String(state.base.id))
      .map(c => ({ ...c, _type: 'client', distance: haversine(lat, lng, c.lat, c.lng) }))
      .filter(c => c.distance <= r)
      .sort((a, b) => a.distance - b.distance);

    results.forEach(c => {
      const m = new kakao.maps.Marker({
        position: new kakao.maps.LatLng(c.lat, c.lng),
        map, image: makeClientPin(false, false), title: c.name,
      });
      kakao.maps.event.addListener(m, 'click', () => showClientIW(c, m));
      state.resultMarkers.push(m);
    });
  }

  window._searchResults = results;
  renderResults(results);

  // 지도 범위 맞춤
  const bounds = new kakao.maps.LatLngBounds();
  bounds.extend(new kakao.maps.LatLng(lat, lng));
  results.slice(0, 30).forEach(x => bounds.extend(new kakao.maps.LatLng(x.lat, x.lng)));
  map.setBounds(bounds, 60);
}

// ── 거리 계산 (Haversine) ────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── 결과 렌더링 ───────────────────────────────────────────
function renderResults(results) {
  const type = state.mode === 'client' ? '검진기관' : '고객사';
  const countEl = document.getElementById('result-count');
  const listEl  = document.getElementById('result-list');
  const exportBtn = document.getElementById('result-export-btn');

  countEl.textContent = `반경 ${state.radius}km 내 ${type} ${results.length}개`;
  exportBtn.classList.toggle('hidden', results.length === 0);

  if (!results.length) {
    listEl.innerHTML = `<div class="no-result">반경 ${state.radius}km 내에<br>${type}이 없습니다.</div>`;
    return;
  }

  listEl.innerHTML = results.map((item, i) => {
    const icon = item._type === 'facility' ? '🏥' : '🏢';
    const region = `${escHtml(item.region1 || '')} ${escHtml(item.region2 || '')}`.trim();
    return `<div class="result-item" data-idx="${i}" onclick="focusResult(${i})">
      <div class="result-rank">${i+1}</div>
      <div class="result-info">
        <div class="result-name">${icon} ${escHtml(item.name)}</div>
        <div class="result-sub">${region}</div>
        <div class="result-addr">${escHtml(item.address || '')}</div>
      </div>
      <div class="result-dist">${item.distance.toFixed(1)}<span class="dist-unit">km</span></div>
    </div>`;
  }).join('');
}

window.focusResult = function(i) {
  const item = window._searchResults[i];
  if (!item?.lat || !item?.lng) return;
  map.setCenter(new kakao.maps.LatLng(item.lat, item.lng));
  map.setLevel(4);
  // 결과 아이템 하이라이트
  document.querySelectorAll('.result-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.result-item[data-idx="${i}"]`)?.classList.add('active');
};

// ── 기준 표시 ─────────────────────────────────────────────
function updateBaseDisplay() {
  const el = document.getElementById('base-info');
  if (!state.base) {
    el.innerHTML = '<span class="base-hint">지도에서 클릭하거나<br>위에서 검색하세요</span>';
    return;
  }
  const icon = state.base.type === 'client' ? '🏢' : '🏥';
  const hasLoc = state.base.lat && state.base.lng;
  el.innerHTML = `
    <div class="base-card">
      <div class="base-name">${icon} ${escHtml(state.base.name)}</div>
      <div class="base-addr">${escHtml(state.base.region1 || '')} ${escHtml(state.base.region2 || '')}</div>
      <div class="base-addr">${escHtml(state.base.address || '')}</div>
      ${!hasLoc ? '<div class="base-no-loc">⚠️ 위치 정보 없음</div>' : ''}
    </div>`;
}

// ── 모드 전환 ─────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  state.base = null;
  if (state.openIW) { state.openIW.close(); state.openIW = null; }
  if (state.searchCircle) { state.searchCircle.setMap(null); state.searchCircle = null; }
  state.resultMarkers.forEach(m => m.setMap(null));
  state.resultMarkers = [];

  document.getElementById('btn-mode-client').classList.toggle('active', mode === 'client');
  document.getElementById('btn-mode-facility').classList.toggle('active', mode === 'facility');
  document.getElementById('search-input').value = '';
  document.getElementById('search-dropdown').classList.add('hidden');
  document.getElementById('search-input').placeholder = mode === 'client' ? '고객사 검색...' : '검진기관 검색...';
  document.getElementById('mode-hint').textContent = mode === 'client'
    ? '고객사를 선택하면 반경 내 검진기관이 표시됩니다.'
    : '검진기관을 선택하면 반경 내 고객사가 표시됩니다.';

  updateBaseDisplay();
  document.getElementById('result-list').innerHTML = '<div class="no-result-init"><p>기준을 선택하세요</p></div>';
  document.getElementById('result-count').textContent = '기준을 선택하세요';
  document.getElementById('result-export-btn').classList.add('hidden');

  clearMarkers(state.clientMarkers);
  clearMarkers(state.facilityMarkers);

  if (mode === 'client') {
    renderClientMarkers();
  } else {
    renderFacilityMarkers();
  }
}

// ── 검색 자동완성 ────────────────────────────────────────
document.getElementById('search-input').addEventListener('input', function() {
  const q = this.value.trim().toLowerCase();
  const clearBtn = document.getElementById('search-clear');
  clearBtn.classList.toggle('hidden', !this.value);
  if (!q) { document.getElementById('search-dropdown').classList.add('hidden'); return; }
  const pool = state.mode === 'client' ? state.clients : state.facilities;
  const matches = pool.filter(x => x.name.toLowerCase().includes(q)).slice(0, 8);
  const dd = document.getElementById('search-dropdown');
  if (!matches.length) { dd.classList.add('hidden'); return; }
  dd.innerHTML = matches.map(x => `
    <div class="dd-item" data-id="${x.id}">
      <span class="dd-name">${escHtml(x.name)}</span>
      <span class="dd-region">${escHtml(x.region1 || '')} ${escHtml(x.region2 || '')}</span>
    </div>`).join('');
  dd.classList.remove('hidden');
});

document.getElementById('search-clear').addEventListener('click', () => {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').classList.add('hidden');
  document.getElementById('search-dropdown').classList.add('hidden');
});

document.getElementById('search-dropdown').addEventListener('click', e => {
  const item = e.target.closest('.dd-item');
  if (!item) return;
  const id = item.dataset.id;
  const pool = state.mode === 'client' ? state.clients : state.facilities;
  const found = pool.find(x => String(x.id) === String(id));
  if (!found) return;
  document.getElementById('search-input').value = found.name;
  document.getElementById('search-dropdown').classList.add('hidden');
  document.getElementById('search-clear').classList.remove('hidden');

  if (!found.lat || !found.lng) {
    alert('해당 기관의 위치 정보가 없습니다.\n주소를 수정하여 위치를 등록해 주세요.');
    state.base = { ...found, type: state.mode };
    updateBaseDisplay();
    return;
  }
  const markerStore = state.mode === 'client' ? state.clientMarkers : state.facilityMarkers;
  const entry = markerStore.get(String(found.id));
  if (entry) {
    map.setCenter(new kakao.maps.LatLng(found.lat, found.lng));
    map.setLevel(6);
    selectBase(found, state.mode);
  }
});

document.addEventListener('click', e => {
  if (!e.target.closest('#search-box')) document.getElementById('search-dropdown').classList.add('hidden');
});

// ── 반경 입력 ─────────────────────────────────────────────
document.getElementById('radius-input').addEventListener('input', function() {
  const v = Math.max(1, parseFloat(this.value) || 10);
  state.radius = v;
  document.getElementById('radius-slider').value = Math.min(50, v);
  if (state.base) doSearch();
});
document.getElementById('radius-slider').addEventListener('input', function() {
  state.radius = parseInt(this.value);
  document.getElementById('radius-input').value = state.radius;
  if (state.base) doSearch();
});

// ── 결과 복사 ─────────────────────────────────────────────
document.getElementById('result-export-btn').addEventListener('click', () => {
  if (!window._searchResults?.length) return;
  const baseName = state.base?.name || '';
  const type = state.mode === 'client' ? '검진기관' : '고객사';
  const lines = [
    `[${baseName}] 반경 ${state.radius}km 내 ${type} 목록`,
    '',
    ...window._searchResults.map((x, i) =>
      `${i+1}. ${x.name}  (${x.distance.toFixed(1)}km) - ${x.address}`)
  ];
  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => alert('클립보드에 복사했습니다.'))
    .catch(() => alert('복사 실패. 직접 선택하여 복사해 주세요.'));
});

// ── 고객사 CRUD ───────────────────────────────────────────
window.openClientModal = function(id = null) {
  state.editingClientId = id;
  const modal = document.getElementById('client-modal');
  if (id !== null) {
    const c = state.clients.find(x => String(x.id) === String(id));
    if (!c) return;
    document.getElementById('client-modal-title').textContent = '고객사 수정';
    document.getElementById('cm-name').value    = c.name || '';
    document.getElementById('cm-address').value = c.address || '';
    document.getElementById('cm-detail').value  = c.detail || '';
    document.getElementById('cm-region1').value = c.region1 || '';
    document.getElementById('cm-region2').value = c.region2 || '';
    document.getElementById('cm-geocode-status').textContent =
      c.lat ? `📍 ${parseFloat(c.lat).toFixed(5)}, ${parseFloat(c.lng).toFixed(5)}` : '위치 없음';
    state.pendingLat = c.lat; state.pendingLng = c.lng;
  } else {
    document.getElementById('client-modal-title').textContent = '고객사 추가';
    ['cm-name','cm-address','cm-detail','cm-region1','cm-region2'].forEach(
      eid => { document.getElementById(eid).value = ''; });
    document.getElementById('cm-geocode-status').textContent = '';
    state.pendingLat = null; state.pendingLng = null;
  }
  modal.classList.remove('hidden');
};

function closeClientModal() {
  document.getElementById('client-modal').classList.add('hidden');
}

document.getElementById('cm-geocode-btn').addEventListener('click', () => {
  const addr = document.getElementById('cm-address').value.trim();
  if (!addr) { alert('주소를 입력해 주세요.'); return; }
  const status = document.getElementById('cm-geocode-status');
  status.textContent = '검색 중...';
  geocoder.addressSearch(addr, (result, s) => {
    if (s !== kakao.maps.services.Status.OK || !result.length) {
      status.textContent = '주소를 찾을 수 없습니다.';
      return;
    }
    state.pendingLat = parseFloat(result[0].y);
    state.pendingLng = parseFloat(result[0].x);
    const a = result[0].address;
    document.getElementById('cm-region1').value = a?.region_1depth_name || '';
    document.getElementById('cm-region2').value = a?.region_2depth_name || '';
    status.textContent = `📍 ${state.pendingLat.toFixed(5)}, ${state.pendingLng.toFixed(5)}`;
  });
});

document.getElementById('client-modal-save').addEventListener('click', () => {
  const name    = document.getElementById('cm-name').value.trim();
  const address = document.getElementById('cm-address').value.trim();
  if (!name || !address) { alert('고객사명과 주소를 입력해 주세요.'); return; }
  const data = {
    name, address,
    detail:  document.getElementById('cm-detail').value.trim(),
    region1: document.getElementById('cm-region1').value.trim(),
    region2: document.getElementById('cm-region2').value.trim(),
    lat: state.pendingLat, lng: state.pendingLng,
  };
  if (state.editingClientId === null) {
    const added = getCAdded();
    added.push({ id: 'c_' + Date.now(), ...data });
    lsSet(LS_C_ADDED, added);
  } else {
    const edited = getCEdited();
    edited[state.editingClientId] = data;
    lsSet(LS_C_EDITED, edited);
  }
  closeClientModal();
  reloadAndRefresh();
});

document.getElementById('client-modal-close').addEventListener('click', closeClientModal);
document.getElementById('client-modal-cancel').addEventListener('click', closeClientModal);

window.deleteClient = function(id) {
  const c = state.clients.find(x => String(x.id) === String(id));
  if (!c || !confirm(`"${c.name}" 고객사를 삭제하시겠습니까?`)) return;
  const deleted = getCDeleted();
  deleted.push(String(id));
  lsSet(LS_C_DELETED, deleted);
  if (state.openIW) { state.openIW.close(); state.openIW = null; }
  reloadAndRefresh();
};

async function reloadAndRefresh() {
  const cr = await fetch('data/clients.json').then(r => r.json());
  applyClientMods(cr);
  state.base = null;
  if (state.searchCircle) { state.searchCircle.setMap(null); state.searchCircle = null; }
  state.resultMarkers.forEach(m => m.setMap(null));
  state.resultMarkers = [];
  updateBaseDisplay();
  document.getElementById('result-list').innerHTML = '';
  document.getElementById('result-count').textContent = '기준을 선택하세요';
  if (state.mode === 'client') renderClientMarkers();
  else renderFacilityMarkers();
  updateStats();
  if (document.getElementById('client-manage-modal').classList.contains('hidden') === false) {
    renderClientManageList();
  }
}

// ── 고객사 관리 모달 ──────────────────────────────────────
document.getElementById('client-manage-btn').addEventListener('click', () => {
  renderClientManageList();
  document.getElementById('client-manage-modal').classList.remove('hidden');
});
document.getElementById('cm-manage-close').addEventListener('click', () => {
  document.getElementById('client-manage-modal').classList.add('hidden');
});
document.getElementById('cm-manage-done').addEventListener('click', () => {
  document.getElementById('client-manage-modal').classList.add('hidden');
});

document.getElementById('cm-filter-input').addEventListener('input', function() {
  renderClientManageList(this.value.trim());
});

function renderClientManageList(filter = '') {
  const el = document.getElementById('cm-manage-list');
  const q  = filter.toLowerCase();
  const list = q ? state.clients.filter(c => c.name.toLowerCase().includes(q)) : state.clients;

  if (!list.length) {
    el.innerHTML = '<div class="no-result" style="padding:20px;">고객사가 없습니다.</div>';
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="cm-manage-item">
      <div class="cm-item-info">
        <span class="cm-item-name">${escHtml(c.name)}</span>
        <span class="cm-item-region">${escHtml(c.region1 || '')} ${escHtml(c.region2 || '')}</span>
        <span class="cm-item-addr">${escHtml(c.address || '')}</span>
      </div>
      <div class="cm-item-loc">${c.lat ? '📍' : '⚠️'}</div>
      <div class="cm-item-actions">
        <button onclick="openClientModal('${String(c.id).replace(/'/g,"\\'")}');document.getElementById('client-manage-modal').classList.add('hidden');"
          class="cm-item-btn edit">수정</button>
        <button onclick="deleteClient('${String(c.id).replace(/'/g,"\\'")}')"
          class="cm-item-btn del">삭제</button>
      </div>
    </div>`).join('');
}

// ── 통계 ─────────────────────────────────────────────────
function updateStats() {
  const withLoc = state.clients.filter(c => c.lat && c.lng).length;
  document.getElementById('stats').innerHTML =
    `<span>고객사: <b>${state.clients.length}</b>개</span>
     <span>위치 확인: <b>${withLoc}</b>개</span>
     <span>검진기관: <b>${state.facilities.length}</b>개</span>`;
}

// ── 추가 버튼 ─────────────────────────────────────────────
document.getElementById('add-client-btn').addEventListener('click', () => openClientModal(null));

// ── 초기화 ────────────────────────────────────────────────
kakao.maps.load(() => {
  initMap();
  loadData().then(() => setMode('client'));
});
