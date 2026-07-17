const STORAGE_KEY = "swipenote-data-v1";
const TRANSITION = "transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)";
const SWIPE_THRESHOLD = 50;

const notesContainer = document.getElementById("notes-container");
const noteCountEl = document.getElementById("note-count");
const emptyState = document.getElementById("empty-state");
const trashBtn = document.getElementById("trash-btn");
const confirmModal = document.getElementById("confirm-modal");
const confirmCancel = document.getElementById("confirm-cancel");
const confirmDelete = document.getElementById("confirm-delete");
const dotIndicators = document.getElementById("dot-indicators");

let notes = loadNotes();
let activeIndex = 0;
let viewportHeight = window.innerHeight;
let focusTimer = null;
let recentlySwiped = false;

// Touch
let touchStartY = 0;
let touchStartX = 0;
let touchCurrentY = 0;
let touchCurrentX = 0;
let isTouchSwiping = false;
let touchLocked = null;

// Mouse
let mouseIsDown = false;
let mouseStartY = 0;
let mouseCurrentY = 0;
let mouseIsSwiping = false;
let mouseDidMove = false;

// Wheel
let wheelAccum = 0;
let wheelTimer = null;

init();

function init() {
    notesContainer.style.transition = TRANSITION;
    bindEvents();
    renderNotes();

    if (notes.length > 0) {
        activeIndex = clamp(activeIndex, 0, notes.length - 1);
        goToNote(activeIndex, false);
    } else {
        updateUI();
        hideTrash();
    }
}

function bindEvents() {
    notesContainer.addEventListener("click", onContainerClick);

    // Touch
    notesContainer.addEventListener("touchstart", onTouchStart, { passive: false });
    notesContainer.addEventListener("touchmove", onTouchMove, { passive: false });
    notesContainer.addEventListener("touchend", onTouchEnd, { passive: true });
    notesContainer.addEventListener("touchcancel", onTouchEnd, { passive: true });

    // Mouse
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    // Wheel
    notesContainer.addEventListener("wheel", onWheel, { passive: false });

    // Keyboard
    document.addEventListener("keydown", onKeyDown);

    // Trash
    trashBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openDeleteConfirm();
    });

    // Modal
    confirmCancel.addEventListener("click", closeDeleteConfirm);
    confirmDelete.addEventListener("click", deleteActiveNote);
    confirmModal.addEventListener("click", (e) => {
        if (e.target === confirmModal) closeDeleteConfirm();
    });

    // Viewport
    window.addEventListener("resize", debounce(() => {
        const editing = document.activeElement && document.activeElement.classList.contains("note-text");
        if (!editing) updateViewport();
    }, 150));
    window.addEventListener("orientationchange", () => setTimeout(updateViewport, 300));
    document.addEventListener("visibilitychange", saveNotes);
}

/* =====================
   CLICK
   ===================== */
function onContainerClick(e) {
    if (confirmModal.classList.contains("active")) return;
    if (recentlySwiped) return;
    if (mouseDidMove) return;

    if (notes.length === 0) {
        createNoteAfter(-1);
        return;
    }

    showTrash();

    const clickedCard = e.target.closest(".note-card");
    if (clickedCard) {
        const idx = findIndexById(clickedCard.dataset.id);
        if (idx !== -1) {
            activeIndex = idx;
            updateDots();
        }
    }

    if (!e.target.closest(".note-text")) {
        focusActiveNote(true);
    }
}

/* =====================
   TOUCH
   ===================== */
function onTouchStart(e) {
    if (confirmModal.classList.contains("active")) return;
    if (e.touches.length !== 1) return;

    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchCurrentY = touchStartY;
    touchCurrentX = touchStartX;
    isTouchSwiping = false;
    touchLocked = null;
}

function onTouchMove(e) {
    if (confirmModal.classList.contains("active")) return;
    if (e.touches.length !== 1) return;

    touchCurrentY = e.touches[0].clientY;
    touchCurrentX = e.touches[0].clientX;

    const dy = touchCurrentY - touchStartY;
    const dx = touchCurrentX - touchStartX;

    if (!touchLocked) {
        if (Math.abs(dy) < 10 && Math.abs(dx) < 10) return;

        if (Math.abs(dy) >= Math.abs(dx)) {
            if (notes.length > 0 && canSwipeNotes(dy)) {
                touchLocked = "swipe";
                isTouchSwiping = true;
                blurActiveNote();
            } else {
                touchLocked = "scroll";
            }
        } else {
            touchLocked = "horizontal";
        }
    }

    if (touchLocked === "swipe") {
        e.preventDefault();
        dragContainer(dy);
    }
}

function onTouchEnd() {
    if (isTouchSwiping) {
        const dy = touchCurrentY - touchStartY;
        finishSwipe(dy);
    }

    isTouchSwiping = false;
    touchLocked = null;
}

/* =====================
   MOUSE DRAG
   ===================== */
function onMouseDown(e) {
    if (confirmModal.classList.contains("active")) return;
    if (e.button !== 0) return;

    // Don't start drag on note-text, trash, or modal
    if (e.target.closest(".note-text")) return;
    if (e.target.closest("#trash-btn")) return;
    if (e.target.closest(".modal-overlay")) return;

    mouseIsDown = true;
    mouseStartY = e.clientY;
    mouseCurrentY = e.clientY;
    mouseIsSwiping = false;
    mouseDidMove = false;
}

function onMouseMove(e) {
    if (!mouseIsDown) return;

    mouseCurrentY = e.clientY;
    const dy = mouseCurrentY - mouseStartY;

    if (!mouseIsSwiping) {
        if (Math.abs(dy) > 8) {
            if (notes.length === 0) {
                mouseIsDown = false;
                return;
            }
            mouseIsSwiping = true;
            mouseDidMove = true;
            blurActiveNote();
            e.preventDefault();
        }
        return;
    }

    e.preventDefault();
    dragContainer(dy);
}

function onMouseUp() {
    if (!mouseIsDown) return;

    const wasSwiping = mouseIsSwiping;
    const dy = mouseCurrentY - mouseStartY;

    mouseIsDown = false;
    mouseIsSwiping = false;

    if (wasSwiping) {
        finishSwipe(dy);
    }

    // Reset mouseDidMove after a tick so click handler can check it
    setTimeout(() => {
        mouseDidMove = false;
    }, 50);
}

/* =====================
   SHARED DRAG / SWIPE
   ===================== */
function dragContainer(dy) {
    let drag = dy;

    const goingUp = dy < 0;
    const goingDown = dy > 0;

    const atFirst = activeIndex === 0 && goingDown;
    const atLast = activeIndex === notes.length - 1 && goingUp;

    // Resistance at edges (but still allow drag to feel responsive)
    if (atFirst) {
        drag = dy / 4;
    } else if (atLast) {
        // At last note: light resistance if note has content (will create new)
        // Heavy resistance if note is empty (won't create)
        if (currentNoteIsEmpty()) {
            drag = dy / 5;
        } else {
            drag = dy / 2;
        }
    }

    const pos = (-activeIndex * viewportHeight) + drag;
    notesContainer.style.transition = "none";
    notesContainer.style.transform = `translateY(${pos}px)`;
}

function finishSwipe(dy) {
    notesContainer.style.transition = TRANSITION;

    if (Math.abs(dy) < SWIPE_THRESHOLD) {
        goToNote(activeIndex, true);
        return;
    }

    flagSwipe();

    if (dy < 0) {
        // Dragged UP → go next / create
        navigateNext();
    } else {
        // Dragged DOWN → go previous / create above
        navigatePrevious();
    }
}

function canSwipeNotes(dy) {
    const el = getActiveTextEl();
    if (!el) return true;

    const hasScroll = el.scrollHeight > el.clientHeight + 2;
    if (!hasScroll) return true;

    const atTop = el.scrollTop <= 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;

    if (dy > 0) return atTop;
    if (dy < 0) return atBottom;

    return true;
}

/* =====================
   WHEEL
   ===================== */
function onWheel(e) {
    if (confirmModal.classList.contains("active")) return;
    if (notes.length === 0) return;

    const el = getActiveTextEl();
    if (el) {
        const hasScroll = el.scrollHeight > el.clientHeight + 2;
        if (hasScroll) {
            const atTop = el.scrollTop <= 1;
            const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
            if (e.deltaY < 0 && !atTop) return;
            if (e.deltaY > 0 && !atBottom) return;
        }
    }

    e.preventDefault();
    wheelAccum += e.deltaY;

    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
        if (Math.abs(wheelAccum) > 50) {
            flagSwipe();
            if (wheelAccum > 0) navigateNext();
            else navigatePrevious();
        }
        wheelAccum = 0;
    }, 100);
}

/* =====================
   KEYBOARD
   ===================== */
function onKeyDown(e) {
    if (confirmModal.classList.contains("active")) {
        if (e.key === "Escape") closeDeleteConfirm();
        if (e.key === "Enter") deleteActiveNote();
        return;
    }

    const editing = document.activeElement && document.activeElement.classList.contains("note-text");

    if ((e.ctrlKey || e.metaKey) && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        if (notes.length > 0) openDeleteConfirm();
        return;
    }

    if (!editing) {
        if (e.key === "ArrowUp" || e.key === "PageUp") {
            e.preventDefault();
            navigatePrevious();
            return;
        }
        if (e.key === "ArrowDown" || e.key === "PageDown") {
            e.preventDefault();
            navigateNext();
            return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (notes.length === 0) {
                createNoteAfter(-1);
            } else {
                focusActiveNote(true);
            }
        }
    }
}

/* =====================
   NAVIGATION
   ===================== */
function navigateNext() {
    if (notes.length === 0) {
        createNoteAfter(-1);
        return;
    }

    if (activeIndex < notes.length - 1) {
        goToNote(activeIndex + 1, true, true);
        return;
    }

    // On last note
    if (!currentNoteIsEmpty()) {
        createNoteAfter(activeIndex);
    } else {
        goToNote(activeIndex, true, true);
    }
}

function navigatePrevious() {
    if (notes.length === 0) return;

    if (activeIndex > 0) {
        goToNote(activeIndex - 1, true, true);
        return;
    }

    // Already at first note — create a new note ABOVE it
    if (!currentNoteIsEmpty()) {
        createNoteBefore(activeIndex);
    } else {
        goToNote(0, true, true);
    }
}

function goToNote(index, animate = true, focusAfter = false) {
    if (notes.length === 0) {
        notesContainer.style.transform = "translateY(0px)";
        updateUI();
        hideTrash();
        return;
    }

    activeIndex = clamp(index, 0, notes.length - 1);

    notesContainer.style.transition = animate ? TRANSITION : "none";
    notesContainer.style.transform = `translateY(${-activeIndex * viewportHeight}px)`;

    updateUI();
    showTrash();

    if (!animate) {
        requestAnimationFrame(() => {
            notesContainer.style.transition = TRANSITION;
        });
    }

    if (focusAfter) {
        clearTimeout(focusTimer);
        focusTimer = setTimeout(() => focusActiveNote(true), animate ? 200 : 50);
    }
}

/* =====================
   CRUD
   ===================== */
function createNoteAfter(index) {
    const note = { id: createId(), text: "", created: Date.now() };
    const at = index + 1;
    notes.splice(at, 0, note);
    saveNotes();
    renderNotes();
    activeIndex = at;
    goToNote(activeIndex, true, true);
}

function createNoteBefore(index) {
    const note = { id: createId(), text: "", created: Date.now() };
    notes.splice(index, 0, note);
    saveNotes();
    renderNotes();
    // The new note is now at `index`, old note moved to `index + 1`
    activeIndex = index;
    goToNote(activeIndex, true, true);
}

function deleteActiveNote() {
    if (notes.length === 0) {
        closeDeleteConfirm();
        return;
    }

    notes.splice(activeIndex, 1);
    activeIndex = clamp(activeIndex, 0, Math.max(0, notes.length - 1));

    saveNotes();
    confirmModal.classList.remove("active");
    renderNotes();

    if (notes.length > 0) {
        goToNote(activeIndex, false, true);
    } else {
        notesContainer.style.transform = "translateY(0px)";
        updateUI();
        hideTrash();
    }
}

function openDeleteConfirm() {
    if (notes.length === 0) return;
    blurActiveNote();
    confirmModal.classList.add("active");
}

function closeDeleteConfirm() {
    confirmModal.classList.remove("active");
    if (notes.length > 0) {
        setTimeout(() => focusActiveNote(false), 50);
    }
}

/* =====================
   RENDER
   ===================== */
function renderNotes() {
    const scrolls = getScrollPositions();

    notesContainer.querySelectorAll(".note-card").forEach((c) => c.remove());

    notes.forEach((note, i) => {
        const card = document.createElement("section");
        card.className = "note-card";
        card.dataset.id = note.id;
        card.style.height = `${viewportHeight}px`;
        card.style.minHeight = `${viewportHeight}px`;

        const text = document.createElement("div");
        text.className = "note-text";
        text.contentEditable = "true";
        text.spellcheck = true;
        text.dataset.id = note.id;
        text.setAttribute("aria-label", `Note ${i + 1}`);
        text.setAttribute("autocapitalize", "sentences");
        text.setAttribute("autocomplete", "off");
        text.setAttribute("autocorrect", "on");
        text.textContent = note.text || "";

        text.addEventListener("focus", onNoteFocus);
        text.addEventListener("input", onNoteInput);
        text.addEventListener("blur", onNoteBlur);
        text.addEventListener("paste", onNotePaste);

        card.addEventListener("click", (e) => {
            showTrash();
            if (e.target === card) {
                text.focus();
                placeCursorAtEnd(text);
            }
        });

        card.appendChild(text);
        notesContainer.appendChild(card);
    });

    updateViewport(false);
    restoreScrollPositions(scrolls);
    updateUI();

    notes.length > 0 ? showTrash() : hideTrash();
}

function onNoteFocus(e) {
    const idx = findIndexById(e.currentTarget.dataset.id);
    if (idx !== -1) {
        activeIndex = idx;
        updateDots();
        showTrash();
    }
}

function onNoteInput(e) {
    const el = e.currentTarget;
    const idx = findIndexById(el.dataset.id);
    if (idx === -1) return;

    const text = getEditableText(el);
    notes[idx].text = text;

    if (text.trim() === "") {
        el.innerHTML = "";
        notes[idx].text = "";
    }

    saveNotes();
}

function onNoteBlur(e) {
    const el = e.currentTarget;
    const idx = findIndexById(el.dataset.id);
    if (idx === -1) return;

    const text = getEditableText(el);
    notes[idx].text = text.trim() === "" ? "" : text;
    if (text.trim() === "") el.innerHTML = "";

    saveNotes();
}

function onNotePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    insertTextAtCursor(text);
}

/* =====================
   UI UPDATES
   ===================== */
function updateUI() {
    updateCount();
    updateDots();
    updateEmptyState();
}

function updateCount() {
    const c = notes.length;
    noteCountEl.textContent = `${c} ${c === 1 ? "note" : "notes"}`;
}

function updateEmptyState() {
    emptyState.classList.toggle("hidden", notes.length > 0);
}

function updateDots() {
    dotIndicators.innerHTML = "";
    if (notes.length <= 1) return;

    const maxDots = 20;

    if (notes.length <= maxDots) {
        notes.forEach((_, i) => {
            const dot = document.createElement("div");
            dot.className = "dot" + (i === activeIndex ? " active" : "");
            dotIndicators.appendChild(dot);
        });
    } else {
        const label = document.createElement("span");
        label.style.cssText = "font-size:10px;color:#555;letter-spacing:1px;";
        label.textContent = `${activeIndex + 1} / ${notes.length}`;
        dotIndicators.appendChild(label);
    }
}

function showTrash() {
    if (notes.length === 0) { hideTrash(); return; }
    trashBtn.classList.add("visible");
}

function hideTrash() {
    trashBtn.classList.remove("visible");
}

/* =====================
   HELPERS
   ===================== */
function focusActiveNote(cursorEnd = false) {
    if (confirmModal.classList.contains("active")) return;
    const el = getActiveTextEl();
    if (!el) return;

    el.focus();
    if (cursorEnd) requestAnimationFrame(() => placeCursorAtEnd(el));
    showTrash();
}

function blurActiveNote() {
    const el = getActiveTextEl();
    if (el) el.blur();
}

function getActiveTextEl() {
    const all = notesContainer.querySelectorAll(".note-text");
    return all[activeIndex] || null;
}

function currentNoteIsEmpty() {
    const note = notes[activeIndex];
    return !note || note.text.trim() === "";
}

function updateViewport(keepTransform = true) {
    viewportHeight = window.innerHeight;

    notesContainer.querySelectorAll(".note-card").forEach((card) => {
        card.style.height = `${viewportHeight}px`;
        card.style.minHeight = `${viewportHeight}px`;
    });

    if (keepTransform && notes.length > 0) {
        notesContainer.style.transform = `translateY(${-activeIndex * viewportHeight}px)`;
    }
}

function getEditableText(el) {
    let t = (el.innerText || "").replace(/\u200B/g, "").replace(/\r/g, "");
    if (t === "\n") return "";
    if (t.endsWith("\n")) t = t.slice(0, -1);
    return t;
}

function placeCursorAtEnd(el) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function insertTextAtCursor(text) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function getScrollPositions() {
    const map = new Map();
    notesContainer.querySelectorAll(".note-card").forEach((card) => {
        const t = card.querySelector(".note-text");
        if (t) map.set(card.dataset.id, t.scrollTop);
    });
    return map;
}

function restoreScrollPositions(map) {
    notesContainer.querySelectorAll(".note-card").forEach((card) => {
        const t = card.querySelector(".note-text");
        if (t && map.has(card.dataset.id)) t.scrollTop = map.get(card.dataset.id);
    });
}

function findIndexById(id) {
    return notes.findIndex((n) => n.id === id);
}

function flagSwipe() {
    recentlySwiped = true;
    setTimeout(() => { recentlySwiped = false; }, 300);
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* =====================
   STORAGE
   ===================== */
function saveNotes() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(notes)); }
    catch (e) { console.warn("SwipeNote: save failed", e); }
    updateCount();
}

function loadNotes() {
    try {
        const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!Array.isArray(d)) return [];
        return d.map((n) => ({
            id: String(n.id || createId()),
            text: typeof n.text === "string" ? n.text : "",
            created: n.created || Date.now()
        }));
    } catch { return []; }
}

function createId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `sn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* =====================
   SERVICE WORKER
   ===================== */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch(() => {});
    });
}