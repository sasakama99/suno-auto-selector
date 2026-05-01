// ==UserScript==
// @name         Suno AutoFill（プリセット自動入力）
// @namespace    https://github.com/sasakama99/suno-auto-selector
// @version      1.0.0
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
      presets: {
        '基礎設定': emptyPreset()
      }
    };
  }

  function emptyPreset() {
    return {
      lyrics: '',
      styles: '',
      excludeStyles: '',
      vocalGender: '',       // 'male' | 'female' | ''
      lyricsMode: 'manual',  // 'manual' | 'auto'
      weirdness: 50,
      styleInfluence: 50,
      songTitle: '',
      version: 'v5'
    };
  }

  let settings = loadSettings();
  let currentPreset = settings.defaultPreset;
  let panelVisible = true;

  // ===================================================
  //  Sunoの要素を見つけるヘルパー
  // ===================================================

  // React管理のinput/textareaに値をセット（Reactのstateも更新）
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

  // テキストで要素を探す
  function findByLabel(labelText) {
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length === 0 && el.textContent.trim() === labelText) {
        return el;
      }
    }
    return null;
  }

  // Lyrics textarea
  function getLyricsEl() {
    for (const ta of document.querySelectorAll('textarea')) {
      const ph = (ta.placeholder || '').toLowerCase();
      if (ph.includes('lyrics') || ph.includes('instrumental')) return ta;
    }
    return null;
  }

  // Styles textarea
  function getStylesEl() {
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      const ph = (ta.placeholder || '').toLowerCase();
      if (ph.includes('style') || ph.includes('genre') || ph.includes('mood')) return ta;
    }
    // Lyricsの次のtextarea
    if (textareas.length >= 2) return textareas[1];
    return null;
  }

  // Exclude styles input
  function getExcludeEl() {
    for (const inp of document.querySelectorAll('input')) {
      const ph = (inp.placeholder || '').toLowerCase();
      if (ph.includes('exclude')) return inp;
    }
    return null;
  }

  // Song Title input
  function getSongTitleEl() {
    for (const inp of document.querySelectorAll('input')) {
      const ph = (inp.placeholder || '').toLowerCase();
      if (ph.includes('song title') || ph.includes('title')) return inp;
    }
    return null;
  }

  // ボタンをクリック（Vocal Gender / Lyrics Mode）
  function clickButton(labelText) {
    const buttons = document.querySelectorAll('button, [role="button"], [role="tab"]');
    for (const btn of buttons) {
      if (btn.textContent.trim() === labelText) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  // スライダーを%で操作（Weirdness / Style Influence）
  // Sunoのスライダーはカスタム実装のためポインターイベントで操作
  function setSlider(labelText, percent) {
    // "Weirdness" や "Style Influence" のラベルを含む親要素を探す
    const allDivs = document.querySelectorAll('div, section');
    let sliderContainer = null;

    for (const div of allDivs) {
      if (div.children.length > 0 && div.textContent.includes(labelText)) {
        // 子要素にスライダーっぽいものがあるか確認
        const hasSliderChild = div.querySelector('[role="slider"], [class*="slider"], [class*="Slider"], input[type="range"]');
        if (hasSliderChild) {
          sliderContainer = div;
          break;
        }
      }
    }

    // input[type="range"] が見つかれば直接セット
    if (sliderContainer) {
      const rangeInput = sliderContainer.querySelector('input[type="range"]');
      if (rangeInput) {
        const min = parseFloat(rangeInput.min || 0);
        const max = parseFloat(rangeInput.max || 100);
        const value = min + (max - min) * (percent / 100);
        setReactValue(rangeInput, String(value));
        return true;
      }

      // role="slider" があればaria属性で操作
      const roleSlider = sliderContainer.querySelector('[role="slider"]');
      if (roleSlider) {
        roleSlider.setAttribute('aria-valuenow', percent);
        roleSlider.dispatchEvent(new Event('change', { bubbles: true }));
        // ポインターイベントでも操作
        simulateSliderClick(roleSlider, percent);
        return true;
      }

      // フォールバック: スライダーらしき要素をポインターイベントで操作
      simulateSliderClick(sliderContainer, percent);
      return true;
    }

    // ラベルなしで全rangeを試す
    const ranges = document.querySelectorAll('input[type="range"]');
    if (ranges.length >= 2 && labelText.includes('Influence')) {
      setReactValue(ranges[1], String(percent));
      return true;
    } else if (ranges.length >= 1) {
      setReactValue(ranges[0], String(percent));
      return true;
    }

    return false;
  }

  function simulateSliderClick(el, percent) {
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width * (percent / 100);
      const y = rect.top + rect.height / 2;
      const events = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup'];
      events.forEach(type => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true, clientX: x, clientY: y
        }));
      });
    } catch (e) {}
  }

  // バージョン選択（v4/v5等）
  function setVersion(ver) {
    if (!ver) return;
    // v4/v5ボタンを探す
    const btns = document.querySelectorAll('button, [role="option"]');
    for (const btn of btns) {
      if (btn.textContent.trim().toLowerCase() === ver.toLowerCase()) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  // ===================================================
  //  プリセットを適用
  // ===================================================
  function applyPreset(presetName) {
    const preset = settings.presets[presetName];
    if (!preset) return;

    let applied = [];

    // Lyrics
    if (preset.lyrics !== undefined) {
      const el = getLyricsEl();
      if (el) { setReactValue(el, preset.lyrics); applied.push('Lyrics'); }
    }

    // Styles
    if (preset.styles !== undefined) {
      const el = getStylesEl();
      if (el) { setReactValue(el, preset.styles); applied.push('Styles'); }
    }

    // Exclude Styles
    if (preset.excludeStyles !== undefined) {
      const el = getExcludeEl();
      if (el) { setReactValue(el, preset.excludeStyles); applied.push('Exclude'); }
    }

    // Vocal Gender
    if (preset.vocalGender === 'male') {
      clickButton('Male');
      applied.push('Vocal:Male');
    } else if (preset.vocalGender === 'female') {
      clickButton('Female');
      applied.push('Vocal:Female');
    }

    // Lyrics Mode
    if (preset.lyricsMode === 'manual') {
      clickButton('Manual');
      applied.push('Mode:Manual');
    } else if (preset.lyricsMode === 'auto') {
      clickButton('Auto');
      applied.push('Mode:Auto');
    }

    // Weirdness
    if (preset.weirdness !== undefined) {
      setSlider('Weirdness', preset.weirdness);
      applied.push('Weirdness');
    }

    // Style Influence
    if (preset.styleInfluence !== undefined) {
      setSlider('Style Influence', preset.styleInfluence);
      applied.push('StyleInfluence');
    }

    // Song Title
    if (preset.songTitle !== undefined) {
      const el = getSongTitleEl();
      if (el) { setReactValue(el, preset.songTitle); applied.push('Title'); }
    }

    // Version
    if (preset.version) {
      setVersion(preset.version);
      applied.push('Version');
    }

    showToast(`✅ 適用: ${presetName}`);
    return applied;
  }

  // ===================================================
  //  トースト通知
  // ===================================================
  function showToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      background:#1a1a1a; color:#fff; padding:10px 20px; border-radius:20px;
      border:1px solid #444; font-size:13px; z-index:9999999;
      box-shadow:0 4px 12px rgba(0,0,0,.5); pointer-events:none;
      font-family:-apple-system,"Hiragino Sans",sans-serif;
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  // ===================================================
  //  パネルUI
  // ===================================================
  let panelEl = null;

  function buildPanel() {
    if (document.getElementById('suno-af-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'suno-af-panel';
    panel.style.cssText = `
      position:fixed; top:60px; right:20px; z-index:9999998;
      width:300px; background:rgba(15,15,15,.97);
      border:1px solid #333; border-radius:14px;
      box-shadow:0 6px 24px rgba(0,0,0,.7);
      font-family:-apple-system,"Hiragino Sans",sans-serif;
      color:#e8e8e8; font-size:13px; overflow:hidden;
    `;

    panel.innerHTML = `
      <div id="suno-af-header" style="
        display:flex; align-items:center; justify-content:space-between;
        padding:12px 14px 10px; background:#1a1a1a; cursor:default;
        border-bottom:1px solid #2a2a2a;
      ">
        <span style="font-weight:700; font-size:14px; color:#f0a020;">🎵 Suno AutoFill</span>
        <button id="suno-af-toggle" style="
          background:none; border:1px solid #444; color:#aaa;
          border-radius:6px; width:26px; height:26px; cursor:pointer; font-size:12px;
        ">▼</button>
      </div>

      <div id="suno-af-body" style="padding:12px 14px;">

        <!-- プリセット選択 -->
        <div style="margin-bottom:10px;">
          <div style="font-size:11px; color:#888; margin-bottom:4px; text-transform:uppercase; letter-spacing:.05em;">プリセット</div>
          <div style="display:flex; gap:6px; align-items:center;">
            <select id="suno-af-preset-sel" style="
              flex:1; background:#1a1a1a; color:#e8e8e8;
              border:1px solid #444; border-radius:7px; padding:6px 8px;
              font-size:13px; outline:none; cursor:pointer;
            "></select>
            <button id="suno-af-new-btn" title="新規プリセット" style="${btnStyle('#2a2a2a')}">＋</button>
            <button id="suno-af-del-btn" title="削除" style="${btnStyle('#2a1515')}">🗑</button>
          </div>
        </div>

        <!-- フォーム -->
        <div id="suno-af-form">

          ${fieldBlock('Lyrics（歌詞）', `
            <textarea id="af-lyrics" rows="3" placeholder="歌詞を入力（空欄=インストゥルメンタル）" style="${textareaStyle()}"></textarea>
          `)}

          ${fieldBlock('Styles（スタイル）', `
            <textarea id="af-styles" rows="2" placeholder="クリーンギター, ダブルキック, ..." style="${textareaStyle()}"></textarea>
          `)}

          ${fieldBlock('Exclude Styles（除外）', `
            <input id="af-exclude" type="text" placeholder="除外するスタイル" style="${inputStyle()}">
          `)}

          ${fieldBlock('Vocal Gender', `
            <div style="display:flex; gap:6px;">
              <button id="af-vg-none"   style="${toggleBtn(false)}">指定なし</button>
              <button id="af-vg-male"   style="${toggleBtn(false)}">Male</button>
              <button id="af-vg-female" style="${toggleBtn(false)}">Female</button>
            </div>
          `)}

          ${fieldBlock('Lyrics Mode', `
            <div style="display:flex; gap:6px;">
              <button id="af-lm-manual" style="${toggleBtn(false)}">Manual</button>
              <button id="af-lm-auto"   style="${toggleBtn(false)}">Auto</button>
            </div>
          `)}

          ${fieldBlock('Weirdness', `
            <div style="display:flex; align-items:center; gap:8px;">
              <input id="af-weirdness" type="range" min="0" max="100" value="50" style="flex:1; accent-color:#f0a020;">
              <span id="af-weirdness-val" style="width:32px; text-align:right; color:#f0a020; font-weight:600;">50%</span>
            </div>
          `)}

          ${fieldBlock('Style Influence', `
            <div style="display:flex; align-items:center; gap:8px;">
              <input id="af-influence" type="range" min="0" max="100" value="50" style="flex:1; accent-color:#f0a020;">
              <span id="af-influence-val" style="width:32px; text-align:right; color:#f0a020; font-weight:600;">50%</span>
            </div>
          `)}

          ${fieldBlock('Song Title', `
            <input id="af-title" type="text" placeholder="曲タイトル（任意）" style="${inputStyle()}">
          `)}

          ${fieldBlock('Version', `
            <div style="display:flex; gap:6px;">
              <button id="af-ver-none" style="${toggleBtn(false)}">指定なし</button>
              <button id="af-ver-v4"   style="${toggleBtn(false)}">v4</button>
              <button id="af-ver-v4-5" style="${toggleBtn(false)}">v4.5</button>
              <button id="af-ver-v5"   style="${toggleBtn(true)}">v5</button>
            </div>
          `)}

        </div>

        <!-- 保存・適用ボタン -->
        <div style="display:flex; gap:6px; margin-top:12px;">
          <button id="suno-af-save" style="
            flex:1; padding:8px; background:#2a5a2a; color:#7eff7e;
            border:1px solid #3a7a3a; border-radius:8px; cursor:pointer;
            font-size:13px; font-weight:600;
          ">💾 保存</button>
          <button id="suno-af-apply" style="
            flex:1; padding:8px; background:#f0a020; color:#000;
            border:none; border-radius:8px; cursor:pointer;
            font-size:13px; font-weight:700;
          ">▶ 適用</button>
        </div>

        <!-- 自動入力・デフォルト設定 -->
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:#aaa;">
            <input id="af-autofill-chk" type="checkbox" style="accent-color:#f0a020; width:14px; height:14px;">
            Suno起動時に自動入力
          </label>
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:#aaa;">
            <input id="af-default-chk" type="checkbox" style="accent-color:#f0a020; width:14px; height:14px;">
            このプリセットをデフォルトにする
          </label>
          <div id="af-default-label" style="font-size:11px; color:#666; padding-left:22px;"></div>
        </div>

      </div>
    `;

    document.body.appendChild(panel);
    panelEl = panel;

    // ===== イベント =====

    // 折り畳み
    document.getElementById('suno-af-toggle').onclick = () => {
      const body = document.getElementById('suno-af-body');
      panelVisible = !panelVisible;
      body.style.display = panelVisible ? 'block' : 'none';
      document.getElementById('suno-af-toggle').textContent = panelVisible ? '▼' : '▲';
    };

    // プリセット切替
    document.getElementById('suno-af-preset-sel').onchange = (e) => {
      currentPreset = e.target.value;
      loadPresetToForm(currentPreset);
      updateDefaultCheckbox();
    };

    // 新規プリセット
    document.getElementById('suno-af-new-btn').onclick = () => {
      const name = prompt('新しいプリセット名を入力してください:');
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      if (settings.presets[trimmed]) {
        showToast('⚠️ 同名のプリセットが存在します');
        return;
      }
      settings.presets[trimmed] = emptyPreset();
      currentPreset = trimmed;
      saveSettings();
      refreshPresetSelect();
      loadPresetToForm(trimmed);
      showToast(`✅ 「${trimmed}」を作成しました`);
    };

    // 削除
    document.getElementById('suno-af-del-btn').onclick = () => {
      const keys = Object.keys(settings.presets);
      if (keys.length <= 1) { showToast('⚠️ 最後のプリセットは削除できません'); return; }
      if (!confirm(`「${currentPreset}」を削除しますか？`)) return;
      delete settings.presets[currentPreset];
      if (settings.defaultPreset === currentPreset) {
        settings.defaultPreset = Object.keys(settings.presets)[0];
      }
      currentPreset = Object.keys(settings.presets)[0];
      saveSettings();
      refreshPresetSelect();
      loadPresetToForm(currentPreset);
      showToast('🗑 削除しました');
    };

    // Weirdness スライダー表示
    document.getElementById('af-weirdness').oninput = (e) => {
      document.getElementById('af-weirdness-val').textContent = e.target.value + '%';
    };

    // Style Influence スライダー表示
    document.getElementById('af-influence').oninput = (e) => {
      document.getElementById('af-influence-val').textContent = e.target.value + '%';
    };

    // Vocal Gender トグル
    ['none', 'male', 'female'].forEach(v => {
      document.getElementById(`af-vg-${v}`).onclick = () => setToggleGroup('vg', v);
    });

    // Lyrics Mode トグル
    ['manual', 'auto'].forEach(v => {
      document.getElementById(`af-lm-${v}`).onclick = () => setToggleGroup('lm', v);
    });

    // Version トグル
    ['none', 'v4', 'v4-5', 'v5'].forEach(v => {
      document.getElementById(`af-ver-${v}`).onclick = () => setToggleGroup('ver', v);
    });

    // 保存
    document.getElementById('suno-af-save').onclick = () => {
      saveFormToPreset(currentPreset);
      saveSettings();

      // 自動入力チェック
      settings.autoFill = document.getElementById('af-autofill-chk').checked;

      // デフォルト設定
      if (document.getElementById('af-default-chk').checked) {
        settings.defaultPreset = currentPreset;
      }

      saveSettings();
      showToast(`💾 「${currentPreset}」を保存しました`);
      updateDefaultCheckbox();
    };

    // 適用
    document.getElementById('suno-af-apply').onclick = () => {
      saveFormToPreset(currentPreset);
      applyPreset(currentPreset);
    };

    // 自動入力チェック
    document.getElementById('af-autofill-chk').onchange = (e) => {
      settings.autoFill = e.target.checked;
      saveSettings();
    };

    // デフォルトチェック
    document.getElementById('af-default-chk').onchange = (e) => {
      if (e.target.checked) {
        settings.defaultPreset = currentPreset;
        saveSettings();
        updateDefaultCheckbox();
      }
    };

    // 初期表示
    refreshPresetSelect();
    loadPresetToForm(currentPreset);
    document.getElementById('af-autofill-chk').checked = settings.autoFill;
    updateDefaultCheckbox();
  }

  // ===================================================
  //  フォームヘルパー
  // ===================================================

  function fieldBlock(label, content) {
    return `
      <div style="margin-bottom:10px;">
        <div style="font-size:11px; color:#888; margin-bottom:4px;">${label}</div>
        ${content}
      </div>
    `;
  }

  function textareaStyle() {
    return `width:100%; box-sizing:border-box; background:#111; color:#e8e8e8;
    border:1px solid #333; border-radius:7px; padding:7px 9px;
    font-size:12px; resize:vertical; font-family:inherit; outline:none;`;
  }

  function inputStyle() {
    return `width:100%; box-sizing:border-box; background:#111; color:#e8e8e8;
    border:1px solid #333; border-radius:7px; padding:7px 9px;
    font-size:12px; font-family:inherit; outline:none;`;
  }

  function btnStyle(bg) {
    return `background:${bg}; color:#ccc; border:1px solid #444;
    border-radius:7px; width:28px; height:28px; cursor:pointer; font-size:13px;`;
  }

  function toggleBtn(active) {
    return active
      ? `background:#f0a020; color:#000; border:none; border-radius:7px;
         padding:5px 10px; cursor:pointer; font-size:12px; font-weight:700;`
      : `background:#1a1a1a; color:#aaa; border:1px solid #333; border-radius:7px;
         padding:5px 10px; cursor:pointer; font-size:12px;`;
  }

  function setToggleGroup(group, active) {
    const map = {
      'vg':  ['none','male','female'],
      'lm':  ['manual','auto'],
      'ver': ['none','v4','v4-5','v5']
    };
    map[group].forEach(v => {
      const btn = document.getElementById(`af-${group}-${v}`);
      if (!btn) return;
      const isActive = v === active;
      btn.style.cssText = toggleBtn(isActive);
    });
  }

  function refreshPresetSelect() {
    const sel = document.getElementById('suno-af-preset-sel');
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

  function updateDefaultCheckbox() {
    const chk = document.getElementById('af-default-chk');
    const lbl = document.getElementById('af-default-label');
    if (!chk || !lbl) return;
    chk.checked = currentPreset === settings.defaultPreset;
    lbl.textContent = `現在のデフォルト: ${settings.defaultPreset}`;
    refreshPresetSelect();
  }

  function loadPresetToForm(presetName) {
    const p = settings.presets[presetName];
    if (!p) return;

    document.getElementById('af-lyrics').value        = p.lyrics        || '';
    document.getElementById('af-styles').value        = p.styles        || '';
    document.getElementById('af-exclude').value       = p.excludeStyles || '';
    document.getElementById('af-title').value         = p.songTitle     || '';

    const wei = p.weirdness !== undefined ? p.weirdness : 50;
    document.getElementById('af-weirdness').value     = wei;
    document.getElementById('af-weirdness-val').textContent = wei + '%';

    const inf = p.styleInfluence !== undefined ? p.styleInfluence : 50;
    document.getElementById('af-influence').value     = inf;
    document.getElementById('af-influence-val').textContent = inf + '%';

    // Vocal Gender
    setToggleGroup('vg', p.vocalGender || 'none');

    // Lyrics Mode
    setToggleGroup('lm', p.lyricsMode || 'manual');

    // Version
    const ver = (p.version || '').replace('.', '-');
    setToggleGroup('ver', ver || 'none');
  }

  function saveFormToPreset(presetName) {
    if (!settings.presets[presetName]) settings.presets[presetName] = emptyPreset();
    const p = settings.presets[presetName];

    p.lyrics        = document.getElementById('af-lyrics').value;
    p.styles        = document.getElementById('af-styles').value;
    p.excludeStyles = document.getElementById('af-exclude').value;
    p.songTitle     = document.getElementById('af-title').value;
    p.weirdness     = parseInt(document.getElementById('af-weirdness').value);
    p.styleInfluence = parseInt(document.getElementById('af-influence').value);

    // Vocal Gender
    const vgActive = ['none','male','female'].find(v => {
      const btn = document.getElementById(`af-vg-${v}`);
      return btn && btn.style.background.includes('f0a020');
    });
    p.vocalGender = vgActive === 'none' ? '' : (vgActive || '');

    // Lyrics Mode
    const lmActive = ['manual','auto'].find(v => {
      const btn = document.getElementById(`af-lm-${v}`);
      return btn && btn.style.background.includes('f0a020');
    });
    p.lyricsMode = lmActive || 'manual';

    // Version
    const verActive = ['none','v4','v4-5','v5'].find(v => {
      const btn = document.getElementById(`af-ver-${v}`);
      return btn && btn.style.background.includes('f0a020');
    });
    p.version = verActive === 'none' ? '' : (verActive || '').replace('-', '.');
  }

  // ===================================================
  //  ページ監視・初期化
  // ===================================================

  let initDone = false;
  let autoApplied = false;

  function tryInit() {
    if (initDone) return;
    // Sunoの作曲ページかチェック
    const isCreatePage = location.pathname.includes('/create') ||
                         location.pathname === '/' ||
                         document.querySelector('textarea') !== null;
    if (!isCreatePage) return;

    buildPanel();
    initDone = true;

    // 自動入力
    if (settings.autoFill && !autoApplied && settings.defaultPreset) {
      autoApplied = true;
      setTimeout(() => {
        applyPreset(settings.defaultPreset);
      }, 1500);
    }
  }

  // SPA対応：URL変化・DOM変化を監視
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      initDone = false;
      autoApplied = false;
      setTimeout(tryInit, 1000);
    }
    if (!initDone) tryInit();
  });

  observer.observe(document.body || document.documentElement, {
    childList: true, subtree: true
  });

  setTimeout(tryInit, 1000);
  setTimeout(tryInit, 3000);

})();
