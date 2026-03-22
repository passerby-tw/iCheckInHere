// ==========================================
// 📍 iCheckInHere - 領域驅動架構 (v0.7.4 Offline-First)
// 包含: 本地專案註冊表 (0延遲)、背景雲端同步、手動綁定防呆
// ==========================================

const CLIENT_ID = '201112785315-pg6mrlaeig65sfu24mjfkjj544sf5mlj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

let records = JSON.parse(localStorage.getItem('checkins') || '[]');
let currentProject = JSON.parse(localStorage.getItem('current_project') || 'null');
// 🚀 新增：本地專案歷史註冊表，徹底消滅 API 搜尋延遲
let projectHistory = JSON.parse(localStorage.getItem('project_history') || '[]'); 

let syncSession = 'UNTRUSTED';
let currentAccessToken = null;
let tokenClient;
let editingId = null;

// ==========================================
// 0. 台電電力座標引擎 
// ==========================================
(function() {
    'use strict';
    const a = 6378137.0, b = 6356752.314245; 
    const e2 = (a*a - b*b) / (a*a);
    const ePrime2 = (a*a - b*b) / (b*b);
    const lon0 = 121 * Math.PI/180, k0 = 0.9999, FE = 250000, FN = 0;
    const SHIFT_X = 828.589, SHIFT_Y = -206.915; 
  
    const XminTable = { 170000: ['A','D','G','K','N','Q','T','V'], 250000: ['B','E','H','L','O','R','U','W'], 90000: ['J','M','P'], 330000: ['C','F'] };
    const YminTable = { 2750000: ['A','B','C'], 2700000: ['D','E','F'], 2650000: ['G','H'], 2600000: ['J','K','L'], 2550000: ['M','N','O'], 2500000: ['P','Q','R'], 2450000: ['T','U'], 2400000: ['V','W'] };
    const VALID_REGIONS = (() => { const s = new Set(); Object.values(XminTable).forEach(v => v.forEach(c => s.add(c))); Object.values(YminTable).forEach(v => v.forEach(c => s.add(c))); return Array.from(s); })();
  
    function getRegionOriginTW67(region){
      region = region.toUpperCase();
      if(!VALID_REGIONS.includes(region)) return null;
      let Xmin, Ymin;
      for (const [x, arr] of Object.entries(XminTable)) if (arr.includes(region)) { Xmin = Number(x); break; }
      for (const [y, arr] of Object.entries(YminTable)) if (arr.includes(region)) { Ymin = Number(y); break; }
      if (Xmin==null || Ymin==null) return null; return {Xmin, Ymin};
    }
  
    window.wgs84ToTaipower = function(latDeg, lonDeg){
      const lat = latDeg * Math.PI/180, lon = lonDeg * Math.PI/180;
      const N = a / Math.sqrt(1 - e2 * Math.sin(lat)**2);
      const T = Math.tan(lat)**2, C = ePrime2 * Math.cos(lat)**2;
      const A = Math.cos(lat) * (lon - lon0);
      const M = a * ((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256) * lat - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024) * Math.sin(2*lat) + (15*e2**2/256 + 45*e2**3/1024) * Math.sin(4*lat) - (35*e2**3/3072) * Math.sin(6*lat));
      const x97 = FE + k0 * N * (A + (1 - T + C)*A**3/6 + (5 - 18*T + T**2 + 72*C - 58*ePrime2)*A**5/120);
      const y97 = FN + k0 * (M + N*Math.tan(lat) * (A**2/2 + (5 - T + 9*C + 4*C**2)*A**4/24 + (61 - 58*T + T**2 + 600*C - 330*ePrime2)*A**6/720));
      const X67 = x97 - SHIFT_X, Y67 = y97 - SHIFT_Y;
      
      let chosen = null;
      for (const r of VALID_REGIONS){
        const origin = getRegionOriginTW67(r);
        const dX = X67 - origin.Xmin, dY = Y67 - origin.Ymin;
        if (dX>=0 && dX<80000 && dY>=0 && dY<50000){ chosen = {region:r, origin, dX, dY}; break; }
      }
      if(!chosen) throw new Error('座標超出範圍');
      
      const EE = Math.floor(chosen.dX/800), NN = Math.floor(chosen.dY/500);
      const rx = chosen.dX - EE*800, ry = chosen.dY - NN*500;
      const subE = Math.floor(rx/100), subN = Math.floor(ry/100);
      const ex = Math.floor(rx - subE*100), ey = Math.floor(ry - subN*100);
      return `${chosen.region}${String(EE).padStart(2,'0')}${String(NN).padStart(2,'0')} ${'ABCDEFGH'[subE]}${'ABCDE'[subN]}${Math.floor(ex/10)}${Math.floor(ey/10)}${Math.floor(ex%10)}${Math.floor(ey%10)}`;
    };
})();

// ==========================================
// 1. Session 狀態機與初始化
// ==========================================
window.onload = function() {
    evaluateSession();
    if (window.google) tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: '' });
};

function logMsg(msg) { document.getElementById('systemLog').innerText = msg; }

function evaluateSession() {
    const hasLocalOnly = records.some(r => r.sync_status === 'LOCAL_ONLY');
    document.getElementById('currentProjectName').innerText = currentProject ? currentProject.name : '尚未綁定專案';
    
    if (currentAccessToken && currentProject && !hasLocalOnly) {
        syncSession = 'TRUSTED';
        document.getElementById('sessionStatus').className = 'status-badge status-trusted';
        document.getElementById('sessionStatus').innerText = '🟢 TRUSTED (打卡將自動同步)';
    } else {
        syncSession = 'UNTRUSTED';
        document.getElementById('sessionStatus').className = 'status-badge status-untrusted';
        document.getElementById('sessionStatus').innerText = '⚠️ UNTRUSTED (資料僅存本地)';
    }
    localStorage.setItem('checkins', JSON.stringify(records));
    renderUI();
}

function withAuth(actionCallback) {
    if (currentAccessToken) { actionCallback(currentAccessToken); }
    else {
        tokenClient.callback = async (resp) => {
            if (resp.error) return alert('授權失敗，請重試！');
            currentAccessToken = resp.access_token;
            evaluateSession();
            actionCallback(currentAccessToken);
        };
        tokenClient.requestAccessToken();
    }
}

// ==========================================
// 2. 專案建立與歷史註冊表
// ==========================================
function saveToProjectHistory(id, name, time) {
    const existing = projectHistory.find(p => p.id === id);
    if (existing) {
        if (name !== '手動綁定專案 (載入後更新)') existing.name = name;
    } else {
        projectHistory.push({ id, name, createdTime: time });
    }
    projectHistory.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
    localStorage.setItem('project_history', JSON.stringify(projectHistory));
}

function createNewProject() {
    withAuth(async (token) => {
        if (records.some(r => r.sync_status === 'LOCAL_ONLY') && !confirm('⚠️ 有未同步資料，切換專案將重置工作區。確定繼續嗎？')) return;
        
        logMsg('⏳ 建立專案與寫入 Metadata...');
        const today = new Date().toISOString().split('T')[0];
        const title = `iCheckInHere 現場記錄 (${today})`;
        
        try {
            const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
                method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ properties: { title: title }, sheets: [{ properties: { title: '打卡主檔' } }, { properties: { title: '照片交易檔' } }] })
            });
            const data = await res.json();
            const sheetId = data.spreadsheetId;
            
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/打卡主檔!A1:I1?valueInputOption=USER_ENTERED`, {
                method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ values: [["ID", "打卡時間", "定位時間", "緯度", "經度", "精準度", "電力座標", "備註", "Deleted"]] })
            });
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/照片交易檔!A1:B1?valueInputOption=USER_ENTERED`, {
                method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ values: [["ID", "照片網址"]] })
            });

            // 🚀 核心：建立成功後，立刻寫入本地註冊表，下次開啟秒抓！
            saveToProjectHistory(sheetId, title, new Date().toISOString());

            currentProject = { id: sheetId, name: title };
            localStorage.setItem('current_project', JSON.stringify(currentProject));
            records = []; 
            evaluateSession();
            logMsg('🟢 專案建立完成！');
        } catch (e) { logMsg('🔴 建立失敗'); console.error(e); }
    });
}

function openProjectSelector() {
    document.getElementById('projectModal').style.display = 'flex';
    renderProjectListModal(); // 🚀 先瞬間渲染本地歷史紀錄 (0延遲)

    // 🚀 背景偷偷跑雲端掃描，幫忙抓取「在別台手機建立」的專案
    if (currentAccessToken) {
        const query = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
        fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=createdTime desc&pageSize=50&fields=files(id,name,createdTime)`, {
            headers: { 'Authorization': `Bearer ${currentAccessToken}` }
        })
        .then(res => res.json())
        .then(data => {
            if (data.files) {
                data.files.forEach(f => {
                    // 為了安全，只把檔名包含 iCheckInHere 的加入註冊表
                    if (f.name.includes('iCheckInHere')) saveToProjectHistory(f.id, f.name, f.createdTime);
                });
                renderProjectListModal(); // 雲端資料回來後，再刷新一次介面
            }
        }).catch(e => console.log('背景雲端掃描失敗', e));
    }
}

function renderProjectListModal() {
    const container = document.getElementById('projectListContainer');
    let html = '';

    if (projectHistory.length === 0) {
        html += `<p style="color:#666; font-size:0.9em;">目前無歷史紀錄。正在背景同步雲端專案...</p>`;
    } else {
        html += projectHistory.map(f => `
            <div class="project-item" onclick="bindProject('${f.id}', '${f.name}')">
                <strong>${f.name}</strong><br>
                <small style="color:#666;">建立於: ${new Date(f.createdTime).toLocaleString()}</small>
            </div>
        `).join('');
    }

    // 🚀 終極防呆：手動綁定網址 (如果跨裝置且雲端 API 當機時的救星)
    html += `
        <hr style="margin: 20px 0; border: 0.5px solid #eee;">
        <p style="font-size: 0.85em; color: #666; margin-bottom: 5px; font-weight:bold;">找不到專案？手動貼上網址綁定：</p>
        <div style="display: flex; gap: 5px;">
            <input type="text" id="manualUrlInput" placeholder="貼上 Google 試算表網址..." style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px; margin-top:0;">
            <button onclick="bindManualUrl()" style="background:#0052cc; color:white; border:none; border-radius:4px; padding:0 15px; font-weight:bold;">綁定</button>
        </div>
    `;
    container.innerHTML = html;
}

function bindManualUrl() {
    const url = document.getElementById('manualUrlInput').value.trim();
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) return alert('🔴 無效的試算表網址！');
    const id = match[1];
    saveToProjectHistory(id, '手動綁定專案 (覆寫後更新檔名)', new Date().toISOString());
    bindProject(id, '手動綁定專案');
}

function closeProjectSelector() { document.getElementById('projectModal').style.display = 'none'; }

function bindProject(id, name) {
    if (records.some(r => r.sync_status === 'LOCAL_ONLY') && !confirm('⚠️ 有未同步資料，切換專案將清空本地工作區！確定嗎？')) return;
    currentProject = { id: id, name: name };
    localStorage.setItem('current_project', JSON.stringify(currentProject));
    closeProjectSelector();
    pullFromCloud(); 
}

// ==========================================
// 3. Diff-Sync 同步引擎
// ==========================================
function pushUnsyncedData() {
    if (!currentProject) return alert('請先綁定或建立專案！');
    const unsynced = records.filter(r => r.sync_status === 'LOCAL_ONLY');
    if (unsynced.length === 0) { logMsg('🟢 無未備份資料'); return; }

    logMsg(`⏳ 分析與推播 ${unsynced.length} 筆異動...`);
    withAuth(async (token) => {
        try {
            const idRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${currentProject.id}/values/打卡主檔!A:A`, { headers:{'Authorization':`Bearer ${token}`} });
            const idData = await idRes.json();
            const cloudIds = idData.values ? idData.values.map(row => row[0]) : [];
            
            const appendMain = [], appendPhoto = [];
            const updateBatch = [];

            unsynced.forEach(r => {
                const isDeletedStr = r.deleted ? "TRUE" : "FALSE";
                const rowIndex = cloudIds.indexOf(r.id) + 1; 
                if (rowIndex > 0) {
                    updateBatch.push({ range: `打卡主檔!A${rowIndex}:I${rowIndex}`, values: [[r.id, r.check_in_time, r.location_time, r.latitude, r.longitude, r.accuracy, r.tp_coord, r.notes, isDeletedStr]] });
                } else {
                    if (!r.deleted) {
                        appendMain.push([r.id, r.check_in_time, r.location_time, r.latitude, r.longitude, r.accuracy, r.tp_coord, r.notes, isDeletedStr]);
                        if (r.media_links) r.media_links.forEach(link => appendPhoto.push([r.id, link]));
                    }
                }
            });

            if (updateBatch.length > 0) {
                await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${currentProject.id}/values:batchUpdate`, {
                    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updateBatch })
                });
            }
            if (appendMain.length > 0) {
                await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${currentProject.id}/values/打卡主檔!A1:append?valueInputOption=USER_ENTERED`, {
                    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ values: appendMain })
                });
            }
            if (appendPhoto.length > 0) {
                await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${currentProject.id}/values/照片交易檔!A1:append?valueInputOption=USER_ENTERED`, {
                    method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ values: appendPhoto })
                });
            }

            records.forEach(r => { if (r.sync_status === 'LOCAL_ONLY') r.sync_status = 'SYNCED'; });
            records = records.filter(r => !r.deleted); 
            evaluateSession(); 
            logMsg('🟢 同步完成！');
        } catch (e) { logMsg('🔴 推播失敗'); console.error(e); }
    });
}

function pullFromCloud() {
    if (!currentProject) return alert('請先綁定專案！');
    if (records.some(r => r.sync_status === 'LOCAL_ONLY') && !confirm('⚠️ 有未備份記錄，覆寫將永久遺失本地變更！確定嗎？')) return;
    
    logMsg('⏳ 載入並過濾已刪除資料...');
    withAuth(async (token) => {
        try {
            // 順便更新本地註冊表的專案名稱 (如果從手動綁定進來的)
            const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${currentProject.id}`, { headers:{'Authorization':`Bearer ${token}`} });
            const meta = await metaRes.json();
            if (meta.properties && meta.properties.title) {
                currentProject.name = meta.properties.title;
                saveToProjectHistory(currentProject.id, currentProject.name, new Date().toISOString());
                localStorage.setItem('current_project', JSON.stringify(currentProject));
            }

            const [mainRes, photoRes] = await Promise.all([
                fetch(`https://sheets.googleapis.com/v4/spreadsheets/${currentProject.id}/values/打卡主檔!A:I`, { headers:{'Authorization':`Bearer ${token}`} }),
                fetch(`https://sheets.googleapis.com/v4/spreadsheets/${currentProject.id}/values/照片交易檔!A:B`, { headers:{'Authorization':`Bearer ${token}`} })
            ]);
            const mainData = await mainRes.json();
            const photoData = await photoRes.json();
            
            const photoMap = {};
            if (photoData.values && photoData.values.length > 1) {
                for (let i=1; i<photoData.values.length; i++){ const [id,url] = photoData.values[i]; if(!photoMap[id]) photoMap[id]=[]; photoMap[id].push(url); }
            }
            
            const newRecords = [];
            if (mainData.values && mainData.values.length > 1) {
                for (let i=1; i<mainData.values.length; i++){
                    const row = mainData.values[i];
                    if (row[8] !== 'TRUE') {
                        newRecords.push({ 
                            id: row[0], check_in_time: row[1], location_time: row[2], 
                            latitude: parseFloat(row[3]), longitude: parseFloat(row[4]), accuracy: parseFloat(row[5]), 
                            tp_coord: row[6] || '', notes: row[7] || '', deleted: false,
                            media_links: photoMap[row[0]] || [], sync_status: 'SYNCED' 
                        });
                    }
                }
            }
            records = newRecords.reverse();
            evaluateSession(); 
            logMsg('🟢 載入完成！');
        } catch (e) { logMsg('🔴 載入失敗，權限不足或檔案已刪除'); console.error(e); }
    });
}

// ==========================================
// 4. 現場作業與刪除模型 
// ==========================================
function performCheckIn() {
    if (!navigator.geolocation) return alert('瀏覽器不支援定位');
    logMsg('⏳ 定位中...');
    
    const wasTrusted = (syncSession === 'TRUSTED'); 

    navigator.geolocation.getCurrentPosition(pos => {
        let tpString;
        try { tpString = window.wgs84ToTaipower(pos.coords.latitude, pos.coords.longitude); } 
        catch (e) { tpString = '座標超出定義範圍'; }
        
        records.unshift({
            id: crypto.randomUUID(), check_in_time: new Date().toISOString(), location_time: new Date().toISOString(),
            latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy,
            tp_coord: tpString, notes: '', deleted: false, media_links: [], sync_status: 'LOCAL_ONLY'
        });
        
        evaluateSession(); 
        logMsg('📍 打卡完成');
        if (wasTrusted) pushUnsyncedData(); 
    }, err => alert('定位失敗，請確認手機權限'), { enableHighAccuracy: true });
}

function startEdit(id) { editingId = id; evaluateSession(); }
function cancelEdit() { editingId = null; evaluateSession(); }
function saveEdit(id) {
    const record = records.find(r=>r.id===id);
    record.notes = document.getElementById(`edit-notes-${id}`).value;
    const linksText = document.getElementById(`edit-links-${id}`).value;
    record.media_links = linksText.split('\n').map(l=>l.trim()).filter(l=>l!=='');
    record.sync_status = 'LOCAL_ONLY';
    editingId = null;
    
    const wasTrusted = (syncSession === 'TRUSTED');
    evaluateSession();
    if (wasTrusted) pushUnsyncedData();
}

function deleteRecord(id) {
    if(!confirm('確定要刪除此紀錄嗎？')) return;
    const record = records.find(r=>r.id===id);
    record.deleted = true;
    record.sync_status = 'LOCAL_ONLY';
    
    const wasTrusted = (syncSession === 'TRUSTED');
    evaluateSession();
    if (wasTrusted) pushUnsyncedData();
}

function shareRecord(id) {
    const r = records.find(x => x.id === id);
    const mapsUrl = `http://googleusercontent.com/maps.google.com/9{r.latitude},${r.longitude}`;
    let text = `📍 iCheckInHere 現勘打卡\n⏱️ 時間: ${new Date(r.check_in_time).toLocaleString()}\n⚡ 台電: ${r.tp_coord}\n🗺️ 導航: ${mapsUrl}\n`;
    if (r.notes) text += `📝 備註: ${r.notes}\n`;
    if (navigator.share) { navigator.share({ title: '現勘座標', text: text }).catch(e=>console.log(e)); } 
    else { navigator.clipboard.writeText(text); alert('✅ 內容已複製，可貼上至 LINE！'); }
}

function renderUI() {
    const list = document.getElementById('checkInList');
    const visibleRecords = records.filter(r => !r.deleted);
    
    list.innerHTML = visibleRecords.map(r => {
        if (r.id === editingId) {
            return `<div class="card" style="border: 2px solid #3b82f6;">
                <textarea id="edit-notes-${r.id}" placeholder="備註 (可選)" rows="2">${r.notes || ''}</textarea>
                <textarea id="edit-links-${r.id}" placeholder="照片網址 (可多行)" rows="2">${(r.media_links || []).join('\n')}</textarea>
                <div style="display: flex; gap: 5px; margin-top:5px;">
                    <button onclick="saveEdit('${r.id}')" class="btn btn-primary" style="padding:8px; margin:0;">💾 儲存</button>
                    <button onclick="cancelEdit()" class="btn" style="padding:8px; margin:0; background:#e2e8f0; color:#333;">❌ 取消</button>
                </div>
            </div>`;
        }
        
        return `<div class="card">
            <p style="font-size: 0.8em; color: #666; margin: 0;">${new Date(r.check_in_time).toLocaleString()} 
                <span style="float:right;">${r.sync_status==='LOCAL_ONLY' ? '⚠️ 未備份' : '🟢 已上雲'}</span>
            </p>
            <p style="font-family: monospace; margin: 5px 0;">🧭 ${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}</p>
            <div style="margin: 5px 0;"><span class="tp-badge">⚡ ${r.tp_coord}</span></div>
            ${r.media_links && r.media_links.length > 0 ? `<p style="font-size: 0.8em; color: #0052cc;">📸 附件: ${r.media_links.length} 張圖</p>` : ''}
            ${r.notes ? `<p style="margin: 5px 0; font-weight:bold;">📝 ${r.notes}</p>` : ''}
            <div style="display: flex; gap: 5px; margin-top: 10px;">
                <button onclick="shareRecord('${r.id}')" style="flex: 1; border:1px solid #ccc; background:#fff; padding:6px; border-radius:4px;">📤 分享</button>
                <button onclick="startEdit('${r.id}')" style="flex: 1; border:1px solid #ccc; background:#fff; padding:6px; border-radius:4px;">✏️ 編輯</button>
                <button onclick="deleteRecord('${r.id}')" style="flex: 1; background: #fee2e2; color: #dc2626; border:none; padding:6px; border-radius:4px;">🗑️ 刪除</button>
            </div>
        </div>`;
    }).join('');
}
