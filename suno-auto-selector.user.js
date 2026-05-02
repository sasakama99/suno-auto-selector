// ==UserScript==
// @name         Suno AI Auto Selector by Title (集計版)
// @namespace    https://github.com/sasakama99/suno-auto-selector
// @version      1.0.4
// @description  タイトルを入力するだけで完全一致する曲を自動選択し、曲数と合計時間を集計
// @author       ハリたっく
// @match        https://suno.com/*
// @grant        none
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/sasakama99/suno-auto-selector/main/suno-auto-selector.user.js
// @downloadURL  https://raw.githubusercontent.com/sasakama99/suno-auto-selector/main/suno-auto-selector.user.js
// @supportURL   https://github.com/sasakama99/suno-auto-selector/issues
// ==/UserScript==

(function () {
    'use strict';

    let targetTitles = [];
    const matchedSongs = new Map();

    const style = document.createElement('style');
    style.textContent = `
        [data-testid="clip-row"].suno-auto-selected {
            border-left: 3px solid #ffb84d !important;
            background: rgba(255, 184, 77, 0.10) !important;
        }
        #suno-auto-panel {
            position: fixed !important;
            top: 370px !important;
            left: 8px !important;
            right: auto !important;
            width: 196px !important;
            max-width: 196px !important;
            box-sizing: border-box !important;
            overflow: hidden !important;
        }
        #suno-auto-panel * {
            box-sizing: border-box !important;
            max-width: 100% !important;
        }
        #suno-auto-panel input::placeholder,
        #suno-auto-panel textarea::placeholder {
            color: #666;
        }
    `;
    document.head.appendChild(style);

    function createPanel() {
        if (document.getElementById('suno-auto-panel')) return; // 重複防止
        const panel = document.createElement('div');
        panel.id = 'suno-auto-panel';
        panel.style.cssText = `
            position: fixed; top: 370px; left: 8px; z-index: 9999998;
            background: rgba(18, 18, 18, 0.97);
            border: 1px solid #555; border-radius: 12px;
            padding: 10px 12px; width: 196px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.7);
            font-family: -apple-system, "Hiragino Sans", sans-serif;
            color: #eee;
            user-select: none;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 0;
        `;

        const title = document.createElement('div');
        title.textContent = '🎯 タイトル自動選択';
        title.style.cssText = 'font-weight: 600; font-size: 13px; color: #ffb84d;';
        header.appendChild(title);

        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = '▲';
        toggleBtn.style.cssText = `
            background: transparent; border: none; color: #aaa;
            cursor: pointer; font-size: 11px; padding: 2px 4px;
        `;
        // デフォルトは閉じた状態
        let collapsed = true;
        toggleBtn.onclick = () => {
            collapsed = !collapsed;
            body.style.display = collapsed ? 'none' : 'block';
            header.style.marginBottom = collapsed ? '0' : '10px';
            toggleBtn.textContent = collapsed ? '▲' : '▼';
        };
        header.appendChild(toggleBtn);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.style.display = 'none'; // 最初は閉じた状態

        const desc = document.createElement('div');
        desc.style.cssText = `
            font-size: 11px; color: #888; margin-bottom: 8px; line-height: 1.5;
        `;
        desc.innerHTML = '改行 or カンマ区切りでタイトル入力<br>完全一致する曲を自動選択';
        body.appendChild(desc);

        const textarea = document.createElement('textarea');
        textarea.id = 'suno-auto-input';
        textarea.placeholder = 'ジャズ1\nジャズ2';
        textarea.rows = 3;
        textarea.style.cssText = `
            width: 100%; box-sizing: border-box;
            background: #1a1a1a; color: #eee;
            border: 1px solid #444; border-radius: 6px;
            padding: 8px; font-size: 13px; resize: vertical;
            font-family: inherit; outline: none;
        `;
        textarea.addEventListener('input', onInputChange);
        textarea.addEventListener('focus', () => textarea.style.borderColor = '#ffb84d');
        textarea.addEventListener('blur', () => textarea.style.borderColor = '#444');
        body.appendChild(textarea);

        const result = document.createElement('div');
        result.id = 'suno-auto-result';
        result.style.cssText = `
            margin-top: 10px; padding: 10px;
            background: rgba(255, 184, 77, 0.08);
            border: 1px solid #555; border-radius: 6px;
            font-size: 13px; text-align: center; color: #888;
            transition: all 0.2s;
        `;
        result.textContent = '待機中';
        body.appendChild(result);

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'クリア';
        clearBtn.style.cssText = `
            margin-top: 8px; width: 100%;
            background: rgba(255, 80, 80, 0.15); color: #f66;
            border: 1px solid #f66; border-radius: 6px;
            padding: 6px; font-size: 12px; font-weight: bold;
            cursor: pointer;
        `;
        clearBtn.onclick = () => {
            textarea.value = '';
            onInputChange();
        };
        body.appendChild(clearBtn);

        panel.appendChild(body);
        document.body.appendChild(panel);
    }

    let inputDebounceTimer = null;
    function onInputChange() {
        clearTimeout(inputDebounceTimer);
        inputDebounceTimer = setTimeout(() => {
            const raw = document.getElementById('suno-auto-input').value;
            targetTitles = raw
                .split(/[\n,、]/)
                .map(s => s.trim())
                .filter(s => s.length > 0);
            applySelection();
        }, 300);
    }

    function extractSongInfo(row) {
        const link = row.querySelector('a[href*="/song/"]');
        if (!link) return null;
        const songId = link.getAttribute('href');
        const title = link.textContent.trim();
        const timeMatch = row.innerText.match(/(\d+):(\d{2})/);
        let seconds = 0;
        if (timeMatch) {
            const [m, s] = timeMatch[0].split(':').map(Number);
            seconds = m * 60 + s;
        }
        return { songId, title, seconds };
    }

    function applySelection() {
        matchedSongs.clear();
        const rows = document.querySelectorAll('[data-testid="clip-row"]');

        rows.forEach(row => {
            const info = extractSongInfo(row);
            if (!info) return;

            const isMatch = targetTitles.length > 0 &&
                            targetTitles.some(t => t === info.title);

            if (isMatch) {
                matchedSongs.set(info.songId, info);
                row.classList.add('suno-auto-selected');
            } else {
                row.classList.remove('suno-auto-selected');
            }
        });

        updateResult();
    }

    function updateResult() {
        const result = document.getElementById('suno-auto-result');
        if (!result) return;

        const count = matchedSongs.size;

        if (targetTitles.length === 0) {
            result.textContent = '待機中';
            result.style.color = '#888';
            result.style.borderColor = '#555';
            return;
        }

        if (count === 0) {
            result.innerHTML = `🔍 検索中: ${targetTitles.length}件<br><span style="color:#f66;">該当なし</span>`;
            result.style.color = '#aaa';
            result.style.borderColor = '#f66';
            return;
        }

        let totalSec = 0;
        matchedSongs.forEach(v => totalSec += v.seconds);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;

        let timeStr;
        if (h > 0) {
            timeStr = `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
        } else {
            timeStr = `${m}:${s.toString().padStart(2,'0')}`;
        }

        result.innerHTML = `
            <div style="color:#ffb84d; font-weight:bold; font-size:16px;">✅ ${count} 曲</div>
            <div style="color:#3dd68c; font-size:14px; margin-top:4px;">合計 ${timeStr}</div>
        `;
        result.style.borderColor = '#ffb84d';
    }

    let observerDebounce = null;
    const observer = new MutationObserver(() => {
        if (targetTitles.length === 0) return;
        clearTimeout(observerDebounce);
        observerDebounce = setTimeout(applySelection, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            matchedSongs.clear();
            applySelection();
        }
    }, 1000);

    function init() {
        if (document.body) {
            createPanel();
        } else {
            setTimeout(init, 100);
        }
    }
    init();
})();
