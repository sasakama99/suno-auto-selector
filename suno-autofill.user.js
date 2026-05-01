// ==UserScript==
// @name         Suno AutoFill（プリセット自動入力）
// @namespace    https://github.com/sasakama99/suno-auto-selector
// @version      1.1.0
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
      lyrics: '',
      styles: '',
      excludeStyles: '',
      vocalGender: '',      // 'male' | 'female' | ''
      lyricsMode: 'manual', // 'manual' | 'auto'
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
  //  要素検索ユーティリティ
  // ===================================================

  // ラベルテキストを含む行の中から特定テキストのボタンを探す
  function findButtonInRow(rowLabelText, buttonText) {
    // ページ内の全要素を走査してラベルを含む親を探す
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      // 直接のテキストがラベルと一致する要素を探す
      const directText = Array.from(node.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join('');
      if (directText === rowLabelText) {
        // この要素の親または祖先でボタンを探す
        let container = node.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!container) break;
          const buttons = container.querySelectorAll('button, [role="button"], span[class*="btn"], div[class*="btn"]');
          for (const btn of buttons) {
            if (btn.textContent.trim() === buttonText) return btn;
          }
          container = container.parentElement;
        }
      }
    }

    // フォールバック: テキスト完全一致ボタンを全体から探す
    const allClickable = document.querySelectorAll('button, [role="button"]');
    for (const el of allClickable) {
      if (el.textContent.trim() === buttonText) return el;
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
    for (const ta of document.querySelectorAll('textarea')) {
      const ph = (ta.placeholder || '').toLowerCase();
      if (ph.includes('style') || ph.includes('genre') || ph.includes('mood')) return ta;
    }
    const tas = document.querySelectorAll('textarea');
    return tas.length >= 2 ? tas[1] : null;
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

  // ===================================================
  //  カスタムスライダー操作
  //  Sunoのスライダーは独自実装 → ポインターイベントで操作
  // ===================================================
  function setCustomSlider(labelText, percent) {
    // ラベルを含む行の中にあるスライダーを探す
    const container = findSliderContainer(labelText);
    if (!container) {
      logDebug(`スライダーコンテナ未検出: ${labelText}`);
      return false;
    }

    // input[type="range"] があれば直接セット
    const rangeInput = container.querySelector('input[type="range"]');
    if (rangeInput) {
      const min = parseFloat(rangeInput.min || 0);
      const max = parseFloat(rangeInput.max || 100);
      const val = min + (max - min) * (percent / 100);
      setReactValue(rangeInput, String(val));
      return true;
    }

    // カスタムスライダーのトラック要素を探す
    // Sunoは縦バー（ティック）が並んだカスタムUI
    const trackCandidates = container.querySelectorAll(
      '[class*="track"], [class*="Track"], [class*="slider"], [class*="Slider"], [class*="bar"], [class*="Bar"]'
    );

    let track = trackCandidates.length > 0 ? trackCandidates[0] : container;

    // コンテナ自体をトラックとして使う（幅が50px以上の要素）
    for (const el of container.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 80 && rect.height > 5 && rect.height < 60) {
        // スライダーらしいアスペクト比
        track = el;
        break;
      }
    }

    return simulateSliderPointer(track, percent);
  }

  function findSliderContainer(labelText) {
    // テキストノードでラベルを探す
    const all = document.querySelectorAll('div, section, label');
    for (const el of all) {
      // 子の直接テキストにラベルを含む
      const text = el.textContent.trim();
      if (!text.includes(labelText)) continue;
      if (text.length > labelText.length + 40) continue; // あまり大きすぎる要素は除外
      // スライダーらしい子要素があるか確認
      const hasSliderLike = el.querySelector(
        'input[type="range"], [role="slider"], [class*="slider"], [class*="Slider"]'
      ) || el.innerHTML.includes('%');
      if (hasSliderLike) return el;
    }

    // より広い範囲で探す
    for (const el of all) {
      const text = el.textContent.trim();
      if (text.startsWith(labelText) && text.length < 20) {
        let p = el.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!p) break;
          if (p.querySelector('input[type="range"], [role="slider"]')) return p;
          // %表示があるコンテナ
          if (p.textContent.includes('%')) return p;
          p = p.parentElement;
        }
      }
    }
    return null;
  }

  function simulateSliderPointer(el, percent) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return false;

      const x = rect.left + rect.width * (percent / 100);
      const y = rect.top + rect.height / 2;

      const mkEvent = (type) => new PointerEvent(type, {
        bubbles: true, cancelable: true,
        clientX: x, clientY: y,
        pointerId: 1, pressure: type === 'pointerup' ? 0 : 0.5
      });

      el.dispatchEvent(mkEvent('pointerdown'));
      el.dispatchEvent(mkEvent('pointermove'));
      el.dispatchEvent(mkEvent('pointerup'));

      // マウスイベントもフォールバック
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, clientX: x, clientY: y }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ===================================================
  //  バージョン選択（ドロップダウンメニューを開いて選択）
  // ===================================================
  // バージョンリスト（UI表示名 → Sunoの表示テキスト）
  const VERSION_LIST = ['v5.5','v5','v4.5+','v4.5','v4.5-all','v4','v3.5','v3','v2'];

  function setVersion(ver) {
    if (!ver) return false;

    // 1. 現在のバージョンボタン（v5 ▼ のようなボタン）をクリックしてドロップダウンを開く
    const versionTriggers = document.querySelectorAll('button, [role="button"]');
    let triggerClicked = false;
    for (const btn of versionTriggers) {
      const t = btn.textContent.trim();
      // vX.X 形式か、バージョン選択ドロップダウントリガーっぽいボタン
      if (/^v[\d.]+/.test(t) || t.toLowerCase().includes('version')) {
        btn.click();
        triggerClicked = true;
        break;
      }
    }

    // ドロップダウンが開くまで少し待ってから選択
    setTimeout(() => {
      const items = document.querySelectorAll('[role="option"], [role="menuitem"], li, [class*="option"], [class*="Option"]');
      for (const item of items) {
        const t = item.textContent.trim();
        if (t.startsWith(ver)) {
          item.click();
          return;
        }
      }
      // フォールバック: テキスト完全一致ボタン
      for (const btn of document.querySelectorAll('button, [role="button"]')) {
        if (btn.textContent.trim() === ver) {
          btn.click();
          return;
        }
      }
    }, 300);

    return true;
  }

  // ===================================================
  //  デバッグログ
  // ===================================================
  function logDebug(msg) {
    console.log(`[SunoAutoFill] ${msg}`);
  }

  // ===================================================
  //  トースト
  // ===================================================
  function showToast(msg, duration = 2500) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      background:#1a1a1a; color:#fff; padding:10px 20px; border-radius:20px;
      border:1px solid #555; font-size:13px; z-index:9999999;
      box-shadow:0 4px 12px rgba(0,0,0,.6); pointer-events:none;
      font-family:-apple-system,"Hiragino Sans",sans-serif;
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), duration);
  }

  // ===================================================
  //  プリセット適用
  // ===================================================
  function applyPreset(presetName) {
    const p = settings.presets[presetName];
    if (!p) return;

    let log = [];

    // Lyrics
    const lyricsEl = getLyricsEl();
    if (lyricsEl && p.lyrics !== undefined) {
      setReactValue(lyricsEl, p.lyrics);
      log.push('Lyrics');
    }

    // Styles
    const stylesEl = getStylesEl();
    if (stylesEl && p.styles !== undefined) {
      setReactValue(stylesEl, p.styles);
      log.push('Styles');
    }

    // Exclude Styles
    const excludeEl = getExcludeEl();
    if (excludeEl && p.excludeStyles !== undefined) {
      setReactValue(excludeEl, p.excludeStyles);
      log.push('Exclude');
    }

    // Song Title
    const titleEl = getSongTitleEl();
    if (titleEl && p.songTitle !== undefined) {
      setReactValue(titleEl, p.songTitle);
      log.push('Title');
    }

    // Vocal Gender
    if (p.vocalGender === 'male') {
      const btn = findButtonInRow('Vocal Gender', 'Male');
      if (btn) { btn.click(); log.push('Male'); }
    } else if (p.vocalGender === 'female') {
      const btn = findButtonInRow('Vocal Gender', 'Female');
      if (btn) { btn.click(); log.push('Female'); }
    }

    // Lyrics Mode
    if (p.lyricsMode === 'manual') {
      const btn = findButtonInRow('Lyrics Mode', 'Manual');
      if (btn) { btn.click(); log.push('Manual'); }
    } else if (p.lyricsMode === 'auto') {
      const btn = findButtonInRow('Lyrics Mode', 'Auto');
      if (btn) { btn.click(); log.push('Auto'); }
    }

    // Weirdness（少し遅延して確実に適用）
    setTimeout(() => {
      if (p.weirdness !== undefined) {
        setCustomSlider('Weirdness', p.weirdness);
      }
      if (p.styleInfluence !== undefined) {
        setCustomSlider('Style Influence', p.styleInfluence);
      }
    }, 200);

    // Version
    if (p.version) {
      setTimeout(() => setVersion(p.version), 400);
    }

    logDebug(`適用完了: ${log.join(', ')}`);
    showToast(`✅ 適用: ${presetName}`);
  }

  // ===================================================
  //  パネルUI
  // ===================================================

  function buildPanel() {
    if (document.getElementById('suno-af-panel')) return;

    // CSS注入
    const style = document.createElement('style');
    style.textContent = `
      #suno-af-panel input:focus, #suno-af-panel textarea:focus {
        border-color: #f0a020 !important; outline: none;
      }
      #suno-af-panel select:focus { outline: none; }
      #suno-af-panel button:hover { opacity: 0.85; }
      .af-toggle-active {
        background: #f0a020 !important; color: #000 !important;
        border-color: #f0a020 !important; font-weight: 700 !important;
      }
      .af-toggle-inactive {
        background: #1a1a1a !important; color: #aaa !important;
        border: 1px solid #333 !important; font-weight: 400 !important;
      }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'suno-af-panel';
    panel.style.cssText = `
      position:fixed; top:60px; right:20px; z-index:9999998;
      width:310px; background:rgba(13,13,13,.98);
      border:1px solid #2a2a2a; border-radius:14px;
      box-shadow:0 8px 32px rgba(0,0,0,.8);
      font-family:-apple-system,"Hiragino Sans",sans-serif;
      color:#e0e0e0; font-size:13px; overflow:hidden;
    `;

    panel.innerHTML = `
      <!-- ヘッダー -->
      <div style="display:flex;align-items:center;justify-content:space-between;
        padding:11px 14px 9px; background:#111; border-bottom:1px solid #222;">
        <span style="font-weight:700;font-size:14px;color:#f0a020;">🎵 Suno AutoFill</span>
        <button id="suno-af-toggle" style="background:none;border:1px solid #333;
          color:#777;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:11px;">▼</button>
      </div>

      <!-- ボディ -->
      <div id="suno-af-body" style="padding:12px 14px;max-height:80vh;overflow-y:auto;">

        <!-- プリセット選択 -->
        <div style="margin-bottom:12px;">
          <div class="af-label">プリセット</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <select id="suno-af-sel" style="flex:1;background:#111;color:#e0e0e0;
              border:1px solid #333;border-radius:7px;padding:6px 8px;font-size:13px;cursor:pointer;"></select>
            <button id="af-new-btn" title="新規" style="${smallBtn('#1a2a1a','#4a8a4a')}">＋</button>
            <button id="af-del-btn" title="削除" style="${smallBtn('#2a1a1a','#8a3a3a')}">🗑</button>
          </div>
        </div>

        <!-- Lyrics -->
        ${section('Lyrics（歌詞）')}
        <textarea id="af-lyrics" rows="3" placeholder="歌詞（空欄=インストゥルメンタル）"
          style="${taStyle()}"></textarea>

        <!-- Styles -->
        ${section('Styles（スタイル）')}
        <textarea id="af-styles" rows="2" placeholder="クリーンギター, ダブルキック, ..."
          style="${taStyle()}"></textarea>

        <!-- Exclude Styles -->
        ${section('Exclude Styles（除外）')}
        <input id="af-exclude" type="text" placeholder="除外するスタイル" style="${inStyle()}">

        <!-- Vocal Gender -->
        ${section('Vocal Gender')}
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="af-vg" data-val="" style="${tbtn()}">指定なし</button>
          <button class="af-vg" data-val="male" style="${tbtn()}">Male</button>
          <button class="af-vg" data-val="female" style="${tbtn()}">Female</button>
        </div>

        <!-- Lyrics Mode -->
        ${section('Lyrics Mode')}
        <div style="display:flex;gap:5px;">
          <button class="af-lm" data-val="manual" style="${tbtn()}">Manual</button>
          <button class="af-lm" data-val="auto" style="${tbtn()}">Auto</button>
        </div>

        <!-- Weirdness -->
        ${section('Weirdness')}
        <div style="display:flex;align-items:center;gap:8px;">
          <input id="af-weirdness" type="range" min="0" max="100" value="50"
            style="flex:1;accent-color:#f0a020;">
          <span id="af-weirdness-v" style="width:34px;text-align:right;color:#f0a020;font-weight:700;">50%</span>
        </div>

        <!-- Style Influence -->
        ${section('Style Influence')}
        <div style="display:flex;align-items:center;gap:8px;">
          <input id="af-influence" type="range" min="0" max="100" value="50"
            style="flex:1;accent-color:#f0a020;">
          <span id="af-influence-v" style="width:34px;text-align:right;color:#f0a020;font-weight:700;">50%</span>
        </div>

        <!-- Song Title -->
        ${section('Song Title')}
        <input id="af-title" type="text" placeholder="曲タイトル（任意）" style="${inStyle()}">

        <!-- Version -->
        ${section('Version')}
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button class="af-ver" data-val="" style="${tbtn()}">指定なし</button>
          <button class="af-ver" data-val="v5.5" style="${tbtn()}">v5.5</button>
          <button class="af-ver" data-val="v5" style="${tbtn()}">v5</button>
          <button class="af-ver" data-val="v4.5+" style="${tbtn()}">v4.5+</button>
          <button class="af-ver" data-val="v4.5" style="${tbtn()}">v4.5</button>
          <button class="af-ver" data-val="v4.5-all" style="${tbtn()}">v4.5-all</button>
          <button class="af-ver" data-val="v4" style="${tbtn()}">v4</button>
          <button class="af-ver" data-val="v3.5" style="${tbtn()}">v3.5</button>
          <button class="af-ver" data-val="v3" style="${tbtn()}">v3</button>
          <button class="af-ver" data-val="v2" style="${tbtn()}">v2</button>
        </div>

        <!-- ボタン -->
        <div style="display:flex;gap:6px;margin-top:14px;">
          <button id="af-save-btn" style="flex:1;padding:9px;background:#1a3a1a;color:#6eff6e;
            border:1px solid #2a6a2a;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">
            💾 保存
          </button>
          <button id="af-apply-btn" style="flex:1;padding:9px;background:#f0a020;color:#000;
            border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">
            ▶ 適用
          </button>
        </div>

        <!-- 設定 -->
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#888;">
            <input id="af-auto-chk" type="checkbox" style="accent-color:#f0a020;width:14px;height:14px;">
            起動時に自動入力
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#888;">
            <input id="af-def-chk" type="checkbox" style="accent-color:#f0a020;width:14px;height:14px;">
            このプリセットをデフォルトにする
          </label>
          <div id="af-def-lbl" style="font-size:11px;color:#555;padding-left:22px;"></div>
        </div>

      </div>
    `;

    document.body.appendChild(panel);

    // ===== イベント登録 =====

    // 折り畳み
    document.getElementById('suno-af-toggle').onclick = () => {
      const body = document.getElementById('suno-af-body');
      panelVisible = !panelVisible;
      body.style.display = panelVisible ? 'block' : 'none';
      document.getElementById('suno-af-toggle').textContent = panelVisible ? '▼' : '▲';
    };

    // プリセット切替
    document.getElementById('suno-af-sel').onchange = (e) => {
      currentPreset = e.target.value;
      loadPresetToForm(currentPreset);
      updateDefaultUI();
    };

    // 新規
    document.getElementById('af-new-btn').onclick = () => {
      const name = prompt('新しいプリセット名:');
      if (!name?.trim()) return;
      const n = name.trim();
      if (settings.presets[n]) return showToast('⚠️ 同名のプリセットが存在します');
      settings.presets[n] = emptyPreset();
      currentPreset = n;
      saveSettings();
      rebuildSelect();
      loadPresetToForm(n);
      showToast(`✅ 「${n}」を作成しました`);
    };

    // 削除
    document.getElementById('af-del-btn').onclick = () => {
      if (Object.keys(settings.presets).length <= 1)
        return showToast('⚠️ 最後のプリセットは削除できません');
      if (!confirm(`「${currentPreset}」を削除しますか？`)) return;
      delete settings.presets[currentPreset];
      if (settings.defaultPreset === currentPreset)
        settings.defaultPreset = Object.keys(settings.presets)[0];
      currentPreset = Object.keys(settings.presets)[0];
      saveSettings();
      rebuildSelect();
      loadPresetToForm(currentPreset);
      showToast('🗑 削除しました');
    };

    // スライダー表示更新
    document.getElementById('af-weirdness').oninput = (e) => {
      document.getElementById('af-weirdness-v').textContent = e.target.value + '%';
    };
    document.getElementById('af-influence').oninput = (e) => {
      document.getElementById('af-influence-v').textContent = e.target.value + '%';
    };

    // トグルグループ
    bindToggleGroup('af-vg');
    bindToggleGroup('af-lm');
    bindToggleGroup('af-ver');

    // 保存
    document.getElementById('af-save-btn').onclick = () => {
      collectFormToPreset(currentPreset);
      settings.autoFill = document.getElementById('af-auto-chk').checked;
      if (document.getElementById('af-def-chk').checked)
        settings.defaultPreset = currentPreset;
      saveSettings();
      showToast(`💾 「${currentPreset}」を保存しました`);
      updateDefaultUI();
    };

    // 適用
    document.getElementById('af-apply-btn').onclick = () => {
      collectFormToPreset(currentPreset);
      applyPreset(currentPreset);
    };

    document.getElementById('af-auto-chk').onchange = (e) => {
      settings.autoFill = e.target.checked;
      saveSettings();
    };
    document.getElementById('af-def-chk').onchange = (e) => {
      if (e.target.checked) {
        settings.defaultPreset = currentPreset;
        saveSettings();
        updateDefaultUI();
      }
    };

    // 初期化
    rebuildSelect();
    loadPresetToForm(currentPreset);
    document.getElementById('af-auto-chk').checked = settings.autoFill;
    updateDefaultUI();
  }

  // ===================================================
  //  トグルグループのバインド
  // ===================================================
  function bindToggleGroup(cls) {
    document.querySelectorAll(`.${cls}`).forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll(`.${cls}`).forEach(b => {
          b.className = `${cls} af-toggle-inactive`;
          b.style.cssText = tbtn();
        });
        btn.className = `${cls} af-toggle-active`;
        btn.style.cssText = tbtnActive();
      };
    });
  }

  function setToggleGroupValue(cls, val) {
    document.querySelectorAll(`.${cls}`).forEach(btn => {
      const isActive = btn.dataset.val === val;
      btn.className = `${cls} ${isActive ? 'af-toggle-active' : 'af-toggle-inactive'}`;
      btn.style.cssText = isActive ? tbtnActive() : tbtn();
    });
  }

  function getToggleGroupValue(cls) {
    const active = document.querySelector(`.${cls}.af-toggle-active`);
    return active ? active.dataset.val : '';
  }

  // ===================================================
  //  フォーム ↔ プリセット変換
  // ===================================================
  function loadPresetToForm(name) {
    const p = settings.presets[name];
    if (!p) return;

    document.getElementById('af-lyrics').value   = p.lyrics        || '';
    document.getElementById('af-styles').value   = p.styles        || '';
    document.getElementById('af-exclude').value  = p.excludeStyles || '';
    document.getElementById('af-title').value    = p.songTitle     || '';

    const w = p.weirdness !== undefined ? p.weirdness : 50;
    document.getElementById('af-weirdness').value   = w;
    document.getElementById('af-weirdness-v').textContent = w + '%';

    const inf = p.styleInfluence !== undefined ? p.styleInfluence : 50;
    document.getElementById('af-influence').value   = inf;
    document.getElementById('af-influence-v').textContent = inf + '%';

    setToggleGroupValue('af-vg',  p.vocalGender || '');
    setToggleGroupValue('af-lm',  p.lyricsMode  || 'manual');
    setToggleGroupValue('af-ver', p.version     || '');
  }

  function collectFormToPreset(name) {
    if (!settings.presets[name]) settings.presets[name] = emptyPreset();
    const p = settings.presets[name];
    p.lyrics        = document.getElementById('af-lyrics').value;
    p.styles        = document.getElementById('af-styles').value;
    p.excludeStyles = document.getElementById('af-exclude').value;
    p.songTitle     = document.getElementById('af-title').value;
    p.weirdness     = parseInt(document.getElementById('af-weirdness').value);
    p.styleInfluence = parseInt(document.getElementById('af-influence').value);
    p.vocalGender   = getToggleGroupValue('af-vg');
    p.lyricsMode    = getToggleGroupValue('af-lm') || 'manual';
    p.version       = getToggleGroupValue('af-ver');
  }

  function rebuildSelect() {
    const sel = document.getElementById('suno-af-sel');
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

  function updateDefaultUI() {
    const chk = document.getElementById('af-def-chk');
    const lbl = document.getElementById('af-def-lbl');
    if (!chk || !lbl) return;
    chk.checked = currentPreset === settings.defaultPreset;
    lbl.textContent = `デフォルト: ${settings.defaultPreset}`;
    rebuildSelect();
  }

  // ===================================================
  //  スタイルヘルパー
  // ===================================================
  function section(label) {
    return `<div style="font-size:11px;color:#666;margin:10px 0 4px;
      text-transform:uppercase;letter-spacing:.05em;">${label}</div>`;
  }
  function taStyle() {
    return `width:100%;box-sizing:border-box;background:#0d0d0d;color:#e0e0e0;
    border:1px solid #2a2a2a;border-radius:7px;padding:7px 9px;
    font-size:12px;resize:vertical;font-family:inherit;`;
  }
  function inStyle() {
    return `width:100%;box-sizing:border-box;background:#0d0d0d;color:#e0e0e0;
    border:1px solid #2a2a2a;border-radius:7px;padding:7px 9px;
    font-size:12px;font-family:inherit;`;
  }
  function tbtn() {
    return `background:#1a1a1a;color:#999;border:1px solid #2a2a2a;
    border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;
    margin-bottom:3px;transition:all .15s;`;
  }
  function tbtnActive() {
    return `background:#f0a020;color:#000;border:1px solid #f0a020;
    border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;
    margin-bottom:3px;font-weight:700;`;
  }
  function smallBtn(bg, border) {
    return `background:${bg};color:#ccc;border:1px solid ${border};
    border-radius:7px;width:28px;height:28px;cursor:pointer;font-size:13px;`;
  }

  // ===================================================
  //  ページ監視・初期化
  // ===================================================
  let initDone = false;
  let autoApplied = false;
  let lastUrl = location.href;

  function tryInit() {
    if (initDone) return;
    const hasTextarea = document.querySelector('textarea') !== null;
    const isTarget = location.pathname.includes('/create') ||
                     location.pathname === '/' || hasTextarea;
    if (!isTarget) return;

    buildPanel();
    initDone = true;

    if (settings.autoFill && !autoApplied && settings.defaultPreset) {
      autoApplied = true;
      setTimeout(() => applyPreset(settings.defaultPreset), 1800);
    }
  }

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      initDone = false;
      autoApplied = false;
      const existing = document.getElementById('suno-af-panel');
      if (existing) existing.remove();
      setTimeout(tryInit, 1200);
    }
    if (!initDone) tryInit();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(tryInit, 1000);
  setTimeout(tryInit, 3000);

})();
