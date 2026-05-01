// ==UserScript==
// @name         Suno AutoFill（プリセット自動入力）
// @namespace    https://github.com/sasakama99/suno-auto-selector
// @version      2.6.0
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

  // =========================================================
  //  ストレージ
  // =========================================================
  const STORAGE_KEY = 'sunoAutofill_v2';

  function loadSettings() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      autoFill: false,
      defaultPreset: '基礎設定',
      presets: { '基礎設定': emptyPreset() }
    };
  }

  function saveSettings() {
    GM_setValue(STORAGE_KEY, JSON.stringify(settings));
  }

  function emptyPreset() {
    return {
      lyrics: '', styles: '', excludeStyles: '',
      vocalGender: 'none',  // 'none' | 'male' | 'female'
      lyricsMode: 'manual', // 'manual' | 'auto'
      weirdness: 50, styleInfluence: 50,
      songTitle: '', version: 'none'
    };
  }

  let settings = loadSettings();
  let currentPreset = settings.defaultPreset;
  if (!settings.presets[currentPreset]) {
    currentPreset = Object.keys(settings.presets)[0] || '基礎設定';
    if (!settings.presets[currentPreset]) settings.presets[currentPreset] = emptyPreset();
  }

  // =========================================================
  //  ユーティリティ
  // =========================================================

  // テキスト正規化（記号・絵文字・空白を除去して小文字に）
  function norm(t) {
    return (t || '')
      .replace(/[\u{1F000}-\u{1FFFF}\u{2000}-\u{2BFF}]/gu, '')
      .replace(/[ⓘℹ︎•·]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // React 内部にアクセスするキー
  function reactKey(el) {
    return Object.keys(el).find(k =>
      k.startsWith('__reactFiber') ||
      k.startsWith('__reactInternals') ||
      k.startsWith('__reactProps') ||
      k.startsWith('__reactEventHandlers')
    );
  }

  // React のハンドラを呼ぶ（ファイバーツリーを上に辿る）
  function callReactHandler(el, value, eventNames = ['onValueChange', 'onChangeCommitted', 'onChange']) {
    const key = reactKey(el);
    if (!key) return false;
    let f = el[key];
    while (f) {
      const props = f.memoizedProps || f.pendingProps || f;
      if (props) {
        for (const ev of eventNames) {
          const h = props[ev];
          if (typeof h === 'function') {
            try {
              if (ev === 'onValueChange') h(Array.isArray(value) ? value : [value]);
              else if (ev === 'onChangeCommitted') h(null, value);
              else h({ target: { value: String(value) }, currentTarget: { value: String(value) } });
              return true;
            } catch (e) { /* 次のハンドラを試す */ }
          }
        }
      }
      f = f.return;
    }
    return false;
  }

  // ネイティブのvalueセッター経由で input/textarea に値をセット
  function setNativeValue(el, value) {
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
      return false;
    }
  }

  // テキストでクリック可能要素を探す（自分のパネル内は除外）
  function findClickable(text, scope = document) {
    const target = norm(text);
    if (!target) return null;
    const panel = document.getElementById('suno-af-panel');
    const els = scope.querySelectorAll('button, [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="radio"]');
    for (const el of els) {
      if (panel && panel.contains(el)) continue;
      if (norm(el.textContent) === target) return el;
    }
    for (const el of scope.querySelectorAll('div, span, li')) {
      if (panel && panel.contains(el)) continue;
      if (norm(el.textContent) === target && el.children.length <= 2) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
    }
    return null;
  }

  // ラベル要素（テキストが label を含む）の祖先内でボタンを探す
  function findButtonNearLabel(labelText, btnText) {
    const ln = norm(labelText);
    const bn = norm(btnText);
    let bestLabel = null;

    // ラベル要素を見つける
    for (const el of document.querySelectorAll('div, span, label, p, h1, h2, h3, h4')) {
      const t = norm(el.textContent);
      if (!t.startsWith(ln)) continue;
      if (t.length > ln.length + 30) continue;
      if (el.children.length > 4) continue;
      bestLabel = el;
      break;
    }

    if (bestLabel) {
      let p = bestLabel.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!p) break;
        const found = findClickable(btnText, p);
        if (found) return found;
        p = p.parentElement;
      }
    }
    return findClickable(btnText);
  }

  // textarea/inputをplaceholderで探す（自分のパネル内は除外）
  function findByPlaceholder(keywords, tag = 'textarea') {
    const panel = document.getElementById('suno-af-panel');
    for (const el of document.querySelectorAll(tag)) {
      if (panel && panel.contains(el)) continue;
      const ph = norm(el.placeholder || '');
      if (keywords.some(k => ph.includes(k))) return el;
    }
    return null;
  }

  // パネル外の textarea/input を順番取得
  function getSunoTextareas() {
    const panel = document.getElementById('suno-af-panel');
    return [...document.querySelectorAll('textarea')].filter(t => !panel || !panel.contains(t));
  }
  function getSunoInputs() {
    const panel = document.getElementById('suno-af-panel');
    return [...document.querySelectorAll('input')].filter(t => !panel || !panel.contains(t));
  }

  // =========================================================
  //  スライダー設定（Radix UI対応）
  //  Sunoは role="slider" を使用 → トラック検出 + pointer or キーボード
  // =========================================================
  function setSlider(labelText, percent) {
    const ln = norm(labelText);

    // 戦略A: role="slider" を見つけてRadix UI方式で操作
    for (const thumb of document.querySelectorAll('[role="slider"]')) {
      let p = thumb.parentElement;
      let matched = false;
      for (let i = 0; i < 10; i++) {
        if (!p) break;
        if (norm(p.textContent).includes(ln)) { matched = true; break; }
        p = p.parentElement;
      }
      if (!matched) continue;

      // Radix UIスライダーの操作（4つの戦略を順に試す）
      const r1 = setRadixSliderByKeyboard(thumb, percent);
      if (r1) return { ok: true, method: 'keyboard' };

      const r2 = setRadixSliderByTrackPointer(thumb, percent);
      if (r2) return { ok: true, method: 'track-pointer' };

      const r3 = callReactHandler(thumb, percent);
      if (r3) return { ok: true, method: 'react-handler' };

      simulateThumbPointer(thumb, percent);
      return { ok: true, method: 'thumb-pointer' };
    }

    // 戦略B: input[type="range"] でラベル近傍（Weirdnessラベルを含むもの）
    for (const inp of document.querySelectorAll('input[type="range"]')) {
      // min:0, max:1のシークバーは除外
      if (parseFloat(inp.max || 0) <= 1) continue;
      let p = inp.parentElement;
      for (let i = 0; i < 10; i++) {
        if (!p) break;
        if (norm(p.textContent).includes(ln)) {
          const val = (parseFloat(inp.min || 0)) + (parseFloat(inp.max || 100) - parseFloat(inp.min || 0)) * (percent / 100);
          if (callReactHandler(inp, val)) return { ok: true, method: 'range+react' };
          setNativeValue(inp, String(val));
          return { ok: true, method: 'range+native' };
        }
        p = p.parentElement;
      }
    }

    return { ok: false, method: 'not-found' };
  }

  // 方法1: キーボードで矢印キーを押して値を変更（Radix UIで最も確実）
  function setRadixSliderByKeyboard(thumb, target) {
    try {
      const current = parseInt(thumb.getAttribute('aria-valuenow') || '50');
      if (current === target) return true;

      thumb.focus();
      const diff = target - current;
      const key = diff > 0 ? 'ArrowRight' : 'ArrowLeft';
      const code = diff > 0 ? 'ArrowRight' : 'ArrowLeft';
      const keyCode = diff > 0 ? 39 : 37;

      const press = () => {
        const evt = new KeyboardEvent('keydown', {
          key, code, keyCode, which: keyCode,
          bubbles: true, cancelable: true
        });
        thumb.dispatchEvent(evt);
        const evt2 = new KeyboardEvent('keyup', {
          key, code, keyCode, which: keyCode,
          bubbles: true, cancelable: true
        });
        thumb.dispatchEvent(evt2);
      };

      const steps = Math.abs(diff);
      for (let i = 0; i < steps; i++) press();

      // 値が変わったか確認
      const after = parseInt(thumb.getAttribute('aria-valuenow') || '0');
      return Math.abs(after - target) <= 1;
    } catch (e) { return false; }
  }

  // 方法2: スライダールートのトラック要素にpointerdownを送る
  function setRadixSliderByTrackPointer(thumb, percent) {
    try {
      // スライダーのルート要素（横長コンテナ）を探す
      let root = thumb;
      for (let i = 0; i < 6; i++) {
        if (!root.parentElement) break;
        root = root.parentElement;
        const r = root.getBoundingClientRect();
        if (r.width > 80 && r.height < 60) break;
      }

      // トラック候補（rootの中で横長の子要素）
      let track = root;
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 80 && r.height > 0 && r.height < 30) {
          track = el;
          break;
        }
      }

      const rect = track.getBoundingClientRect();
      if (rect.width === 0) return false;
      const x = rect.left + rect.width * (percent / 100);
      const y = rect.top + rect.height / 2;

      const opts = {
        bubbles: true, cancelable: true,
        clientX: x, clientY: y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: 1
      };

      track.dispatchEvent(new PointerEvent('pointerdown', opts));
      track.dispatchEvent(new MouseEvent('mousedown', opts));
      // Radix UIは document レベルで pointermove を待つ
      document.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 1 }));
      document.dispatchEvent(new MouseEvent('mousemove', { ...opts, buttons: 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      document.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));

      // 結果確認
      const after = parseInt(thumb.getAttribute('aria-valuenow') || '0');
      return Math.abs(after - percent) <= 2;
    } catch (e) { return false; }
  }

  // 方法4: thumb自体にpointerイベント（フォールバック）
  function simulateThumbPointer(el, percent) {
    if (!el) return;
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      const x = r.left + r.width * (percent / 100);
      const y = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' };
      ['pointerdown', 'pointermove', 'pointerup'].forEach(t => el.dispatchEvent(new PointerEvent(t, opts)));
      ['mousedown', 'mousemove', 'mouseup', 'click'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
    } catch (e) {}
  }

  // =========================================================
  //  バージョン選択（パネル除外）
  // =========================================================
  async function setVersion(ver) {
    if (!ver || ver === 'none') return { ok: true, method: 'skip' };
    const vn = norm(ver);
    const panel = document.getElementById('suno-af-panel');

    function clickItem() {
      // 多様なセレクタで試す（Sunoのドロップダウン実装に幅広く対応）
      const all = document.querySelectorAll('[role="option"], [role="menuitem"], [role="listitem"], li, [class*="option"], [class*="Option"], [class*="item"], [class*="Item"], div, button, span');
      for (const item of all) {
        if (panel && panel.contains(item)) continue;
        const t = norm(item.textContent);
        // 完全一致か "v5 " で始まる（"v5.5"を誤認しないように）
        const exactStart = t === vn || t.startsWith(vn + ' ');
        if (!exactStart) continue;
        // 短すぎず長すぎない（メニュー項目）
        if (t.length > 100) continue;
        // 表示されているか
        const rect = item.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // 子要素が多すぎる場合スキップ（外側の親っぽい）
        if (item.children.length > 6) continue;
        item.click();
        console.log('[SunoAutoFill] Version item クリック:', t.slice(0, 50), 'tag:', item.tagName);
        return true;
      }
      return false;
    }

    if (clickItem()) return { ok: true, method: 'direct' };

    // ドロップダウントリガーを開く（パネル外限定）
    let triggerClicked = false;
    for (const btn of document.querySelectorAll('button, [role="combobox"], [role="button"]')) {
      if (panel && panel.contains(btn)) continue;
      const t = norm(btn.textContent);
      // Suno のバージョンボタン: 「v5」「v5 ▼」のような短いテキスト
      if (/^v\d/.test(t) && t.length < 15) {
        btn.click();
        console.log('[SunoAutoFill] Version trigger クリック:', t);
        triggerClicked = true;
        await sleep(400);
        if (clickItem()) return { ok: true, method: 'trigger' };
        await sleep(400);
        if (clickItem()) return { ok: true, method: 'trigger-late' };
        break;
      }
    }
    return { ok: false, method: triggerClicked ? 'no-item' : 'no-trigger' };
  }

  // =========================================================
  //  More Options 展開判定 & 自動展開
  // =========================================================
  function isMoreOptionsExpanded() {
    const panel = document.getElementById('suno-af-panel');

    // 判定1: Excludeのinput/textareaが存在
    for (const el of document.querySelectorAll('input, textarea')) {
      if (panel && panel.contains(el)) continue;
      const ph = norm(el.placeholder || el.getAttribute('aria-label') || '');
      if (ph.includes('exclude')) return true;
    }

    // 判定2: Sunoの[role="slider"]がパネル外に存在 = Weirdness/Style Influenceがある
    for (const el of document.querySelectorAll('[role="slider"]')) {
      if (panel && panel.contains(el)) continue;
      return true;
    }

    // 判定3: 葉ノードのラベル（直接のテキストノード）で完全一致
    for (const el of document.querySelectorAll('div, span, label, p')) {
      if (panel && panel.contains(el)) continue;
      // 子要素がある場合は直接のテキストノードのみ取得
      let directText = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) directText += node.textContent;
      }
      const dt = norm(directText);
      if (dt === 'weirdness' || dt === 'vocal gender' || dt === 'lyrics mode' || dt === 'style influence') {
        return true;
      }
    }
    return false;
  }

  async function expandMoreOptions() {
    if (isMoreOptionsExpanded()) {
      console.log('[SunoAutoFill] More Options すでに展開済み');
      return true;
    }

    const panel = document.getElementById('suno-af-panel');

    // "More Options" を含むクリック候補（パネル外限定）
    const candidates = [];

    // 1. button / role=button の中で "More Options" が完全一致 or 始まる短いもの
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (panel && panel.contains(el)) continue;
      const t = norm(el.textContent);
      if ((t === 'more options' || t.startsWith('more options')) && t.length < 25) {
        candidates.push(el);
      }
    }

    // 2. 上で見つからなければ div/section/h3/h4 を見る
    if (candidates.length === 0) {
      for (const el of document.querySelectorAll('div, section, h3, h4, span')) {
        if (panel && panel.contains(el)) continue;
        const t = norm(el.textContent);
        if ((t === 'more options' || t.startsWith('more options')) &&
            t.length < 25 && el.children.length <= 5) {
          candidates.push(el);
        }
      }
    }

    console.log('[SunoAutoFill] More Options 候補:', candidates.length, '個');

    // 候補をクリック → 展開を確認 → 失敗したら親をクリック
    for (const target of candidates) {
      target.click();
      await sleep(500);
      if (isMoreOptionsExpanded()) {
        console.log('[SunoAutoFill] 展開成功:', target.tagName);
        return true;
      }
      // 親も試す
      if (target.parentElement && !panel?.contains(target.parentElement)) {
        target.parentElement.click();
        await sleep(500);
        if (isMoreOptionsExpanded()) {
          console.log('[SunoAutoFill] 展開成功(親):', target.parentElement.tagName);
          return true;
        }
      }
    }
    console.log('[SunoAutoFill] More Options 展開失敗');
    return false;
  }

  // =========================================================
  //  プリセット適用
  // =========================================================
  async function applyPreset(name) {
    const p = settings.presets[name];
    if (!p) return showResult([['プリセットなし', false]]);

    const results = [];

    // More Options を自動展開（閉じている場合のみ）
    const expanded = await expandMoreOptions();
    results.push(['MoreOptions展開', expanded]);

    // === Lyrics: placeholderマッチ → 1番目のtextareaフォールバック ===
    const sunoTextareas = getSunoTextareas();
    let lyrics = findByPlaceholder(['lyrics', 'instrumental'], 'textarea');
    if (!lyrics && sunoTextareas.length >= 1) lyrics = sunoTextareas[0];
    console.log('[SunoAutoFill] Lyrics target:', lyrics?.placeholder, lyrics);
    results.push(['Lyrics',  lyrics ? setNativeValue(lyrics, p.lyrics || '') : false]);

    // === Styles: placeholderマッチ → 2番目のtextareaフォールバック ===
    let styles = findByPlaceholder(['style', 'genre', 'mood'], 'textarea');
    if (!styles && sunoTextareas.length >= 2) styles = sunoTextareas[1];
    console.log('[SunoAutoFill] Styles target:', styles?.placeholder, styles);
    results.push(['Styles',  styles ? setNativeValue(styles, p.styles || '') : false]);

    // Exclude（More Options が展開されていないと無い）
    const exclude = findByPlaceholder(['exclude'], 'input');
    if (p.excludeStyles) {
      results.push(['Exclude', exclude ? setNativeValue(exclude, p.excludeStyles) : false]);
    }

    // Title
    const title = findByPlaceholder(['song title', 'title'], 'input');
    results.push(['Title',   title ? setNativeValue(title, p.songTitle || '') : false]);

    // ボタン系
    if (p.vocalGender === 'male') {
      const b = findButtonNearLabel('Vocal Gender', 'Male');
      results.push(['Male',   b ? (b.click(), true) : false]);
    } else if (p.vocalGender === 'female') {
      const b = findButtonNearLabel('Vocal Gender', 'Female');
      results.push(['Female', b ? (b.click(), true) : false]);
    }

    if (p.lyricsMode === 'manual') {
      const b = findButtonNearLabel('Lyrics Mode', 'Manual');
      results.push(['Manual', b ? (b.click(), true) : false]);
    } else if (p.lyricsMode === 'auto') {
      const b = findButtonNearLabel('Lyrics Mode', 'Auto');
      results.push(['Auto',   b ? (b.click(), true) : false]);
    }

    // スライダー（少し遅延）
    await sleep(300);
    if (p.weirdness !== undefined) {
      const r = setSlider('Weirdness', p.weirdness);
      results.push([`Weirdness(${r.method})`, r.ok]);
    }
    if (p.styleInfluence !== undefined) {
      const r = setSlider('Style Influence', p.styleInfluence);
      results.push([`Influence(${r.method})`, r.ok]);
    }

    // バージョン
    if (p.version && p.version !== 'none') {
      const r = await setVersion(p.version);
      results.push([`Version(${r.method})`, r.ok]);
    }

    showResult(results);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function showResult(results) {
    const okCount = results.filter(r => r[1]).length;
    const failed = results.filter(r => !r[1]).map(r => r[0]);
    const msg = failed.length === 0
      ? `✅ 全${okCount}項目を適用`
      : `⚠️ 成功${okCount}件 / 失敗: ${failed.join(', ')}`;
    showToast(msg, 4000);
    console.log('[SunoAutoFill] 適用結果:', results);
  }

  function showToast(msg, dur = 2500) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      background:#1a1a1a;color:#fff;padding:10px 20px;border-radius:20px;
      border:1px solid #555;font-size:13px;z-index:9999999;max-width:80%;
      box-shadow:0 4px 12px rgba(0,0,0,.6);pointer-events:none;
      font-family:-apple-system,"Hiragino Sans",sans-serif;text-align:center;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), dur);
  }

  // =========================================================
  //  検出（デバッグ用）
  // =========================================================
  function detectElements() {
    const out = {
      textareas: [...document.querySelectorAll('textarea')].map(t => ({
        placeholder: t.placeholder, value: t.value
      })),
      inputs: [...document.querySelectorAll('input[type="text"], input:not([type])')].map(i => ({
        placeholder: i.placeholder, value: i.value
      })),
      ranges: [...document.querySelectorAll('input[type="range"]')].map(r => ({
        min: r.min, max: r.max, value: r.value, parent: getNearestLabel(r)
      })),
      sliders: [...document.querySelectorAll('[role="slider"]')].map(s => ({
        ariaValueNow: s.getAttribute('aria-valuenow'),
        parent: getNearestLabel(s)
      })),
      buttons: {
        'Male': !!findClickable('Male'),
        'Female': !!findClickable('Female'),
        'Manual': !!findClickable('Manual'),
        'Auto': !!findClickable('Auto'),
      },
      labels: {
        'Vocal Gender': !!findLabelEl('Vocal Gender'),
        'Lyrics Mode': !!findLabelEl('Lyrics Mode'),
        'Weirdness': !!findLabelEl('Weirdness'),
        'Style Influence': !!findLabelEl('Style Influence'),
      }
    };
    console.log('[SunoAutoFill] 検出結果:', out);
    showToast('🔍 検出結果をコンソール(F12→Console)に出力', 4000);
    return out;
  }

  function findLabelEl(text) {
    const tn = norm(text);
    for (const el of document.querySelectorAll('div, span, label, p')) {
      const t = norm(el.textContent);
      if (t.startsWith(tn) && t.length < tn.length + 30) return el;
    }
    return null;
  }

  function getNearestLabel(el) {
    let p = el.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!p) break;
      const t = (p.textContent || '').trim().slice(0, 40);
      if (t.length > 0) return t;
      p = p.parentElement;
    }
    return '';
  }

  // =========================================================
  //  パネルUI（CSS classで状態管理）
  // =========================================================
  function buildPanel() {
    if (document.getElementById('suno-af-panel')) return;

    // CSS注入
    const css = document.createElement('style');
    css.textContent = `
      #suno-af-panel { position:fixed;top:60px;right:20px;z-index:9999998;width:310px;
        background:rgba(13,13,13,.98);border:1px solid #2a2a2a;border-radius:14px;
        box-shadow:0 8px 32px rgba(0,0,0,.8);
        font-family:-apple-system,"Hiragino Sans",sans-serif;color:#e0e0e0;font-size:13px;}
      #suno-af-panel * { box-sizing:border-box; }
      #suno-af-panel .af-hd { display:flex;align-items:center;justify-content:space-between;
        padding:11px 14px 9px;background:#111;border-bottom:1px solid #222;
        border-radius:14px 14px 0 0; }
      #suno-af-panel .af-title { font-weight:700;font-size:14px;color:#f0a020;flex:1; }
      #suno-af-panel .af-iconbtn { background:none;border:1px solid #333;color:#777;
        border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:11px;margin-left:4px; }
      #suno-af-panel .af-body { padding:12px 14px;max-height:80vh;overflow-y:auto; }
      #suno-af-panel .af-body::-webkit-scrollbar { width:4px; }
      #suno-af-panel .af-body::-webkit-scrollbar-thumb { background:#333;border-radius:2px; }
      #suno-af-panel .af-fld-label { font-size:11px;color:#555;margin:10px 0 4px;
        text-transform:uppercase;letter-spacing:.04em; }
      #suno-af-panel textarea, #suno-af-panel input[type="text"], #suno-af-panel select {
        width:100%;background:#0d0d0d;color:#e0e0e0;border:1px solid #2a2a2a;
        border-radius:7px;padding:7px 9px;font-size:12px;font-family:inherit;outline:none; }
      #suno-af-panel textarea { resize:vertical; }
      #suno-af-panel textarea:focus, #suno-af-panel input:focus { border-color:#f0a020; }
      #suno-af-panel .af-row { display:flex;gap:5px;flex-wrap:wrap; }

      #suno-af-panel .af-btn {
        background:#1a1a1a;color:#aaa;border:1px solid #2a2a2a;border-radius:6px;
        padding:6px 11px;cursor:pointer;font-size:12px;font-weight:400;
        font-family:inherit;margin:0;transition:all .12s; }
      #suno-af-panel .af-btn:hover { background:#252525;color:#fff; }
      #suno-af-panel .af-btn.active {
        background:#f0a020;color:#000;border-color:#f0a020;font-weight:700; }

      #suno-af-panel .af-action {
        display:flex;gap:6px;margin-top:14px; }
      #suno-af-panel .af-save {
        flex:1;padding:9px;background:#1a3a1a;color:#6eff6e;
        border:1px solid #2a6a2a;border-radius:8px;cursor:pointer;
        font-size:13px;font-weight:600;font-family:inherit; }
      #suno-af-panel .af-apply {
        flex:1;padding:9px;background:#f0a020;color:#000;border:none;
        border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;font-family:inherit; }
      #suno-af-panel .af-detect {
        margin-top:8px;width:100%;padding:7px;background:#1a1a2a;color:#9ab;
        border:1px solid #2a2a4a;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit; }

      #suno-af-panel .af-cfg { margin-top:10px;display:flex;flex-direction:column;gap:6px; }
      #suno-af-panel .af-cfg label { display:flex;align-items:center;gap:8px;
        cursor:pointer;font-size:12px;color:#888; }
      #suno-af-panel .af-cfg input[type="checkbox"] { accent-color:#f0a020;
        width:14px;height:14px;cursor:pointer; }
      #suno-af-panel .af-def { font-size:11px;color:#444;padding-left:22px; }

      #suno-af-panel .af-slider-row { display:flex;align-items:center;gap:8px; }
      #suno-af-panel .af-slider-row input[type="range"] { flex:1;accent-color:#f0a020; }
      #suno-af-panel .af-slider-val { width:38px;text-align:right;color:#f0a020;font-weight:700; }

      #suno-af-panel .af-preset-row { display:flex;gap:6px;align-items:center;margin-bottom:12px; }
      #suno-af-panel .af-preset-row select { flex:1; }
      #suno-af-panel .af-mini { width:30px;height:30px;flex-shrink:0;
        border-radius:7px;cursor:pointer;font-size:13px;border:1px solid #333;
        background:#1a1a1a;color:#bbb; }
      #suno-af-panel .af-mini.green { background:#1a2a1a;border-color:#3a6a3a; }
      #suno-af-panel .af-mini.red { background:#2a1a1a;border-color:#6a2a2a; }
    `;
    document.head.appendChild(css);

    const panel = document.createElement('div');
    panel.id = 'suno-af-panel';

    panel.innerHTML = `
      <div class="af-hd">
        <span class="af-title">🎵 Suno AutoFill</span>
        <button class="af-iconbtn" id="af-collapse">▼</button>
      </div>
      <div class="af-body" id="af-body">

        <div class="af-fld-label">プリセット</div>
        <div class="af-preset-row">
          <select id="af-sel"></select>
          <button class="af-mini green" id="af-new" title="新規">＋</button>
          <button class="af-mini red"   id="af-del" title="削除">🗑</button>
        </div>

        <div class="af-fld-label">Lyrics（歌詞）</div>
        <textarea id="af-lyrics" rows="3" placeholder="歌詞（空欄=インストゥルメンタル）"></textarea>

        <div class="af-fld-label">Styles（スタイル）</div>
        <textarea id="af-styles" rows="2" placeholder="クリーンギター, ダブルキック, ..."></textarea>

        <div class="af-fld-label">Exclude Styles（除外）</div>
        <input id="af-exclude" type="text" placeholder="除外するスタイル">

        <div class="af-fld-label">Vocal Gender</div>
        <div class="af-row">
          <button class="af-btn" data-grp="vg" data-val="none">指定なし</button>
          <button class="af-btn" data-grp="vg" data-val="male">Male</button>
          <button class="af-btn" data-grp="vg" data-val="female">Female</button>
        </div>

        <div class="af-fld-label">Lyrics Mode</div>
        <div class="af-row">
          <button class="af-btn" data-grp="lm" data-val="manual">Manual</button>
          <button class="af-btn" data-grp="lm" data-val="auto">Auto</button>
        </div>

        <div class="af-fld-label">Weirdness</div>
        <div class="af-slider-row">
          <input id="af-weirdness" type="range" min="0" max="100" value="50">
          <span class="af-slider-val" id="af-weirdness-v">50%</span>
        </div>

        <div class="af-fld-label">Style Influence</div>
        <div class="af-slider-row">
          <input id="af-influence" type="range" min="0" max="100" value="50">
          <span class="af-slider-val" id="af-influence-v">50%</span>
        </div>

        <div class="af-fld-label">Song Title</div>
        <input id="af-title" type="text" placeholder="曲タイトル（任意）">

        <div class="af-fld-label">Version</div>
        <div class="af-row">
          <button class="af-btn" data-grp="ver" data-val="none">指定なし</button>
          <button class="af-btn" data-grp="ver" data-val="v5.5">v5.5</button>
          <button class="af-btn" data-grp="ver" data-val="v5">v5</button>
          <button class="af-btn" data-grp="ver" data-val="v4.5+">v4.5+</button>
          <button class="af-btn" data-grp="ver" data-val="v4.5">v4.5</button>
          <button class="af-btn" data-grp="ver" data-val="v4.5-all">v4.5-all</button>
          <button class="af-btn" data-grp="ver" data-val="v4">v4</button>
          <button class="af-btn" data-grp="ver" data-val="v3.5">v3.5</button>
          <button class="af-btn" data-grp="ver" data-val="v3">v3</button>
          <button class="af-btn" data-grp="ver" data-val="v2">v2</button>
        </div>

        <div class="af-action">
          <button class="af-save"  id="af-save">💾 保存</button>
          <button class="af-apply" id="af-apply">▶ 適用</button>
        </div>

        <button class="af-detect" id="af-detect">🔍 Sunoの要素を検出（F12→Console）</button>

        <div class="af-cfg">
          <label><input id="af-auto" type="checkbox"> 起動時に自動入力</label>
          <label><input id="af-def" type="checkbox"> このプリセットをデフォルトにする</label>
          <div class="af-def" id="af-def-lbl"></div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // ===== トグルボタン（CSS class管理）=====
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('.af-btn[data-grp]');
      if (!btn) return;
      const grp = btn.dataset.grp;
      // 同じグループの全ボタンから active を外す
      panel.querySelectorAll(`.af-btn[data-grp="${grp}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });

    // ===== その他のイベント =====
    document.getElementById('af-collapse').onclick = () => {
      const body = document.getElementById('af-body');
      const btn = document.getElementById('af-collapse');
      const visible = body.style.display !== 'none';
      body.style.display = visible ? 'none' : 'block';
      btn.textContent = visible ? '▲' : '▼';
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
      rebuildSelect();
      loadForm(n);
    };

    document.getElementById('af-del').onclick = () => {
      if (Object.keys(settings.presets).length <= 1) return showToast('⚠️ 最後のプリセットは削除できません');
      if (!confirm(`「${currentPreset}」を削除しますか？`)) return;
      delete settings.presets[currentPreset];
      if (settings.defaultPreset === currentPreset)
        settings.defaultPreset = Object.keys(settings.presets)[0];
      currentPreset = Object.keys(settings.presets)[0];
      saveSettings(); rebuildSelect(); loadForm(currentPreset);
      showToast('🗑 削除しました');
    };

    document.getElementById('af-weirdness').oninput = (e) => {
      document.getElementById('af-weirdness-v').textContent = e.target.value + '%';
    };
    document.getElementById('af-influence').oninput = (e) => {
      document.getElementById('af-influence-v').textContent = e.target.value + '%';
    };

    document.getElementById('af-save').onclick = () => {
      collectForm(currentPreset);
      settings.autoFill = document.getElementById('af-auto').checked;
      if (document.getElementById('af-def').checked) settings.defaultPreset = currentPreset;
      saveSettings();
      showToast(`💾 「${currentPreset}」を保存しました`);
      syncDefaultUI();
    };

    document.getElementById('af-apply').onclick = () => {
      collectForm(currentPreset);
      applyPreset(currentPreset);
    };

    document.getElementById('af-detect').onclick = detectElements;

    document.getElementById('af-auto').onchange = (e) => {
      settings.autoFill = e.target.checked;
      saveSettings();
    };
    document.getElementById('af-def').onchange = (e) => {
      if (e.target.checked) {
        settings.defaultPreset = currentPreset;
        saveSettings();
        syncDefaultUI();
      }
    };

    rebuildSelect();
    loadForm(currentPreset);
    document.getElementById('af-auto').checked = !!settings.autoFill;
    syncDefaultUI();
  }

  // =========================================================
  //  フォーム ↔ プリセット
  // =========================================================
  function setActiveButton(grp, val) {
    const panel = document.getElementById('suno-af-panel');
    if (!panel) return;
    panel.querySelectorAll(`.af-btn[data-grp="${grp}"]`).forEach(b => {
      b.classList.toggle('active', b.dataset.val === val);
    });
  }

  function getActiveButton(grp) {
    const panel = document.getElementById('suno-af-panel');
    if (!panel) return '';
    const a = panel.querySelector(`.af-btn[data-grp="${grp}"].active`);
    return a ? a.dataset.val : '';
  }

  function loadForm(name) {
    const p = settings.presets[name] || emptyPreset();
    document.getElementById('af-lyrics').value  = p.lyrics || '';
    document.getElementById('af-styles').value  = p.styles || '';
    document.getElementById('af-exclude').value = p.excludeStyles || '';
    document.getElementById('af-title').value   = p.songTitle || '';

    const w = p.weirdness ?? 50;
    document.getElementById('af-weirdness').value = w;
    document.getElementById('af-weirdness-v').textContent = w + '%';

    const inf = p.styleInfluence ?? 50;
    document.getElementById('af-influence').value = inf;
    document.getElementById('af-influence-v').textContent = inf + '%';

    setActiveButton('vg',  p.vocalGender || 'none');
    setActiveButton('lm',  p.lyricsMode  || 'manual');
    setActiveButton('ver', p.version     || 'none');
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
    p.vocalGender   = getActiveButton('vg') || 'none';
    p.lyricsMode    = getActiveButton('lm') || 'manual';
    p.version       = getActiveButton('ver') || 'none';
  }

  function rebuildSelect() {
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
    const chk = document.getElementById('af-def');
    const lbl = document.getElementById('af-def-lbl');
    if (chk) chk.checked = currentPreset === settings.defaultPreset;
    if (lbl) lbl.textContent = `デフォルト: ${settings.defaultPreset}`;
    rebuildSelect();
  }

  // =========================================================
  //  起動
  // =========================================================
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

  setTimeout(tryInit, 500);
  setTimeout(tryInit, 2000);
})();
