// ==UserScript==
// @name         Suno AutoFill（プリセット自動入力）
// @namespace    https://github.com/sasakama99/suno-auto-selector
// @version      1.3.0
// @description  Sunoの作曲フォームにプリセットを保存・自動入力するツール
// @author       ハリたっく
// @match        https://suno.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/sasakama99/suno-auto-selector/main/suno-autofill.user.js
// @downloadURL  https://raw.githubusercontent.com/sasakama99/suno-auto-selector/main/suno-autofill.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ===================================================
  //  ストレージ
  // ===================================================
  const STORAGE_KEY = 'sunoAutofill_v1';

  function loadSettings() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return defaultSettings();
  }

  function saveSettings() {
    GM_setValue(STORAGE_KEY, JSON.stringify(settings));
  }

  function defaultSettings() {
    return {
      autoFill: false,
      defaultPreset: '基礎設定',
      presets: { '基礎設定': emptyPreset() }
    };
  }

  function emptyPreset() {
    return {
      lyrics: '', styles: '', excludeStyles: '',
      vocalGender: '', lyricsMode: 'manual',
      weirdness: 50, styleInfluence: 50,
      songTitle: '', version: 'v5'
    };
  }

  let settings = loadSettings();
  let currentPreset = settings.defaultPreset;
  let panelVisible = true;

  // ===================================================
  //  トグルグループ管理（シンプルなJS変数で管理）
  // ===================================================
  const toggleState = {};  // { 'vg': 'male', 'lm': 'manual', 'ver': 'v5' }

  function setToggle(group, val) {
    toggleState[group] = val;
    document.querySelectorAll(`[data-group="${group}"]`).forEach(btn => {
      const active = btn.dataset.val === val;
      applyToggleStyle(btn, active);
    });
  }

  function getToggle(group) {
    return toggleState[group] !== undefined ? toggleState[group] : '';
  }

  function applyToggleStyle(btn, active) {
    if (active) {
      btn.style.background = '#f0a020';
      btn.style.color = '#000';
      btn.style.borderColor = '#f0a020';
      btn.style.fontWeight = '700';
      btn.style.opacity = '1';
    } else {
      btn.style.background = '#1a1a1a';
      btn.style.color = '#aaa';
      btn.style.borderColor = '#2a2a2a';
      btn.style.fontWeight = '400';
      btn.style.opacity = '1';
    }
  }

  // ===================================================
  //  React input/textarea に値をセット
  // ===================================================
  function setReactValue(el, value) {
    if (!el) return false;
    try {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }

  // ===================================================
  //  Sunoの要素を探す（ℹアイコン等の余分なテキストを無視）
  // ===================================================

  // テキストを正規化（アイコン文字・空白を除去して小文字に）
  function normalizeText(t) {
    return (t || '')
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')  // 絵文字除去
      .replace(/[^\w\s.+\-]/g, '')              // 記号除去（英数字・空白・.+-は残す）
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // ラベルが「含まれている」要素の中から targetText のボタンを探す
  function findButtonNearLabel(labelText, btnText) {
    const labelNorm = normalizeText(labelText);
    const btnNorm   = normalizeText(btnText);

    // ラベル要素を探す
    let labelEl = null;
    for (const el of document.querySelectorAll('*')) {
      const norm = normalizeText(el.textContent);
      // テキストがラベルで始まり、かつ短い（子要素が少ない）要素
      if (norm.startsWith(labelNorm) && norm.length < labelNorm.length + 20 && el.children.length <= 3) {
        labelEl = el;
        break;
      }
    }

    if (labelEl) {
      let container = labelEl.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!container) break;
        for (const el of container.querySelectorAll('button, [role="button"], span, div')) {
          if (normalizeText(el.textContent) === btnNorm) {
            // clickableかチェック（widthが0でない）
            const r = el.getBoundingClientRect();
            if (r.width > 0) return el;
          }
        }
        container = container.parentElement;
      }
    }

    // フォールバック: ページ全体から
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (normalizeText(el.textContent) === btnNorm) return el;
    }
    return null;
  }

  // textarea / input 系
  function getLyricsEl() {
    for (const ta of document.querySelectorAll('textarea')) {
      const ph = normalizeText(ta.placeholder);
      if (ph.includes('lyrics') || ph.includes('instrumental')) return ta;
    }
    return null;
  }

  function getStylesEl() {
    for (const ta of document.querySelectorAll('textarea')) {
      const ph = normalizeText(ta.placeholder);
      if (ph.includes('style') || ph.includes('genre') || ph.includes('mood')) return ta;
    }
    const tas = document.querySelectorAll('textarea');
    return tas.length >= 2 ? tas[1] : null;
  }

  function getExcludeEl() {
    for (const inp of document.querySelectorAll('input')) {
      if (normalizeText(inp.placeholder).includes('exclude')) return inp;
    }
    return null;
  }

  function getSongTitleEl() {
    for (const inp of document.querySelectorAll('input')) {
      const ph = normalizeText(inp.placeholder);
      if (ph.includes('song title') || ph.includes('title')) return inp;
    }
    return null;
  }

  // ===================================================
  //  スライダー操作（Reactファイバー → ポインターイベント）
  // ===================================================

  function getReactFiber(el) {
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactFiber') || k.startsWith('__reactInternals') || k.startsWith('__reactEventHandlers')
    );
    return key ? el[key] : null;
  }

  function callReactHandler(el, value) {
    let fiber = getReactFiber(el);
    while (fiber) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props) {
        if (typeof props.onChangeCommitted === 'function') { props.onChangeCommitted(null, value); return true; }
        if (typeof props.onChange === 'function') {
          props.onChange({ target: { value: String(value) }, currentTarget: { value: String(value) } });
          return true;
        }
        if (typeof props.onValueChange === 'function') { props.onValueChange(value); return true; }
      }
      fiber = fiber.return;
    }
    return false;
  }

  function simulateSliderPointer(el, percent) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return false;
      const x = rect.left + rect.width * (percent / 100);
      const y = rect.top + rect.height / 2;
      ['pointerdown', 'pointermove', 'pointerup'].forEach(type =>
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1 }))
      );
      ['mousedown', 'mousemove', 'mouseup'].forEach(type =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }))
      );
      return true;
    } catch (e) { return false; }
  }

  function setCustomSlider(labelText, percent) {
    const labelNorm = normalizeText(labelText);

    // input[type="range"] を探す（Reactファイバー経由）
    for (const inp of document.querySelectorAll('input[type="range"]')) {
      // 祖先6段階以内にラベルが含まれるか
      let p = inp.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!p) break;
        if (normalizeText(p.textContent).includes(labelNorm)) {
          const min = parseFloat(inp.min || 0);
          const max = parseFloat(inp.max || 100);
          const val = min + (max - min) * (percent / 100);
          if (!callReactHandler(inp, val)) setReactValue(inp, String(val));
          log(`スライダー ${labelText} → ${percent}%`);
          return true;
        }
        p = p.parentElement;
      }
    }

    // role="slider" を探す
    for (const el of document.querySelectorAll('[role="slider"]')) {
      let p = el.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!p) break;
        if (normalizeText(p.textContent).includes(labelNorm)) {
          if (!callReactHandler(el, percent)) simulateSliderPointer(el, percent);
          return true;
        }
        p = p.parentElement;
      }
    }

    // ラベル要素からコンテナを辿ってポインターイベント
    for (const el of document.querySelectorAll('*')) {
      const norm = normalizeText(el.textContent);
      if (!norm.startsWith(labelNorm) || norm.length > labelNorm.length + 30) continue;
      let container = el.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!container) break;
        const s = container.querySelector('[role="slider"], input[type="range"]');
        if (s) { simulateSliderPointer(s, percent); return true; }
        // 横長でインタラクティブな子要素
        for (const child of container.querySelectorAll('div, span')) {
          const r = child.getBoundingClientRect();
          if (r.width > 100 && r.height > 0 && r.height < 40) {
            simulateSliderPointer(child, percent);
            return true;
          }
        }
        container = container.parentElement;
      }
    }

    log(`スライダー未検出: ${labelText}`);
    return false;
  }

  // ===================================================
  //  バージョン選択
  // ===================================================
  function setVersion(ver) {
    if (!ver) return false;
    const vl = normalizeText(ver);

    function findAndClickItem() {
      const selectors = '[role="option"], [role="menuitem"], [role="listitem"], li, [class*="option"], [class*="item"]';
      for (const item of document.querySelectorAll(selectors)) {
        const t = normalizeText(item.textContent);
        if (t.startsWith(vl)) { item.click(); log(`Version: ${ver}`); return true; }
      }
      return false;
    }

    if (findAndClickItem()) return true;

    // ドロップダウントリガーを開く
    for (const btn of document.querySelectorAll('button, [role="button"], [role="combobox"]')) {
      const t = normalizeText(btn.textContent);
      if (/^v[\d.+-]/.test(t) || t.includes('model') || t.includes('version')) {
        btn.click();
        setTimeout(() => { if (!findAndClickItem()) setTimeout(findAndClickItem, 300); }, 200);
        return true;
      }
    }
    return false;
  }

  function log(msg) { console.log(`[SunoAutoFill] ${msg}`); }

  // ===================================================
  //  トースト
  // ===================================================
  function showToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:20px;
    border:1px solid #555;font-size:13px;z-index:9999999;
    box-shadow:0 4px 12px rgba(0,0,0,.6);pointer-events:none;
    font-family:-apple-system,"Hiragino Sans",sans-serif;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  // ===================================================
  //  プリセット適用
  // ===================================================
  function applyPreset(name) {
    const p = settings.presets[name];
    if (!p) return;

    // テキスト系
    const lyricsEl = getLyricsEl();
    if (lyricsEl) setReactValue(lyricsEl, p.lyrics || '');

    const stylesEl = getStylesEl();
    if (stylesEl) setReactValue(stylesEl, p.styles || '');

    const excludeEl = getExcludeEl();
    if (excludeEl) setReactValue(excludeEl, p.excludeStyles || '');

    const titleEl = getSongTitleEl();
    if (titleEl) setReactValue(titleEl, p.songTitle || '');

    // Vocal Gender
    if (p.vocalGender === 'male') {
      const btn = findButtonNearLabel('Vocal Gender', 'Male');
      if (btn) btn.click(); else log('Male ボタン未検出');
    } else if (p.vocalGender === 'female') {
      const btn = findButtonNearLabel('Vocal Gender', 'Female');
      if (btn) btn.click(); else log('Female ボタン未検出');
    }

    // Lyrics Mode
    if (p.lyricsMode === 'manual') {
      const btn = findButtonNearLabel('Lyrics Mode', 'Manual');
      if (btn) btn.click();
    } else if (p.lyricsMode === 'auto') {
      const btn = findButtonNearLabel('Lyrics Mode', 'Auto');
      if (btn) btn.click();
    }

    // スライダー（少し遅延）
    setTimeout(() => {
      if (p.weirdness !== undefined) setCustomSlider('Weirdness', p.weirdness);
      if (p.styleInfluence !== undefined) setCustomSlider('Style Influence', p.styleInfluence);
    }, 300);

    // バージョン
    if (p.version) setTimeout(() => setVersion(p.version), 500);

    showToast(`✅ 適用: ${name}`);
  }

  // ===================================================
  //  パネルUI
  // ===================================================
  function buildPanel() {
    if (document.getElementById('suno-af-panel')) return;

    const style = document.createElement('style');
    style.textContent = `
      #suno-af-panel textarea:focus, #suno-af-panel input[type="text"]:focus { border-color:#f0a020!important; }
      #suno-af-panel select { cursor:pointer; }
      #suno-af-body::-webkit-scrollbar { width:4px; }
      #suno-af-body::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'suno-af-panel';
    panel.style.cssText = `position:fixed;top:60px;right:20px;z-index:9999998;width:310px;
    background:rgba(13,13,13,.98);border:1px solid #2a2a2a;border-radius:14px;
    box-shadow:0 8px 32px rgba(0,0,0,.8);font-family:-apple-system,"Hiragino Sans",sans-serif;
    color:#e0e0e0;font-size:13px;overflow:hidden;`;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:11px 14px 9px;background:#111;border-bottom:1px solid #222;">
        <span style="font-weight:700;font-size:14px;color:#f0a020;">🎵 Suno AutoFill</span>
        <button id="af-toggle-panel" style="background:none;border:1px solid #333;color:#777;
          border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:11px;">▼</button>
      </div>

      <div id="suno-af-body" style="padding:12px 14px;max-height:82vh;overflow-y:auto;">

        <!-- プリセット -->
        <div style="margin-bottom:12px;">
          <div style="font-size:11px;color:#555;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">プリセット</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <select id="af-sel" style="flex:1;background:#111;color:#e0e0e0;border:1px solid #2a2a2a;
              border-radius:7px;padding:6px 8px;font-size:13px;outline:none;"></select>
            <button id="af-new" title="新規" style="${sBtn('#1a2a1a','#3a6a3a')}">＋</button>
            <button id="af-del" title="削除" style="${sBtn('#2a1a1a','#6a2a2a')}">🗑</button>
          </div>
        </div>

        ${fld('Lyrics（歌詞）')}
        <textarea id="af-lyrics" rows="3" placeholder="歌詞（空欄=インストゥルメンタル）" style="${taS()}"></textarea>

        ${fld('Styles（スタイル）')}
        <textarea id="af-styles" rows="2" placeholder="クリーンギター, ダブルキック, ..." style="${taS()}"></textarea>

        ${fld('Exclude Styles（除外）')}
        <input id="af-exclude" type="text" placeholder="除外するスタイル" style="${inS()}">

        ${fld('Vocal Gender')}
        <div style="display:flex;gap:5px;flex-wrap:wrap;" id="af-vg-group">
          ${tBtn('vg','','指定なし')}${tBtn('vg','male','Male')}${tBtn('vg','female','Female')}
        </div>

        ${fld('Lyrics Mode')}
        <div style="display:flex;gap:5px;" id="af-lm-group">
          ${tBtn('lm','manual','Manual')}${tBtn('lm','auto','Auto')}
        </div>

        ${fld('Weirdness')}
        <div style="display:flex;align-items:center;gap:8px;">
          <input id="af-weirdness" type="range" min="0" max="100" value="50" style="flex:1;accent-color:#f0a020;">
          <span id="af-weirdness-v" style="width:34px;text-align:right;color:#f0a020;font-weight:700;">50%</span>
        </div>

        ${fld('Style Influence')}
        <div style="display:flex;align-items:center;gap:8px;">
          <input id="af-influence" type="range" min="0" max="100" value="50" style="flex:1;accent-color:#f0a020;">
          <span id="af-influence-v" style="width:34px;text-align:right;color:#f0a020;font-weight:700;">50%</span>
        </div>

        ${fld('Song Title')}
        <input id="af-title" type="text" placeholder="曲タイトル（任意）" style="${inS()}">

        ${fld('Version')}
        <div style="display:flex;gap:4px;flex-wrap:wrap;" id="af-ver-group">
          ${tBtn('ver','','指定なし')}
          ${['v5.5','v5','v4.5+','v4.5','v4.5-all','v4','v3.5','v3','v2'].map(v=>tBtn('ver',v,v)).join('')}
        </div>

        <!-- ボタン -->
        <div style="display:flex;gap:6px;margin-top:14px;">
          <button id="af-save" style="flex:1;padding:9px;background:#1a3a1a;color:#6eff6e;
            border:1px solid #2a6a2a;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">
            💾 保存
          </button>
          <button id="af-apply" style="flex:1;padding:9px;background:#f0a020;color:#000;
            border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">
            ▶ 適用
          </button>
        </div>

        <!-- 設定 -->
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#777;">
            <input id="af-auto-chk" type="checkbox" style="accent-color:#f0a020;">
            起動時に自動入力
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#777;">
            <input id="af-def-chk" type="checkbox" style="accent-color:#f0a020;">
            このプリセットをデフォルトにする
          </label>
          <div id="af-def-lbl" style="font-size:11px;color:#444;padding-left:20px;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // ===== イベント =====

    document.getElementById('af-toggle-panel').onclick = () => {
      const body = document.getElementById('suno-af-body');
      panelVisible = !panelVisible;
      body.style.display = panelVisible ? 'block' : 'none';
      document.getElementById('af-toggle-panel').textContent = panelVisible ? '▼' : '▲';
    };

    document.getElementById('af-sel').onchange = (e) => {
      currentPreset = e.target.value;
      loadForm(currentPreset);
      syncDefaultUI();
    };

    document.getElementById('af-new').onclick = () => {
      const name = prompt('新しいプリセット名:');
      if (!name?.trim()) return;
      const n = name.trim();
      if (settings.presets[n]) return showToast('⚠️ 同名のプリセットが存在します');
      settings.presets[n] = emptyPreset();
      currentPreset = n;
      saveSettings();
      rebuildSel();
      loadForm(n);
    };

    document.getElementById('af-del').onclick = () => {
      if (Object.keys(settings.presets).length <= 1) return showToast('⚠️ 最後のプリセットは削除できません');
      if (!confirm(`「${currentPreset}」を削除しますか？`)) return;
      delete settings.presets[currentPreset];
      if (settings.defaultPreset === currentPreset)
        settings.defaultPreset = Object.keys(settings.presets)[0];
      currentPreset = Object.keys(settings.presets)[0];
      saveSettings(); rebuildSel(); loadForm(currentPreset);
      showToast('🗑 削除しました');
    };

    // スライダー値表示
    document.getElementById('af-weirdness').oninput = (e) => {
      document.getElementById('af-weirdness-v').textContent = e.target.value + '%';
    };
    document.getElementById('af-influence').oninput = (e) => {
      document.getElementById('af-influence-v').textContent = e.target.value + '%';
    };

    // トグルボタン
    panel.querySelectorAll('[data-group]').forEach(btn => {
      btn.onclick = () => setToggle(btn.dataset.group, btn.dataset.val);
    });

    document.getElementById('af-save').onclick = () => {
      collectForm(currentPreset);
      settings.autoFill = document.getElementById('af-auto-chk').checked;
      if (document.getElementById('af-def-chk').checked)
        settings.defaultPreset = currentPreset;
      saveSettings();
      showToast(`💾 「${currentPreset}」を保存しました`);
      syncDefaultUI();
    };

    document.getElementById('af-apply').onclick = () => {
      collectForm(currentPreset);
      applyPreset(currentPreset);
    };

    document.getElementById('af-auto-chk').onchange = (e) => {
      settings.autoFill = e.target.checked;
      saveSettings();
    };
    document.getElementById('af-def-chk').onchange = (e) => {
      if (e.target.checked) { settings.defaultPreset = currentPreset; saveSettings(); syncDefaultUI(); }
    };

    rebuildSel();
    loadForm(currentPreset);
    document.getElementById('af-auto-chk').checked = settings.autoFill;
    syncDefaultUI();
  }

  // ===================================================
  //  HTML生成ヘルパー
  // ===================================================
  function fld(label) {
    return `<div style="font-size:11px;color:#555;margin:10px 0 4px;
      text-transform:uppercase;letter-spacing:.04em;">${label}</div>`;
  }
  function taS() {
    return `width:100%;box-sizing:border-box;background:#0d0d0d;color:#e0e0e0;
    border:1px solid #2a2a2a;border-radius:7px;padding:7px 9px;
    font-size:12px;resize:vertical;font-family:inherit;outline:none;`;
  }
  function inS() {
    return `width:100%;box-sizing:border-box;background:#0d0d0d;color:#e0e0e0;
    border:1px solid #2a2a2a;border-radius:7px;padding:7px 9px;
    font-size:12px;font-family:inherit;outline:none;`;
  }
  function sBtn(bg, border) {
    return `background:${bg};color:#bbb;border:1px solid ${border};
    border-radius:7px;width:28px;height:28px;cursor:pointer;font-size:13px;`;
  }
  // トグルボタンHTML（data-group, data-val を持つ）
  function tBtn(group, val, label) {
    return `<button data-group="${group}" data-val="${val}"
      style="background:#1a1a1a;color:#aaa;border:1px solid #2a2a2a;
      border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;margin-bottom:3px;">
      ${label}</button>`;
  }

  // ===================================================
  //  フォーム ↔ プリセット
  // ===================================================
  function loadForm(name) {
    const p = settings.presets[name] || emptyPreset();
    document.getElementById('af-lyrics').value  = p.lyrics        || '';
    document.getElementById('af-styles').value  = p.styles        || '';
    document.getElementById('af-exclude').value = p.excludeStyles || '';
    document.getElementById('af-title').value   = p.songTitle     || '';

    const w = p.weirdness !== undefined ? p.weirdness : 50;
    document.getElementById('af-weirdness').value = w;
    document.getElementById('af-weirdness-v').textContent = w + '%';

    const inf = p.styleInfluence !== undefined ? p.styleInfluence : 50;
    document.getElementById('af-influence').value = inf;
    document.getElementById('af-influence-v').textContent = inf + '%';

    setToggle('vg',  p.vocalGender || '');
    setToggle('lm',  p.lyricsMode  || 'manual');
    setToggle('ver', p.version     || '');
  }

  function collectForm(name) {
    if (!settings.presets[name]) settings.presets[name] = emptyPreset();
    const p = settings.presets[name];
    p.lyrics        = document.getElementById('af-lyrics').value;
    p.styles        = document.getElementById('af-styles').value;
    p.excludeStyles = document.getElementById('af-exclude').value;
    p.songTitle     = document.getElementById('af-title').value;
    p.weirdness     = parseInt(document.getElementById('af-weirdness').value);
    p.styleInfluence = parseInt(document.getElementById('af-influence').value);
    p.vocalGender   = getToggle('vg');
    p.lyricsMode    = getToggle('lm') || 'manual';
    p.version       = getToggle('ver');
  }

  function rebuildSel() {
    const sel = document.getElementById('af-sel');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(settings.presets).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + (name === settings.defaultPreset ? ' ⭐' : '');
      if (name === currentPreset) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function syncDefaultUI() {
    const chk = document.getElementById('af-def-chk');
    const lbl = document.getElementById('af-def-lbl');
    if (chk) chk.checked = currentPreset === settings.defaultPreset;
    if (lbl) lbl.textContent = `デフォルト: ${settings.defaultPreset}`;
    rebuildSel();
  }

  // ===================================================
  //  ページ監視・初期化
  // ===================================================
  let initDone = false, autoApplied = false, lastUrl = location.href;

  function tryInit() {
    if (initDone) return;
    if (!document.querySelector('textarea') && !location.pathname.includes('/create')) return;
    buildPanel();
    initDone = true;
    if (settings.autoFill && !autoApplied && settings.defaultPreset) {
      autoApplied = true;
      setTimeout(() => applyPreset(settings.defaultPreset), 1800);
    }
  }

  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      initDone = false; autoApplied = false;
      const ex = document.getElementById('suno-af-panel');
      if (ex) ex.remove();
      setTimeout(tryInit, 1200);
    }
    if (!initDone) tryInit();
  }).observe(document.documentElement, { childList: true, subtree: true });

  setTimeout(tryInit, 1000);
  setTimeout(tryInit, 3000);

})();
