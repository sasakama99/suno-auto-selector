// ==UserScript==
// @name         Suno AutoFill（プリセット自動入力）
// @namespace    https://github.com/sasakama99/suno-auto-selector
// @version      3.20.0
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

  // React ハンドラを呼ぶ（値をそのまま渡す版 — ToggleGroup 用）
  function callReactHandlerRaw(el, value, eventNames = ['onValueChange', 'onChange']) {
    const key = reactKey(el);
    if (!key) return false;
    let f = el[key];
    while (f) {
      const props = f.memoizedProps || f.pendingProps || f;
      if (props) {
        for (const ev of eventNames) {
          const h = props[ev];
          if (typeof h === 'function') {
            try { h(value); return true; } catch (e) {}
          }
        }
      }
      f = f.return;
    }
    return false;
  }

  // ボタンがアクティブ（選択済み）か判定（要素本体と親3段まで確認）
  function isButtonActive(el) {
    if (!el) return false;
    let depth = 0;
    for (let e = el; e && e !== document.body && depth <= 3; e = e.parentElement, depth++) {
      if (e.getAttribute('aria-pressed') === 'true') return true;
      const ds = e.getAttribute('data-state');
      if (ds === 'on' || ds === 'active' || ds === 'checked') return true;
      if (e.getAttribute('data-active') === 'true') return true;
      if (e.getAttribute('aria-selected') === 'true') return true;
      if (e.getAttribute('aria-checked') === 'true') return true;
      if (e.classList.contains('active') || e.classList.contains('selected')) return true;
    }
    return false;
  }

  // 確実にReactに反応するクリック（pointerdown → mousedown → ... → click）
  function realClick(el) {
    if (!el) return false;
    try {
      const txt = (el.textContent || '').trim().slice(0, 30);
      console.log(`[SunoAutoFill] realClick: <${el.tagName}> "${txt}"`);
      el.scrollIntoView?.({ block: 'center' });
      el.focus?.();
      el.click(); // ネイティブクリックのみ（PointerEvent不使用 → Radixクラッシュ回避）
      return true;
    } catch (e) { return false; }
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

  // execCommand('insertText') 経由でテキスト設定（React の合成イベントに確実に通知）
  function setTextByExecCommand(el, value) {
    if (!el) return false;
    try {
      el.focus();
      // 全選択してから挿入（textarea / contenteditable 両対応）
      if (el.select) el.select();
      else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const ok = document.execCommand('insertText', false, value);
      if (!ok) {
        // execCommand が無効な環境: native setter にフォールバック
        setNativeValue(el, value);
      }
      return true;
    } catch (e) { return false; }
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

  // ラベル要素の近傍でボタンを探す（親探索を狭く）
  function findButtonNearLabel(labelText, btnText) {
    const ln = norm(labelText);
    const panel = document.getElementById('suno-af-panel');

    // ラベル要素（直接テキストノードに labelText を含む短い要素）
    let labelEl = null;
    for (const el of document.querySelectorAll('div, span, label, p, h1, h2, h3, h4')) {
      if (panel && panel.contains(el)) continue;
      let directText = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) directText += node.textContent;
      }
      const dt = norm(directText);
      if (dt === ln || dt.startsWith(ln)) {
        labelEl = el;
        break;
      }
    }

    if (labelEl) {
      // 親を3段階以内に絞る（広すぎ防止）
      let p = labelEl.parentElement;
      for (let i = 0; i < 3; i++) {
        if (!p || (panel && panel.contains(p))) break;
        const found = findClickable(btnText, p);
        if (found) {
          console.log(`[SunoAutoFill] findButtonNearLabel "${labelText}" → "${btnText}" found at depth ${i}`);
          return found;
        }
        p = p.parentElement;
      }
      console.log(`[SunoAutoFill] findButtonNearLabel "${labelText}" → "${btnText}" 近傍で見つからず`);
    } else {
      console.log(`[SunoAutoFill] findButtonNearLabel ラベル "${labelText}" 未検出`);
    }
    return null;
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
  //  優先順: ①トラッククリック ②ドラッグシミュレーション
  //         ③React fiber直呼び ④キーボード
  // =========================================================
  async function setSlider(labelText, percent) {
    // スライダーは合成イベントでは操作不可（Radix setPointerCapture クラッシュ）
    // → Chrome拡張版で対応。Tampermonkey版ではスキップ。
    console.log(`[SunoAutoFill] setSlider "${labelText}" (${percent}%): スキップ（Chrome拡張で操作してください）`);
    return { ok: false, method: 'skip' };

    // --- 以下は参考用（使用停止） ---
    const ln = norm(labelText);
    const panel = document.getElementById('suno-af-panel');

    // Radix Slider のサムを探す（重複除去・オーディオ除外）
    const allThumbs = [...new Set([
      ...document.querySelectorAll('[data-radix-slider-thumb]'),
      ...document.querySelectorAll('[role="slider"]')
    ])].filter(el => {
      if (panel && panel.contains(el)) return false;
      const label = norm(el.getAttribute('aria-label') || '');
      if (/seek|time|audio|progress|volume/.test(label)) return false;
      return true;
    });

    console.log(`[SunoAutoFill] setSlider "${labelText}": ${allThumbs.length}個のサム検出`);
    allThumbs.forEach((el, i) => {
      const rootEl = el.closest('[data-radix-slider-root]') || el.parentElement;
      console.log(`  [${i}] valuenow=${el.getAttribute('aria-valuenow')} label="${el.getAttribute('aria-label')}" parentText="${(rootEl?.textContent||'').trim().slice(0,60)}"`);
    });

    // ラベルマッチでサムを特定
    let thumb = null;
    for (const el of allThumbs) {
      for (let p = el.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
        if ((p.textContent||'').length < 300 && norm(p.textContent||'').includes(ln)) {
          thumb = el; break;
        }
      }
      if (thumb) break;
    }
    // 位置ベースフォールバック
    if (!thumb) {
      if (ln.includes('weird') && allThumbs[0]) thumb = allThumbs[0];
      else if ((ln.includes('style') || ln.includes('influence')) && allThumbs[1]) thumb = allThumbs[1];
    }

    if (!thumb) {
      console.log(`[SunoAutoFill] setSlider: サム未検出 "${labelText}"`);
      return { ok: false, method: 'no-thumb' };
    }

    const beforeVal = parseInt(thumb.getAttribute('aria-valuenow') ?? '50');
    console.log(`[SunoAutoFill] setSlider "${labelText}": target=${percent}, current=${beforeVal}`);

    // キー送信ヘルパー（sleep(16)でReact 18バッチング回避）
    const sendKeys = async (fromVal) => {
      const delta = percent - fromVal;
      if (delta === 0) return fromVal;
      const key  = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
      const code = delta > 0 ? 39 : 37;
      thumb.setAttribute('tabindex', '0');
      thumb.focus();
      await sleep(60);
      for (let i = 0; i < Math.abs(delta); i++) {
        thumb.dispatchEvent(new KeyboardEvent('keydown', {
          key, keyCode: code, code: key, bubbles: true, cancelable: true, composed: true
        }));
        thumb.dispatchEvent(new KeyboardEvent('keyup', {
          key, keyCode: code, code: key, bubbles: true, cancelable: true, composed: true
        }));
        await sleep(16); // React 18バッチング対策: 1フレームごとにflush
      }
      await sleep(100);
      return parseInt(thumb.getAttribute('aria-valuenow') ?? '-1');
    };

    // 方法①: 現在値から目標値へキーボードで直接移動（sleep(16)で1ステップずつ）
    const r1 = await sendKeys(beforeVal);
    console.log(`[SunoAutoFill] keyboard: target=${percent}, result=${r1}`);
    if (r1 >= 0 && Math.abs(r1 - percent) <= 3) return { ok: true, method: `key→${r1}` };

    // 方法②: Home で 0 に戻してから ArrowRight × percent
    thumb.focus();
    await sleep(40);
    thumb.dispatchEvent(new KeyboardEvent('keydown', { key:'Home', keyCode:36, code:'Home', bubbles:true, cancelable:true, composed:true }));
    thumb.dispatchEvent(new KeyboardEvent('keyup',   { key:'Home', keyCode:36, code:'Home', bubbles:true, cancelable:true, composed:true }));
    await sleep(100);
    const atZero = parseInt(thumb.getAttribute('aria-valuenow') ?? '-1');
    console.log(`[SunoAutoFill] Home後: atZero=${atZero}`);
    if (atZero >= 0 && atZero !== beforeVal) {
      const r2 = await sendKeys(atZero);
      console.log(`[SunoAutoFill] Home+key: target=${percent}, result=${r2}`);
      if (r2 >= 0 && Math.abs(r2 - percent) <= 3) return { ok: true, method: `home+key→${r2}` };
    }

    // 方法③: React fiber の onValueChange を直接呼ぶ（ポインターイベント不使用）
    const sliderRoot = thumb.closest('[data-radix-slider-root]') || thumb.parentElement;
    for (let el = sliderRoot; el && el !== document.body; el = el.parentElement) {
      const rk = reactKey(el);
      if (!rk) continue;
      let f = el[rk];
      while (f) {
        const props = f.memoizedProps || f.pendingProps;
        if (props) {
          const h = props.onValueChange || props.onValueCommit;
          if (typeof h === 'function') {
            try {
              h([percent]);
              await sleep(200);
              const after = parseInt(thumb.getAttribute('aria-valuenow') ?? '-1');
              console.log(`[SunoAutoFill] fiber: target=${percent}, after=${after}`);
              if (after >= 0 && Math.abs(after - percent) <= 3) return { ok: true, method: `fiber→${after}` };
            } catch(e) {}
          }
        }
        f = f.return;
      }
    }

    const finalVal = parseInt(thumb.getAttribute('aria-valuenow') ?? '-1');
    console.log(`[SunoAutoFill] 全方法失敗: target=${percent}, final=${finalVal}`);
    return { ok: false, method: `failed(got:${finalVal})` };
  }

  // ① トラックの目標位置を直接クリック（Radixのtrack-clickで値を設定）
  // Radix は「root に pointerdown を受け取り、track の rect で位置→値を計算」する
  async function setSliderByTrackClick(thumb, percent) {
    try {
      const root = thumb.closest('[data-radix-slider-root]') || thumb.parentElement;
      // Radix が内部で参照するトラック要素を特定
      const track = root?.querySelector('[data-radix-slider-track]')
                 || root?.querySelector('[data-orientation="horizontal"]:not([data-radix-slider-thumb])')
                 || root;

      const trackRect = track.getBoundingClientRect();
      if (trackRect.width === 0) return false;

      // Radix の値計算式: value = (clientX - trackLeft) / trackWidth * 100
      // → target percent のための clientX = trackLeft + trackWidth * (percent/100)
      const x = trackRect.left + trackRect.width * (percent / 100);
      const y  = trackRect.top + trackRect.height / 2;

      console.log(`[SunoAutoFill] track-click: target=${percent}%, x=${x.toFixed(1)}, trackL=${trackRect.left.toFixed(1)}, trackW=${trackRect.width.toFixed(1)}`);

      // pointerdown は ROOT に送る（Radix のハンドラが root に付いている）
      const pDown = (btns) => new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: btns
      });
      const pUp = (btns) => new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: btns
      });
      const pMove = (btns) => new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: btns
      });

      root.dispatchEvent(pDown(1));
      await sleep(30);
      root.dispatchEvent(pMove(1));
      await sleep(20);
      root.dispatchEvent(pUp(0));
      document.dispatchEvent(pUp(0)); // キャプチャされた場合の保険

      // 値がずれていたら、実際のマッピングから補正して再クリック
      await sleep(100);
      const after1 = parseInt(thumb.getAttribute('aria-valuenow') ?? '-1');
      if (after1 >= 0 && after1 !== percent && Math.abs(after1 - percent) > 3) {
        // after1 = (x - trackLeft) / trackWidth * 100  だったはずが after1 になった
        // → 実際の有効幅を逆算して補正
        const currentX = x;
        // Radixが使っているのはtrack幅と異なる可能性 → 補正係数を計算
        // after1 = (currentX - trackLeft) / effectiveWidth * 100
        const effectiveWidth = (currentX - trackRect.left) / (after1 / 100);
        const correctedX = trackRect.left + effectiveWidth * (percent / 100);
        console.log(`[SunoAutoFill] adaptive: after1=${after1}, effectiveW=${effectiveWidth.toFixed(1)}, corrX=${correctedX.toFixed(1)}`);

        const mkP = (type, cx, btns) => new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: cx, clientY: y,
          pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: btns
        });
        root.dispatchEvent(mkP('pointerdown', correctedX, 1));
        await sleep(30);
        root.dispatchEvent(mkP('pointermove', correctedX, 1));
        await sleep(20);
        root.dispatchEvent(mkP('pointerup',   correctedX, 0));
        document.dispatchEvent(mkP('pointerup', correctedX, 0));
      }

      return true;
    } catch(e) {
      console.log('[SunoAutoFill] track-click error:', e);
      return false;
    }
  }

  // ② サムを現在位置から目標位置まで段階的にドラッグ
  async function setSliderByDrag(thumb, percent) {
    try {
      const thumbRect = thumb.getBoundingClientRect();
      if (thumbRect.width === 0) return false;

      const root  = thumb.closest('[data-radix-slider-root]') || thumb.parentElement;
      const track = root?.querySelector('[data-radix-slider-track]') || root;
      const trackRect = track.getBoundingClientRect();
      if (trackRect.width === 0) return false;

      const startX = thumbRect.left + thumbRect.width / 2;
      const startY = thumbRect.top  + thumbRect.height / 2;
      const targetX = trackRect.left + trackRect.width * (percent / 100);
      const steps = 8; // ドラッグのステップ数

      const po = (x, y, btns) => new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: btns
      });
      const mo = (x, y, btns) => new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: btns
      });

      // pointerdown は root に送る（Radixのハンドラはrootに付いている）
      const pdOpts = {
        bubbles: true, cancelable: true, composed: true,
        clientX: startX, clientY: startY,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1
      };
      root.dispatchEvent(new PointerEvent('pointerdown', pdOpts));
      await sleep(30);

      // pointermove - root と document に段階的に送る
      for (let i = 1; i <= steps; i++) {
        const x = startX + (targetX - startX) * (i / steps);
        root.dispatchEvent(po(x, startY, 1));
        root.dispatchEvent(mo(x, startY, 1));
        document.dispatchEvent(po(x, startY, 1));
        document.dispatchEvent(mo(x, startY, 1));
        await sleep(12);
      }

      // pointerup - root と document に送る
      const puOpts = {
        bubbles: true, cancelable: true, composed: true,
        clientX: targetX, clientY: startY,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0
      };
      root.dispatchEvent(new PointerEvent('pointerup', puOpts));
      document.dispatchEvent(new PointerEvent('pointerup', puOpts));
      document.dispatchEvent(new MouseEvent('mouseup', { ...puOpts }));

      return true;
    } catch(e) {
      console.log('[SunoAutoFill] drag error:', e);
      return false;
    }
  }

  // サムを現在位置からターゲット位置までドラッグするシミュレーション
  async function dragSliderThumb(thumb, percent) {
    try {
      const thumbRect = thumb.getBoundingClientRect();
      if (thumbRect.width === 0 && thumbRect.height === 0) return false;

      // トラック（ルート）を探す
      let root = thumb;
      for (let i = 0; i < 8; i++) {
        if (!root.parentElement) break;
        root = root.parentElement;
        const r = root.getBoundingClientRect();
        if (r.width > 100 && r.height < 80) break;
      }
      const rootRect = root.getBoundingClientRect();
      if (rootRect.width === 0) return false;

      const startX = thumbRect.left + thumbRect.width / 2;
      const startY = thumbRect.top + thumbRect.height / 2;
      const targetX = rootRect.left + rootRect.width * (percent / 100);
      const targetY = startY;

      const mkOpts = (x, y, btns) => ({
        bubbles: true, cancelable: true,
        clientX: x, clientY: y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: btns
      });

      // pointerdown on thumb
      thumb.dispatchEvent(new PointerEvent('pointerdown', mkOpts(startX, startY, 1)));
      thumb.dispatchEvent(new MouseEvent('mousedown',     mkOpts(startX, startY, 1)));
      await sleep(30);

      // pointermove to target (thumb → track root → document)
      const moveOpts = mkOpts(targetX, targetY, 1);
      thumb.dispatchEvent(new PointerEvent('pointermove', moveOpts));
      root.dispatchEvent(new PointerEvent('pointermove',  moveOpts));
      document.dispatchEvent(new PointerEvent('pointermove', moveOpts));
      document.dispatchEvent(new MouseEvent('mousemove',     moveOpts));
      await sleep(30);

      // pointerup
      document.dispatchEvent(new PointerEvent('pointerup', mkOpts(targetX, targetY, 0)));
      document.dispatchEvent(new MouseEvent('mouseup',      mkOpts(targetX, targetY, 0)));
      return true;
    } catch (e) {
      console.log('[SunoAutoFill] dragSliderThumb error:', e);
      return false;
    }
  }

  // キーボード移動（Home→0→ArrowRight×N の絶対移動方式）
  async function setRadixSliderRelative(thumb, percent) {
    try {
      // tabindex がなければ追加してフォーカス可能にする
      if (!thumb.hasAttribute('tabindex')) thumb.setAttribute('tabindex', '0');
      // click() → focus() の順でブラウザフォーカスを確実に当てる
      thumb.click();
      thumb.focus();
      await sleep(80);

      const kd = (key, keyCode) => new KeyboardEvent('keydown', { key, keyCode, which: keyCode, bubbles: true, cancelable: true });
      const ku = (key, keyCode) => new KeyboardEvent('keyup',   { key, keyCode, which: keyCode, bubbles: true, cancelable: true });

      // Home キーで 0 に戻す
      const before = parseInt(thumb.getAttribute('aria-valuenow') ?? '50');
      thumb.dispatchEvent(kd('Home', 36));
      thumb.dispatchEvent(ku('Home', 36));
      await sleep(60);
      const atZero = parseInt(thumb.getAttribute('aria-valuenow') ?? before.toString());
      const homeWorked = atZero !== before || before === 0;
      console.log(`[SunoAutoFill] keyboard: before=${before}, atZero=${atZero}, homeWorked=${homeWorked}`);

      if (homeWorked) {
        // 絶対移動: 0 → percent 回 ArrowRight（sleep(16)でReact batching回避）
        for (let i = 0; i < percent; i++) {
          thumb.dispatchEvent(kd('ArrowRight', 39));
          thumb.dispatchEvent(ku('ArrowRight', 39));
          await sleep(16);
        }
      } else {
        // Home が効かなかった → 現在値から相対移動（sleep(16)でReact batching回避）
        const delta = percent - before;
        if (delta === 0) return true;
        const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
        const code = delta > 0 ? 39 : 37;
        for (let i = 0; i < Math.abs(delta); i++) {
          thumb.dispatchEvent(kd(key, code));
          thumb.dispatchEvent(ku(key, code));
          await sleep(16);
        }
      }

      await sleep(100);
      const after = parseInt(thumb.getAttribute('aria-valuenow') ?? '-1');
      console.log(`[SunoAutoFill] keyboard-abs: target=${percent}, after=${after}`);
      return after >= 0 && Math.abs(after - percent) <= 2;
    } catch (e) { return false; }
  }

  // 方法1: Home で 0 に戻してから ArrowRight 連打（Radix UI で最も確実）
  function setRadixSliderByKeyboard(thumb, target) {
    try {
      thumb.focus();

      // Home で最小値に戻す
      thumb.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Home', code: 'Home', keyCode: 36, which: 36,
        bubbles: true, cancelable: true
      }));
      thumb.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Home', code: 'Home', keyCode: 36, which: 36,
        bubbles: true, cancelable: true
      }));

      // target回 ArrowRight を keydown+keyup ペアで押す
      for (let i = 0; i < target; i++) {
        thumb.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39,
          bubbles: true, cancelable: true
        }));
        thumb.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39,
          bubbles: true, cancelable: true
        }));
      }

      const after = parseInt(thumb.getAttribute('aria-valuenow') || '0');
      console.log(`[SunoAutoFill] Slider keyboard: target=${target}, after=${after}`);
      return Math.abs(after - target) <= 1;
    } catch (e) { return false; }
  }

  // 方法2: スライダートラック要素にポインターイベントを送る
  function setRadixSliderByTrackPointer(thumb, percent) {
    try {
      // スライダーのルート要素（横長コンテナ）を探す
      let root = thumb;
      for (let i = 0; i < 8; i++) {
        if (!root.parentElement) break;
        root = root.parentElement;
        const r = root.getBoundingClientRect();
        if (r.width > 100 && r.height < 80) break;
      }

      // トラック候補: data-radix-slider-track → data-orientation → サイズ推定
      let track = root.querySelector('[data-radix-slider-track]')
                || root.querySelector('[data-orientation="horizontal"]')
                || null;
      if (!track) {
        for (const el of root.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width > 100 && r.height > 0 && r.height < 30) { track = el; break; }
        }
      }
      if (!track) track = root;

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

      // pointerdown → pointermove → pointerup をトラックと document 両方に送る
      track.dispatchEvent(new PointerEvent('pointerdown', opts));
      track.dispatchEvent(new MouseEvent('mousedown', opts));
      track.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 1 }));
      document.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 1 }));
      document.dispatchEvent(new MouseEvent('mousemove', { ...opts, buttons: 1 }));
      track.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      document.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      document.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));

      return true; // aria-valuenow の確認は呼び出し元で行う
    } catch (e) {
      console.log('[SunoAutoFill] setRadixSliderByTrackPointer error:', e);
      return false;
    }
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
  //  バージョン選択（Radix Portal + data属性対応）
  // =========================================================
  function versionMatch(text, ver) {
    const t = norm(text).replace('✓', '').trim();
    const v = norm(ver);
    return t === v || t.startsWith(v + ' ') || t.startsWith(v + ' pro');
  }

  async function setVersion(ver) {
    if (!ver || ver === 'none') return { ok: true, method: 'skip' };
    const panel = document.getElementById('suno-af-panel');

    function diagnoseDropdown() {
      const matches = [];
      for (const el of document.body.querySelectorAll('*')) {
        if (panel && panel.contains(el)) continue;
        if (el.children.length > 8) continue;
        const t = (el.textContent || '').trim();
        if (!/^v\d/i.test(t)) continue;
        if (t.length > 150) continue;
        if (!isVisible(el)) continue;
        matches.push({
          tag: el.tagName,
          role: el.getAttribute('role'),
          dataValue: el.getAttribute('data-value'),
          dataRadix: el.hasAttribute('data-radix-collection-item'),
          dataState: el.getAttribute('data-state'),
          ariaHasPopup: el.getAttribute('aria-haspopup'),
          ariaSelected: el.getAttribute('aria-selected'),
          text: t.slice(0, 60),
          cls: (el.className || '').toString().slice(0, 60)
        });
      }
      console.log(`[SunoAutoFill] ドロップダウン候補数:${matches.length}`);
      // 最初の10個を1行ずつ詳細出力
      matches.slice(0, 10).forEach((m, i) => {
        console.log(`  [${i}] <${m.tag}> role="${m.role}" dataValue="${m.dataValue}" dataRadix=${m.dataRadix} text="${m.text}" cls="${m.cls}"`);
      });
      return matches;
    }

    function clickItem(skipEl) {
      // 候補を全部集めてから「面積が最小（=リーフ要素）」を選ぶ方式
      const candidates = [];

      for (const el of document.body.querySelectorAll('*')) {
        if (panel && panel.contains(el)) continue;
        if (el === skipEl) continue;
        if (el.tagName === 'HTML' || el.tagName === 'BODY') continue;
        if (el.children.length > 8) continue;
        if (el.hasAttribute('aria-haspopup')) continue; // トリガー除外
        if (!versionMatch(el.textContent, ver)) continue;
        if (!isVisible(el)) continue;
        const style = getComputedStyle(el);
        if (style.pointerEvents === 'none') continue;

        const rect = el.getBoundingClientRect();
        candidates.push({
          el,
          area: rect.width * rect.height,
          hasDataValue: el.hasAttribute('data-value'),
          hasRole: !!el.getAttribute('role'),
          isRadixItem: el.hasAttribute('data-radix-collection-item') || el.hasAttribute('cmdk-item')
        });
      }

      if (candidates.length === 0) {
        diagnoseDropdown();
        return false;
      }

      // 優先度: data-value > radix-item > role > 最小面積
      candidates.sort((a, b) => {
        if (a.hasDataValue !== b.hasDataValue) return a.hasDataValue ? -1 : 1;
        if (a.isRadixItem !== b.isRadixItem) return a.isRadixItem ? -1 : 1;
        if (a.hasRole !== b.hasRole) return a.hasRole ? -1 : 1;
        return a.area - b.area; // 面積が小さい順
      });

      const best = candidates[0];
      realClick(best.el);
      console.log(`[SunoAutoFill] Version item クリック: <${best.el.tagName}> "${norm(best.el.textContent).slice(0, 60)}" (候補${candidates.length}個中)`);
      return true;
    }

    // ドロップダウントリガーを開く（パネル外限定）
    let triggerClicked = false;
    let triggerBtn = null;

    for (const btn of document.querySelectorAll('button, [role="combobox"]')) {
      if (panel && panel.contains(btn)) continue;
      const t = norm(btn.textContent);
      // Suno のバージョンボタン: 「v5」「v5 ▼」のような短いテキスト
      if (/^v[\d.]+/.test(t) && t.length < 15) {
        triggerBtn = btn;
        break;
      }
    }

    if (!triggerBtn) {
      console.log('[SunoAutoFill] Version trigger 未検出');
      return { ok: false, method: 'no-trigger' };
    }

    realClick(triggerBtn);
    console.log('[SunoAutoFill] Version trigger クリック:', norm(triggerBtn.textContent));
    triggerClicked = true;
    await sleep(700);

    diagnoseDropdown();

    if (clickItem(triggerBtn)) return { ok: true, method: 'trigger' };
    await sleep(600);
    if (clickItem(triggerBtn)) return { ok: true, method: 'trigger-late' };

    console.log('[SunoAutoFill] Version item を見つけられず');
    return { ok: false, method: 'no-item' };
  }

  // =========================================================
  //  More Options 展開判定 & 自動展開
  // =========================================================
  // 可視性チェック（自身のサイズ + 祖先の aria-hidden のみ。過剰検出を避ける）
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

    // 祖先のaria-hidden="true"だけチェック
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (p.getAttribute('aria-hidden') === 'true') return false;
      p = p.parentElement;
    }
    return true;
  }

  function findMoreOptionsButton() {
    const panel = document.getElementById('suno-af-panel');
    for (const btn of document.querySelectorAll('button, [role="button"], div, span, h3, h4, section')) {
      if (panel && panel.contains(btn)) continue;
      const t = norm(btn.textContent);
      if ((t === 'more options' || t.startsWith('more options')) && t.length < 25) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return btn;
      }
    }
    return null;
  }

  function findSongTitleInput() {
    const panel = document.getElementById('suno-af-panel');
    for (const inp of document.querySelectorAll('input')) {
      if (panel && panel.contains(inp)) continue;
      const ph = norm(inp.placeholder || '');
      if (ph.includes('song title') || ph.includes('title')) return inp;
    }
    return null;
  }

  function isMoreOptionsExpanded() {
    const panel = document.getElementById('suno-af-panel');

    // 【最優先1】aria-expanded 属性
    for (const btn of document.querySelectorAll('button, [role="button"], [aria-expanded]')) {
      if (panel && panel.contains(btn)) continue;
      const t = norm(btn.textContent);
      if ((t === 'more options' || t.startsWith('more options')) && t.length < 25) {
        const expanded = btn.getAttribute('aria-expanded');
        if (expanded === 'true') return true;
        if (expanded === 'false') return false;
      }
    }

    // 【最優先2】位置ベース判定: More Options ボタンと Song Title の距離
    const moBtn = findMoreOptionsButton();
    const titleInp = findSongTitleInput();
    if (moBtn && titleInp) {
      const moBottom = moBtn.getBoundingClientRect().bottom;
      const titleTop = titleInp.getBoundingClientRect().top;
      const gap = titleTop - moBottom;
      // 100px 以上の隙間があれば、間にコンテンツがある = 展開済み
      if (gap > 100) return true;
      if (gap < 60) return false;
      // 中間値はフォールバックへ
    }

    // フォールバック: Excludeインプットの可視性
    for (const el of document.querySelectorAll('input, textarea')) {
      if (panel && panel.contains(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const ph = norm(el.placeholder || el.getAttribute('aria-label') || '');
      if (ph.includes('exclude')) return true;
    }

    return false;
  }

  async function expandMoreOptions() {
    if (isMoreOptionsExpanded()) {
      console.log('[SunoAutoFill] More Options すでに展開済み');
      return true;
    }

    const panel = document.getElementById('suno-af-panel');
    const candidates = [];

    // "More Options" 候補要素を集める
    for (const el of document.querySelectorAll('button, [role="button"], div, section, h3, h4, span')) {
      if (panel && panel.contains(el)) continue;
      const t = norm(el.textContent);
      if ((t === 'more options' || t.startsWith('more options')) &&
          t.length < 25 && el.children.length <= 6) {
        if (isVisible(el)) candidates.push(el);
      }
    }

    console.log(`[SunoAutoFill] More Options 候補:${candidates.length}個`);
    candidates.slice(0, 5).forEach((c, i) => {
      console.log(`  [${i}] <${c.tagName}> "${(c.textContent || '').trim().slice(0, 30)}"`);
    });

    // 候補を順にクリック → 0.3秒×6回確認（最大1.8秒待つ）
    for (const target of candidates) {
      console.log(`[SunoAutoFill] More Options クリック試行: <${target.tagName}>`);
      realClick(target);
      for (let i = 0; i < 6; i++) {
        await sleep(300);
        if (isMoreOptionsExpanded()) {
          console.log(`[SunoAutoFill] 展開成功 (${(i+1)*300}ms後)`);
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

    // 全クリックを監視（パネル内は除外）
    const clickLog = [];
    const panelEl = document.getElementById('suno-af-panel');
    const clickListener = (e) => {
      // パネル内のクリックは無視
      if (panelEl && panelEl.contains(e.target)) return;
      const t = (e.target?.textContent || '').trim().slice(0, 40);
      const tag = e.target?.tagName;
      const expanded = isMoreOptionsExpanded();
      clickLog.push(`<${tag}> "${t}" [MoreOpt=${expanded ? 'OPEN' : 'CLOSED'}]`);
    };
    document.addEventListener('click', clickListener, true);

    // More Options を自動展開（閉じている場合のみ）
    const expanded = await expandMoreOptions();
    results.push(['MoreOptions展開', expanded]);
    console.log(`[SunoAutoFill] applyPreset 開始時 MoreOpt=${expanded ? 'OPEN' : 'CLOSED'}`);

    // === Lyrics: execCommand優先（Reactの合成イベントに確実に通知） ===
    const sunoTextareas = getSunoTextareas();
    let lyrics = findByPlaceholder(['lyrics', 'instrumental', 'enter', 'add', 'write'], 'textarea');
    if (!lyrics && sunoTextareas.length >= 1) lyrics = sunoTextareas[0];
    console.log('[SunoAutoFill] Lyrics target:', lyrics?.placeholder, lyrics);
    if (lyrics) {
      setTextByExecCommand(lyrics, p.lyrics || '');
      await sleep(80);
      // execCommand 後に値が反映されていなければ native setter で補完
      if (lyrics.value !== (p.lyrics || '')) setNativeValue(lyrics, p.lyrics || '');
      results.push(['Lyrics', true]);
    } else {
      results.push(['Lyrics', false]);
    }

    // === Styles: execCommand優先 ===
    let styles = findByPlaceholder(['style', 'genre', 'mood', 'musical'], 'textarea');
    if (!styles && sunoTextareas.length >= 2) styles = sunoTextareas[1];
    console.log('[SunoAutoFill] Styles target:', styles?.placeholder, styles);
    if (styles) {
      setTextByExecCommand(styles, p.styles || '');
      await sleep(80);
      if (styles.value !== (p.styles || '')) setNativeValue(styles, p.styles || '');
      results.push(['Styles', true]);
    } else {
      results.push(['Styles', false]);
    }

    // Exclude（More Options が展開されていないと無い）
    const exclude = findByPlaceholder(['exclude'], 'input');
    if (p.excludeStyles) {
      results.push(['Exclude', exclude ? setNativeValue(exclude, p.excludeStyles) : false]);
    }

    // Title
    const title = findByPlaceholder(['song title', 'title'], 'input');
    results.push(['Title',   title ? setNativeValue(title, p.songTitle || '') : false]);

    // ボタン系（realClick で確実に反応させる）
    if (p.vocalGender === 'none') {
      const maleBtn   = findButtonNearLabel('Vocal Gender', 'Male');
      const femaleBtn = findButtonNearLabel('Vocal Gender', 'Female');
      let cleared = false;

      // 方法①: 背景色比較（Sunoはアクティブボタンを明るい背景で表示）
      if (maleBtn && femaleBtn) {
        const bgOf = el => {
          // 要素本体と親3段まで確認して実際に色がついている要素の輝度を返す
          for (let e = el; e && e !== document.body; e = e.parentElement) {
            const bg = window.getComputedStyle(e).backgroundColor;
            const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (m) {
              const brightness = parseInt(m[1]) + parseInt(m[2]) + parseInt(m[3]);
              if (brightness > 30) return brightness; // 完全な黒/透明でなければ採用
            }
          }
          return 0;
        };
        const maleBright   = bgOf(maleBtn);
        const femaleBright = bgOf(femaleBtn);
        console.log(`[SunoAutoFill] VocalGender brightness: male=${maleBright}, female=${femaleBright}`);
        if (maleBright > femaleBright + 20) {
          realClick(maleBtn); cleared = true;
        } else if (femaleBright > maleBright + 20) {
          realClick(femaleBtn); cleared = true;
        }
      }

      // 方法②: DOM属性チェック（フォールバック）
      if (!cleared) {
        for (const b of [maleBtn, femaleBtn]) {
          if (b && isButtonActive(b)) { realClick(b); cleared = true; break; }
        }
      }

      // 方法③: React fiber で ToggleGroup をリセット
      if (!cleared) {
        for (const b of [maleBtn, femaleBtn]) {
          if (!b) continue;
          for (let el = b; el && el !== document.body; el = el.parentElement) {
            if (callReactHandlerRaw(el, '', ['onValueChange'])) { cleared = true; break; }
          }
          if (cleared) break;
        }
      }
      results.push(['VocalGender→none', cleared]);
    } else if (p.vocalGender === 'male') {
      const b = findButtonNearLabel('Vocal Gender', 'Male');
      results.push(['Male',   b ? realClick(b) : false]);
    } else if (p.vocalGender === 'female') {
      const b = findButtonNearLabel('Vocal Gender', 'Female');
      results.push(['Female', b ? realClick(b) : false]);
    }

    if (p.lyricsMode === 'manual') {
      const b = findButtonNearLabel('Lyrics Mode', 'Manual');
      results.push(['Manual', b ? realClick(b) : false]);
    } else if (p.lyricsMode === 'auto') {
      const b = findButtonNearLabel('Lyrics Mode', 'Auto');
      results.push(['Auto',   b ? realClick(b) : false]);
    }

    // スライダー（スキップ — Chrome拡張で対応）
    const needSlider = (p.weirdness !== undefined && p.weirdness !== 50) ||
                       (p.styleInfluence !== undefined && p.styleInfluence !== 50);
    if (needSlider) {
      const w = p.weirdness ?? 50;
      const s = p.styleInfluence ?? 50;
      showToast(`🎚️ スライダーは手動で設定してください\nWeirdness: ${w}%　Style Influence: ${s}%`, 5000);
    }
    if (p.weirdness !== undefined) results.push([`Weirdness(skip)`, false]);
    if (p.styleInfluence !== undefined) results.push([`Influence(skip)`, false]);

    // バージョン
    if (p.version && p.version !== 'none') {
      const r = await setVersion(p.version);
      results.push([`Version(${r.method})`, r.ok]);
    }

    // 適用後の状態（再展開はしない、ボタンクリックでkeepOpenがやる）
    const finalState = isMoreOptionsExpanded();
    console.log(`[SunoAutoFill] applyPreset 終了時 MoreOpt=${finalState ? 'OPEN' : 'CLOSED'}`);

    // クリック監視を解除して全クリックを表示
    document.removeEventListener('click', clickListener, true);
    console.log('[SunoAutoFill] 適用中の全クリック:', clickLog);

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

  // More Options が閉じてしまったら最大1回だけ慎重に再展開
  let keepOpenTimer = null;
  function keepMoreOptionsOpen() {
    // 連打防止：3秒待ってから1回だけチェック・再展開
    if (keepOpenTimer) clearTimeout(keepOpenTimer);
    keepOpenTimer = setTimeout(async () => {
      const moBtn = findMoreOptionsButton();
      const titleInp = findSongTitleInput();
      if (moBtn && titleInp) {
        const moBottom = moBtn.getBoundingClientRect().bottom;
        const titleTop = titleInp.getBoundingClientRect().top;
        const gap = titleTop - moBottom;
        console.log(`[SunoAutoFill] keepOpen診断: gap=${gap.toFixed(0)}px, expanded=${isMoreOptionsExpanded()}`);
      }
      if (!isMoreOptionsExpanded()) {
        console.log('[SunoAutoFill] keepOpen: 1回だけ再展開試行');
        await expandMoreOptions();
      } else {
        console.log('[SunoAutoFill] keepOpen: 既に開いてるので何もしない');
      }
    }, 3000);
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
      #suno-af-panel { position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999998;width:310px;
        background:rgba(13,13,13,.98);border:1px solid #2a2a2a;border-radius:14px;
        box-shadow:0 8px 32px rgba(0,0,0,.8);
        font-family:-apple-system,"Hiragino Sans",sans-serif;color:#e0e0e0;font-size:13px;}
      #suno-af-panel * { box-sizing:border-box; }
      #suno-af-panel .af-hd { display:flex;align-items:center;justify-content:space-between;
        padding:11px 14px 9px;background:#111;border-bottom:1px solid #222;
        border-radius:14px 14px 0 0;cursor:grab; }
      #suno-af-panel .af-hd.dragging { cursor:grabbing; }
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
        <button class="af-iconbtn" id="af-update" title="スクリプトを更新（Tampermonkey）">🔄</button>
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
    document.getElementById('af-update').onclick = () => {
      window.open('https://raw.githubusercontent.com/sasakama99/suno-auto-selector/main/suno-autofill.user.js', '_blank');
    };

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

    document.getElementById('af-apply').onclick = async () => {
      collectForm(currentPreset);
      const p = settings.presets[currentPreset];
      const hasMoreOptionsData = !!(p.excludeStyles || p.vocalGender !== 'none' ||
        p.lyricsMode || p.weirdness !== undefined || p.styleInfluence !== undefined);

      await applyPreset(currentPreset);

      // 3秒後に1回だけチェックして閉じてたら開く（連打しない）
      if (hasMoreOptionsData) {
        keepMoreOptionsOpen();
      }
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

    // ドラッグ移動
    const hd = panel.querySelector('.af-hd');
    let _drag = false, _dx = 0, _dy = 0;
    hd.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      _drag = true;
      const r = panel.getBoundingClientRect();
      _dx = e.clientX - r.left;
      _dy = e.clientY - r.top;
      hd.classList.add('dragging');
      panel.style.transform = '';
      panel.style.left = r.left + 'px';
      panel.style.top  = r.top  + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!_drag) return;
      panel.style.left = (e.clientX - _dx) + 'px';
      panel.style.top  = (e.clientY - _dy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!_drag) return;
      _drag = false;
      hd.classList.remove('dragging');
    });

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
