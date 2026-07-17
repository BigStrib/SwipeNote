(function () {
    "use strict";

    const STORAGE_NOTES = "swipenote-notes-v2";
    const STORAGE_INDEX = "swipenote-index-v2";
    const MIN_FONT = 10;
    const MAX_FONT = 32;
    const DEFAULT_FONT = 16;
    const SWIPE_THRESHOLD = 40;
    const ANIM_DURATION = 300;
    const ANIM_EASE = "cubic-bezier(0.25,0.46,0.45,0.94)";

    // DOM
    const container = document.getElementById("notes-container");
    const countEl = document.getElementById("note-count");
    const emptyEl = document.getElementById("empty-state");
    const trashBtn = document.getElementById("trash-btn");
    const sizeUp = document.getElementById("size-up");
    const sizeDown = document.getElementById("size-down");
    const sizeLabel = document.getElementById("size-label");
    const controlsLeft = document.getElementById("controls-left");
    const modal = document.getElementById("confirm-modal");
    const modalCancel = document.getElementById("confirm-cancel");
    const modalDelete = document.getElementById("confirm-delete");
    const dotsEl = document.getElementById("dot-indicators");

    // State
    let notes = [];
    let idx = 0;
    let vh = window.innerHeight;
    let animating = false;

    // Touch state
    let tStartY = 0;
    let tStartX = 0;
    let tLastY = 0;
    let tLastX = 0;
    let tActive = false;
    let tDecided = false;
    let tIsSwipe = false;

    // Mouse state
    let mDown = false;
    let mStartY = 0;
    let mLastY = 0;
    let mDragging = false;
    let mMoved = false;

    // Wheel
    let wAccum = 0;
    let wTimer = null;

    // ---- INIT ----
    load();
    render();
    idx = clamp(loadIndex(), 0, Math.max(0, notes.length - 1));
    if (notes.length > 0) {
        jumpTo(idx);
        showControls();
    } else {
        setTransform(0);
        updateUI();
        hideControls();
    }
    bind();
    registerSW();

    // ---- BIND ----
    function bind() {
        // Touch
        document.addEventListener("touchstart", touchStart, { passive: false });
        document.addEventListener("touchmove", touchMove, { passive: false });
        document.addEventListener("touchend", touchEnd, { passive: true });
        document.addEventListener("touchcancel", touchEnd, { passive: true });

        // Mouse
        document.addEventListener("mousedown", mouseStart);
        document.addEventListener("mousemove", mouseMove);
        document.addEventListener("mouseup", mouseEnd);

        // Wheel
        document.addEventListener("wheel", wheelHandler, { passive: false });

        // Keyboard
        document.addEventListener("keydown", keyHandler);

        // Click empty area
        document.addEventListener("click", clickHandler);

        // Buttons
        trashBtn.addEventListener("click", function (e) { e.stopPropagation(); openModal(); });
        sizeUp.addEventListener("click", function (e) { e.stopPropagation(); changeFontSize(1); });
        sizeDown.addEventListener("click", function (e) { e.stopPropagation(); changeFontSize(-1); });
        modalCancel.addEventListener("click", closeModal);
        modalDelete.addEventListener("click", deleteNote);
        modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });

        // Resize
        window.addEventListener("resize", debounce(function () {
            var editing = document.activeElement && document.activeElement.classList.contains("note-text");
            if (!editing) {
                vh = window.innerHeight;
                sizeAllCards();
                jumpTo(idx);
            }
        }, 200));

        window.addEventListener("orientationchange", function () {
            setTimeout(function () {
                vh = window.innerHeight;
                sizeAllCards();
                jumpTo(idx);
            }, 350);
        });

        document.addEventListener("visibilitychange", function () {
            save();
            saveIndex();
        });
    }

    // ---- TOUCH ----
    function touchStart(e) {
        if (isModal()) return;
        if (e.touches.length !== 1) return;
        if (isButton(e.target)) return;

        tStartY = e.touches[0].clientY;
        tStartX = e.touches[0].clientX;
        tLastY = tStartY;
        tLastX = tStartX;
        tActive = true;
        tDecided = false;
        tIsSwipe = false;
    }

    function touchMove(e) {
        if (!tActive) return;
        if (isModal()) { tActive = false; return; }
        if (e.touches.length !== 1) return;

        tLastY = e.touches[0].clientY;
        tLastX = e.touches[0].clientX;

        var dy = tLastY - tStartY;
        var dx = tLastX - tStartX;
        var ay = Math.abs(dy);
        var ax = Math.abs(dx);

        if (!tDecided) {
            if (ay < 8 && ax < 8) return;
            tDecided = true;

            if (ay >= ax) {
                var canSwipe = checkCanSwipe(dy);
                if (canSwipe && notes.length > 0) {
                    tIsSwipe = true;
                    blurActive();
                } else {
                    tIsSwipe = false;
                }
            } else {
                tIsSwipe = false;
            }
        }

        if (tIsSwipe) {
            e.preventDefault();
            applyDrag(dy);
        }
    }

    function touchEnd() {
        if (!tActive) return;
        var wasSwipe = tIsSwipe;
        var dy = tLastY - tStartY;

        tActive = false;
        tDecided = false;
        tIsSwipe = false;

        if (wasSwipe) {
            finishDrag(dy);
        }
    }

    // ---- MOUSE ----
    function mouseStart(e) {
        if (isModal()) return;
        if (e.button !== 0) return;
        if (isButton(e.target)) return;
        if (e.target.closest(".note-text")) return;

        mDown = true;
        mStartY = e.clientY;
        mLastY = e.clientY;
        mDragging = false;
        mMoved = false;
    }

    function mouseMove(e) {
        if (!mDown) return;

        mLastY = e.clientY;
        var dy = mLastY - mStartY;

        if (!mDragging) {
            if (Math.abs(dy) > 8 && notes.length > 0) {
                mDragging = true;
                mMoved = true;
                blurActive();
            } else {
                return;
            }
        }

        e.preventDefault();
        applyDrag(dy);
    }

    function mouseEnd() {
        if (!mDown) return;
        var wasDragging = mDragging;
        var dy = mLastY - mStartY;

        mDown = false;
        mDragging = false;

        if (wasDragging) {
            finishDrag(dy);
        }

        setTimeout(function () { mMoved = false; }, 60);
    }

    // ---- SHARED DRAG ----
    function applyDrag(dy) {
        var drag = dy;

        if (idx === 0 && dy > 0) {
            if (currentEmpty()) {
                drag = dy / 5;
            } else {
                drag = dy / 2.5;
            }
        }

        if (idx === notes.length - 1 && dy < 0) {
            if (currentEmpty()) {
                drag = dy / 5;
            } else {
                drag = dy / 2.5;
            }
        }

        var pos = -(idx * vh) + drag;
        container.style.transition = "none";
        container.style.transform = "translateY(" + pos + "px)";
    }

    function finishDrag(dy) {
        if (animating) return;

        if (Math.abs(dy) < SWIPE_THRESHOLD) {
            animateTo(idx, true);
            return;
        }

        if (dy < 0) {
            goNext();
        } else {
            goPrev();
        }
    }

    function checkCanSwipe(dy) {
        if (notes.length === 0) return true;

        var el = activeTextEl();
        if (!el) return true;

        var scrollable = el.scrollHeight > el.clientHeight + 2;
        if (!scrollable) return true;

        if (dy > 0) return el.scrollTop <= 1;
        if (dy < 0) return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;

        return true;
    }

    // ---- WHEEL ----
    function wheelHandler(e) {
        if (isModal()) return;
        if (notes.length === 0) return;

        var el = activeTextEl();
        if (el) {
            var scrollable = el.scrollHeight > el.clientHeight + 2;
            if (scrollable) {
                if (e.deltaY < 0 && el.scrollTop > 1) return;
                if (e.deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 2) return;
            }
        }

        e.preventDefault();
        wAccum += e.deltaY;

        clearTimeout(wTimer);
        wTimer = setTimeout(function () {
            if (Math.abs(wAccum) > 40) {
                if (wAccum > 0) goNext();
                else goPrev();
            }
            wAccum = 0;
        }, 80);
    }

    // ---- KEYBOARD ----
    function keyHandler(e) {
        if (isModal()) {
            if (e.key === "Escape") closeModal();
            if (e.key === "Enter") deleteNote();
            return;
        }

        var editing = document.activeElement && document.activeElement.classList.contains("note-text");

        if ((e.ctrlKey || e.metaKey) && (e.key === "Delete" || e.key === "Backspace")) {
            e.preventDefault();
            if (notes.length > 0) openModal();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === "=") {
            e.preventDefault();
            changeFontSize(1);
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === "-") {
            e.preventDefault();
            changeFontSize(-1);
            return;
        }

        if (!editing) {
            if (e.key === "ArrowUp" || e.key === "PageUp") {
                e.preventDefault();
                goPrev();
                return;
            }
            if (e.key === "ArrowDown" || e.key === "PageDown") {
                e.preventDefault();
                goNext();
                return;
            }
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                if (notes.length === 0) {
                    addNote(-1);
                } else {
                    focusActive(true);
                }
            }
        }
    }

    // ---- CLICK ----
    function clickHandler(e) {
        if (isModal()) return;
        if (mMoved) return;
        if (isButton(e.target)) return;

        if (notes.length === 0) {
            addNote(-1);
            return;
        }

        showControls();

        if (!e.target.closest(".note-text")) {
            focusActive(true);
        }
    }

    // ---- NAVIGATION ----
    function goNext() {
        if (animating) return;
        if (notes.length === 0) { addNote(-1); return; }

        if (idx < notes.length - 1) {
            animateTo(idx + 1, true, true);
        } else {
            if (!currentEmpty()) {
                addNoteAfter(idx);
            } else {
                animateTo(idx, true, true);
            }
        }
    }

    function goPrev() {
        if (animating) return;
        if (notes.length === 0) return;

        if (idx > 0) {
            animateTo(idx - 1, true, true);
        } else {
            if (!currentEmpty()) {
                addNoteBefore(idx);
            } else {
                animateTo(0, true, true);
            }
        }
    }

    function jumpTo(i) {
        idx = clamp(i, 0, Math.max(0, notes.length - 1));
        setTransform(-(idx * vh));
        updateUI();
        showControls();
        saveIndex();
        updateFontLabel();
    }

    function animateTo(i, animate, focusAfter) {
        if (notes.length === 0) {
            setTransform(0);
            updateUI();
            hideControls();
            return;
        }

        idx = clamp(i, 0, notes.length - 1);

        if (animate) {
            animating = true;
            container.style.transition = "transform " + ANIM_DURATION + "ms " + ANIM_EASE;
        } else {
            container.style.transition = "none";
        }

        container.style.transform = "translateY(" + -(idx * vh) + "px)";

        updateUI();
        showControls();
        saveIndex();
        updateFontLabel();

        if (animate) {
            setTimeout(function () {
                animating = false;
                container.style.transition = "none";
                if (focusAfter) focusActive(true);
            }, ANIM_DURATION + 20);
        } else {
            if (focusAfter) {
                setTimeout(function () { focusActive(true); }, 30);
            }
        }
    }

    function setTransform(px) {
        container.style.transition = "none";
        container.style.transform = "translateY(" + px + "px)";
    }

    // ---- CRUD ----
    function addNote(afterIndex) {
        var n = makeNote();
        var at = afterIndex + 1;
        notes.splice(at, 0, n);
        save();
        render();
        animateTo(at, true, true);
    }

    function addNoteAfter(i) {
        var n = makeNote();
        notes.splice(i + 1, 0, n);
        save();
        render();
        animateTo(i + 1, true, true);
    }

    function addNoteBefore(i) {
        var n = makeNote();
        notes.splice(i, 0, n);
        save();
        render();
        // New note is at i, old note moved to i+1. Go to new note at i.
        animateTo(i, true, true);
    }

    function deleteNote() {
        if (notes.length === 0) { closeModal(); return; }

        notes.splice(idx, 1);
        idx = clamp(idx, 0, Math.max(0, notes.length - 1));

        save();
        closeModal();
        render();

        if (notes.length > 0) {
            jumpTo(idx);
            setTimeout(function () { focusActive(true); }, 50);
        } else {
            setTransform(0);
            updateUI();
            hideControls();
        }
    }

    function makeNote() {
        return {
            id: uid(),
            text: "",
            fontSize: DEFAULT_FONT,
            created: Date.now()
        };
    }

    // ---- FONT SIZE ----
    function changeFontSize(dir) {
        if (notes.length === 0) return;
        var note = notes[idx];
        if (!note) return;

        var size = (note.fontSize || DEFAULT_FONT) + dir;
        size = clamp(size, MIN_FONT, MAX_FONT);
        note.fontSize = size;

        var el = activeTextEl();
        if (el) el.style.fontSize = size + "px";

        sizeLabel.textContent = size;
        save();
    }

    function updateFontLabel() {
        if (notes.length === 0) {
            sizeLabel.textContent = DEFAULT_FONT;
            return;
        }
        var note = notes[idx];
        var size = note ? (note.fontSize || DEFAULT_FONT) : DEFAULT_FONT;
        sizeLabel.textContent = size;
    }

    // ---- RENDER ----
    function render() {
        container.innerHTML = "";

        notes.forEach(function (note, i) {
            var card = document.createElement("div");
            card.className = "note-card";
            card.dataset.id = note.id;
            card.style.height = vh + "px";

            var text = document.createElement("div");
            text.className = "note-text";
            text.contentEditable = "true";
            text.spellcheck = true;
            text.dataset.id = note.id;
            text.dataset.index = i;
            text.setAttribute("autocapitalize", "sentences");
            text.setAttribute("autocomplete", "off");
            text.setAttribute("autocorrect", "on");

            var fs = note.fontSize || DEFAULT_FONT;
            text.style.fontSize = fs + "px";
            text.textContent = note.text || "";

            text.addEventListener("focus", onFocus);
            text.addEventListener("input", onInput);
            text.addEventListener("blur", onBlur);
            text.addEventListener("paste", onPaste);

            // Prevent touch events on note-text from triggering page swipe
            text.addEventListener("touchstart", function (e) {
                // Let the text handle its own touch unless we need to swipe
            }, { passive: true });

            card.appendChild(text);
            container.appendChild(card);
        });

        sizeAllCards();
        updateUI();
    }

    function sizeAllCards() {
        vh = window.innerHeight;
        var cards = container.querySelectorAll(".note-card");
        for (var i = 0; i < cards.length; i++) {
            cards[i].style.height = vh + "px";
        }
    }

    function onFocus(e) {
        var i = findIndex(e.currentTarget.dataset.id);
        if (i !== -1) {
            idx = i;
            updateDots();
            showControls();
            updateFontLabel();
            saveIndex();
        }
    }

    function onInput(e) {
        var el = e.currentTarget;
        var i = findIndex(el.dataset.id);
        if (i === -1) return;

        var t = getText(el);
        notes[i].text = t;
        if (t.trim() === "") { el.innerHTML = ""; notes[i].text = ""; }
        save();
    }

    function onBlur(e) {
        var el = e.currentTarget;
        var i = findIndex(el.dataset.id);
        if (i === -1) return;

        var t = getText(el);
        notes[i].text = t.trim() === "" ? "" : t;
        if (t.trim() === "") el.innerHTML = "";
        save();
    }

    function onPaste(e) {
        e.preventDefault();
        var t = (e.clipboardData || window.clipboardData).getData("text/plain");
        insertText(t);
    }

    // ---- UI ----
    function updateUI() {
        updateCount();
        updateDots();
        updateEmpty();
        updateFontLabel();
    }

    function updateCount() {
        var c = notes.length;
        countEl.textContent = c + " " + (c === 1 ? "note" : "notes");
    }

    function updateEmpty() {
        emptyEl.classList.toggle("hidden", notes.length > 0);
    }

    function updateDots() {
        dotsEl.innerHTML = "";
        if (notes.length <= 1) return;

        if (notes.length <= 20) {
            for (var i = 0; i < notes.length; i++) {
                var d = document.createElement("div");
                d.className = "dot" + (i === idx ? " active" : "");
                dotsEl.appendChild(d);
            }
        } else {
            var label = document.createElement("span");
            label.className = "dot-label";
            label.textContent = (idx + 1) + " / " + notes.length;
            dotsEl.appendChild(label);
        }
    }

    function showControls() {
        if (notes.length === 0) { hideControls(); return; }
        trashBtn.classList.add("visible");
        controlsLeft.classList.add("visible");
    }

    function hideControls() {
        trashBtn.classList.remove("visible");
        controlsLeft.classList.remove("visible");
    }

    function openModal() {
        if (notes.length === 0) return;
        blurActive();
        modal.classList.add("active");
    }

    function closeModal() {
        modal.classList.remove("active");
        if (notes.length > 0) {
            setTimeout(function () { focusActive(false); }, 50);
        }
    }

    function isModal() {
        return modal.classList.contains("active");
    }

    // ---- HELPERS ----
    function focusActive(cursorEnd) {
        if (isModal()) return;
        var el = activeTextEl();
        if (!el) return;
        el.focus();
        if (cursorEnd) requestAnimationFrame(function () { cursorToEnd(el); });
        showControls();
    }

    function blurActive() {
        var el = activeTextEl();
        if (el) el.blur();
    }

    function activeTextEl() {
        var cards = container.querySelectorAll(".note-text");
        return cards[idx] || null;
    }

    function currentEmpty() {
        var n = notes[idx];
        return !n || n.text.trim() === "";
    }

    function isButton(target) {
        return target.closest("#trash-btn") ||
               target.closest("#size-up") ||
               target.closest("#size-down") ||
               target.closest("#controls-left") ||
               target.closest(".modal-overlay");
    }

    function getText(el) {
        var t = (el.innerText || "").replace(/\u200B/g, "").replace(/\r/g, "");
        if (t === "\n") return "";
        if (t.endsWith("\n")) t = t.slice(0, -1);
        return t;
    }

    function cursorToEnd(el) {
        var sel = window.getSelection();
        if (!sel) return;
        var r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
    }

    function insertText(text) {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        var r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(document.createTextNode(text));
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
    }

    function findIndex(id) {
        for (var i = 0; i < notes.length; i++) {
            if (notes[i].id === id) return i;
        }
        return -1;
    }

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    function debounce(fn, ms) {
        var t;
        return function () {
            var a = arguments, self = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(self, a); }, ms);
        };
    }

    function uid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return "sn-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    }

    // ---- STORAGE ----
    function save() {
        try { localStorage.setItem(STORAGE_NOTES, JSON.stringify(notes)); } catch (e) { }
        updateCount();
    }

    function load() {
        try {
            var d = JSON.parse(localStorage.getItem(STORAGE_NOTES));
            if (!Array.isArray(d)) { notes = []; return; }
            notes = d.map(function (n) {
                return {
                    id: String(n.id || uid()),
                    text: typeof n.text === "string" ? n.text : "",
                    fontSize: typeof n.fontSize === "number" ? clamp(n.fontSize, MIN_FONT, MAX_FONT) : DEFAULT_FONT,
                    created: n.created || Date.now()
                };
            });
        } catch (e) {
            notes = [];
        }
    }

    function saveIndex() {
        try { localStorage.setItem(STORAGE_INDEX, String(idx)); } catch (e) { }
    }

    function loadIndex() {
        try {
            var v = parseInt(localStorage.getItem(STORAGE_INDEX), 10);
            return isNaN(v) ? 0 : v;
        } catch (e) { return 0; }
    }

    // ---- SW ----
    function registerSW() {
        if ("serviceWorker" in navigator) {
            window.addEventListener("load", function () {
                navigator.serviceWorker.register("sw.js").catch(function () { });
            });
        }
    }

})();