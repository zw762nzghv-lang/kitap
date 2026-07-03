/* Kitaplık arayüzü: ızgara, arama, ekle/düzenle/sil, tema, yedekleme. */
"use strict";

const App = (() => {
  // --- elemanlar ---
  const grid = document.getElementById("book-grid");
  const emptyState = document.getElementById("empty-state");
  const noResults = document.getElementById("no-results");
  const searchInput = document.getElementById("search-input");
  const toastEl = document.getElementById("toast");

  const bookDialog = document.getElementById("book-dialog");
  const bookForm = document.getElementById("book-form");
  const dialogTitle = document.getElementById("book-dialog-title");
  const pdfField = document.getElementById("pdf-field");
  const pdfInput = document.getElementById("pdf-input");
  const pdfDrop = document.getElementById("pdf-drop");
  const pdfDropText = document.getElementById("pdf-drop-text");
  const coverInput = document.getElementById("cover-input");
  const coverDrop = document.getElementById("cover-drop");
  const coverDropText = document.getElementById("cover-drop-text");
  const coverPreview = document.getElementById("cover-preview");
  const coverRemoveBtn = document.getElementById("cover-remove");
  const titleInput = document.getElementById("title-input");
  const authorInput = document.getElementById("author-input");

  const confirmDialog = document.getElementById("confirm-dialog");
  const confirmTitle = document.getElementById("confirm-title");
  const confirmText = document.getElementById("confirm-text");
  const confirmOk = document.getElementById("confirm-ok");
  const confirmCancel = document.getElementById("confirm-cancel");

  const restoreInput = document.getElementById("restore-input");

  // --- durum ---
  let books = [];
  let editingId = null;       // null → ekleme modu
  let existingCover = null;   // düzenlemede mevcut kapak
  let coverRemoved = false;
  const coverUrls = new Map(); // id → objectURL

  // --- yardımcılar ---
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
  }

  function showConfirm({ title, text, okText = "Tamam", danger = false }) {
    return new Promise((resolve) => {
      confirmTitle.textContent = title;
      confirmText.textContent = text;
      confirmOk.textContent = okText;
      confirmOk.className = danger ? "btn btn-danger" : "btn btn-primary";
      const onOk = () => { cleanup(); confirmDialog.close(); resolve(true); };
      const onCancel = () => { cleanup(); confirmDialog.close(); resolve(false); };
      const onClose = () => { cleanup(); resolve(false); };
      function cleanup() {
        confirmOk.removeEventListener("click", onOk);
        confirmCancel.removeEventListener("click", onCancel);
        confirmDialog.removeEventListener("close", onClose);
      }
      confirmOk.addEventListener("click", onOk);
      confirmCancel.addEventListener("click", onCancel);
      confirmDialog.addEventListener("close", onClose);
      confirmDialog.showModal();
    });
  }

  function escapeXml(s) {
    return s.replace(/[<>&"']/g, (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c])
    );
  }

  function titleFromFilename(name) {
    return name
      .replace(/\.pdf$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // --- placeholder kapak (tipografik, tema uyumlu) ---
  function placeholderCover(title, author) {
    let hash = 0;
    for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
    const palette = ["a", "b", "c", "d"][hash % 4];

    // başlığı satırlara böl (en çok 5 satır)
    const words = title.split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length > 12 && line) {
        lines.push(line);
        line = w;
      } else {
        line = (line + " " + w).trim();
      }
      if (lines.length === 5) break;
    }
    if (line && lines.length < 5) lines.push(line);
    if (lines.length === 5 && words.join(" ").length > lines.join(" ").length) {
      lines[4] = lines[4].slice(0, 10) + "…";
    }

    const lineHeight = 30;
    const startY = 150 - ((lines.length - 1) * lineHeight) / 2;
    const titleSpans = lines
      .map(
        (l, i) =>
          `<text x="100" y="${startY + i * lineHeight}" text-anchor="middle" fill="var(--ph-text)" font-family="-apple-system, system-ui, sans-serif" font-size="22" font-weight="700">${escapeXml(l)}</text>`
      )
      .join("");
    const authorSpan = author
      ? `<text x="100" y="262" text-anchor="middle" fill="var(--ph-text)" opacity="0.85" font-family="-apple-system, system-ui, sans-serif" font-size="12" font-weight="500">${escapeXml(author)}</text>`
      : "";

    return `<svg viewBox="0 0 200 300" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true">
      <defs>
        <linearGradient id="g${hash}" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stop-color="var(--ph-${palette}1)"/>
          <stop offset="1" stop-color="var(--ph-${palette}2)"/>
        </linearGradient>
      </defs>
      <rect width="200" height="300" fill="url(#g${hash})"/>
      <rect x="14" y="14" width="172" height="272" fill="none" stroke="var(--ph-text)" stroke-opacity="0.35" stroke-width="1.5"/>
      <line x1="60" y1="44" x2="140" y2="44" stroke="var(--ph-text)" stroke-opacity="0.5" stroke-width="1"/>
      <line x1="60" y1="242" x2="140" y2="242" stroke="var(--ph-text)" stroke-opacity="0.5" stroke-width="1"/>
      ${titleSpans}
      ${authorSpan}
    </svg>`;
  }

  function coverUrlFor(book) {
    if (!book.coverBlob) return null;
    let url = coverUrls.get(book.id);
    if (!url) {
      url = URL.createObjectURL(book.coverBlob);
      coverUrls.set(book.id, url);
    }
    return url;
  }

  function dropCoverUrl(id) {
    const url = coverUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      coverUrls.delete(id);
    }
  }

  // --- ızgara ---
  function sortedBooks() {
    return [...books].sort(
      (a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt)
    );
  }

  function matchesSearch(book, q) {
    const t = (s) => (s || "").toLocaleLowerCase("tr-TR");
    return t(book.title).includes(q) || t(book.author).includes(q);
  }

  function closeCardMenus() {
    document.querySelectorAll(".card-menu").forEach((m) => m.remove());
  }

  function render() {
    closeCardMenus();
    const q = searchInput.value.trim().toLocaleLowerCase("tr-TR");
    const list = q ? sortedBooks().filter((b) => matchesSearch(b, q)) : sortedBooks();

    grid.textContent = "";
    emptyState.hidden = books.length > 0;
    noResults.hidden = !(books.length > 0 && list.length === 0);

    for (const book of list) grid.appendChild(makeCard(book));
  }

  function makeCard(book) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "book-card";
    card.setAttribute("aria-label", `${book.title} kitabını oku`);

    const cover = document.createElement("div");
    cover.className = "book-cover";
    const url = coverUrlFor(book);
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      cover.appendChild(img);
    } else {
      cover.insertAdjacentHTML("afterbegin", placeholderCover(book.title, book.author));
    }

    // ilerleme
    if (book.currentPage > 1 && book.totalPages > 0) {
      const badge = document.createElement("span");
      badge.className = "continue-badge";
      badge.textContent = book.currentPage >= book.totalPages ? "Bitti" : "Devam et";
      cover.appendChild(badge);

      const bar = document.createElement("div");
      bar.className = "book-progress";
      const fill = document.createElement("span");
      fill.style.width = `${Math.round((book.currentPage / book.totalPages) * 100)}%`;
      bar.appendChild(fill);
      cover.appendChild(bar);
    }

    // kart menüsü (düzenle / sil)
    const menuBtn = document.createElement("span");
    menuBtn.className = "card-menu-btn";
    menuBtn.setAttribute("role", "button");
    menuBtn.setAttribute("aria-label", "Kitap seçenekleri");
    menuBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="18.5" r="1.8" fill="currentColor"/></svg>';
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCardMenu(cover, book);
    });
    cover.appendChild(menuBtn);

    const info = document.createElement("div");
    info.className = "book-info";
    const t = document.createElement("div");
    t.className = "book-title";
    t.textContent = book.title;
    const a = document.createElement("div");
    a.className = "book-author";
    a.textContent = book.author || "Bilinmeyen yazar";
    info.append(t, a);

    card.append(cover, info);
    card.addEventListener("click", () => Reader.open(book, render));
    return card;
  }

  function toggleCardMenu(coverEl, book) {
    const existing = coverEl.querySelector(".card-menu");
    closeCardMenus();
    if (existing) return;

    const menu = document.createElement("div");
    menu.className = "card-menu";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "menu-item";
    editBtn.textContent = "Düzenle";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeCardMenus();
      openEditDialog(book);
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "menu-item danger";
    delBtn.textContent = "Sil";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeCardMenus();
      const ok = await showConfirm({
        title: "Kitabı sil",
        text: `"${book.title}" kitaplığınızdan kalıcı olarak silinecek. Bu işlem geri alınamaz.`,
        okText: "Sil",
        danger: true,
      });
      if (!ok) return;
      await DB.deleteBook(book.id);
      dropCoverUrl(book.id);
      books = books.filter((b) => b.id !== book.id);
      render();
      toast("Kitap silindi.");
    });
    menu.append(editBtn, delBtn);
    menu.addEventListener("click", (e) => e.stopPropagation());
    coverEl.appendChild(menu);
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".card-menu") && !e.target.closest(".card-menu-btn")) {
      closeCardMenus();
    }
  });

  // --- kitap ekleme / düzenleme diyaloğu ---
  function resetDialog() {
    bookForm.reset();
    editingId = null;
    existingCover = null;
    coverRemoved = false;
    pdfDrop.classList.remove("has-file");
    pdfDropText.textContent = "PDF seçmek için tıklayın";
    coverDrop.classList.remove("has-file");
    coverDropText.hidden = false;
    if (coverPreview.src) URL.revokeObjectURL(coverPreview.src);
    coverPreview.removeAttribute("src");
    coverPreview.hidden = true;
    coverRemoveBtn.hidden = true;
  }

  function openAddDialog() {
    resetDialog();
    dialogTitle.textContent = "Kitap Ekle";
    pdfField.hidden = false;
    pdfInput.required = true;
    bookDialog.showModal();
  }

  function openEditDialog(book) {
    resetDialog();
    editingId = book.id;
    existingCover = book.coverBlob || null;
    dialogTitle.textContent = "Kitabı Düzenle";
    pdfField.hidden = true;
    pdfInput.required = false;
    titleInput.value = book.title;
    authorInput.value = book.author || "";
    if (existingCover) {
      coverPreview.src = URL.createObjectURL(existingCover);
      coverPreview.hidden = false;
      coverDropText.hidden = true;
      coverDrop.classList.add("has-file");
      coverRemoveBtn.hidden = false;
    }
    bookDialog.showModal();
  }

  pdfInput.addEventListener("change", async () => {
    const file = pdfInput.files[0];
    if (!file) return;
    pdfDrop.classList.add("has-file");
    pdfDropText.textContent = file.name;
    if (!titleInput.value.trim()) {
      titleInput.value = titleFromFilename(file.name);
    }
  });

  coverInput.addEventListener("change", () => {
    const file = coverInput.files[0];
    if (!file) return;
    coverRemoved = false;
    if (coverPreview.src) URL.revokeObjectURL(coverPreview.src);
    coverPreview.src = URL.createObjectURL(file);
    coverPreview.hidden = false;
    coverDropText.hidden = true;
    coverDrop.classList.add("has-file");
    coverRemoveBtn.hidden = false;
  });

  coverRemoveBtn.addEventListener("click", () => {
    coverRemoved = true;
    coverInput.value = "";
    if (coverPreview.src) URL.revokeObjectURL(coverPreview.src);
    coverPreview.removeAttribute("src");
    coverPreview.hidden = true;
    coverDropText.hidden = false;
    coverDrop.classList.remove("has-file");
    coverRemoveBtn.hidden = true;
  });

  document.getElementById("book-cancel").addEventListener("click", () => bookDialog.close());

  bookForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = titleInput.value.trim();
    if (!title) return;
    const author = authorInput.value.trim();
    const newCover = coverInput.files[0] || null;

    try {
      if (editingId) {
        // düzenleme
        const book = books.find((b) => b.id === editingId);
        if (!book) return;
        book.title = title;
        book.author = author;
        if (newCover) {
          book.coverBlob = newCover;
          dropCoverUrl(book.id);
        } else if (coverRemoved) {
          book.coverBlob = null;
          dropCoverUrl(book.id);
        }
        await DB.putBook(book);
        toast("Kitap güncellendi.");
      } else {
        // ekleme
        const pdfFile = pdfInput.files[0];
        if (!pdfFile) {
          toast("Lütfen bir PDF dosyası seçin.");
          return;
        }
        let totalPages = 0;
        try {
          const url = URL.createObjectURL(pdfFile);
          const doc = await pdfjsLib.getDocument(url).promise;
          totalPages = doc.numPages;
          doc.destroy();
          URL.revokeObjectURL(url);
        } catch (err) {
          console.warn("Sayfa sayısı okunamadı:", err);
        }
        const book = {
          id: crypto.randomUUID(),
          title,
          author,
          coverBlob: newCover,
          currentPage: 1,
          totalPages,
          addedAt: Date.now(),
          lastReadAt: null,
        };
        await DB.putBookWithFile(book, pdfFile);
        books.push(book);
        toast("Kitap eklendi.");
      }
      bookDialog.close();
      render();
    } catch (err) {
      console.error("Kaydetme hatası:", err);
      toast("Kaydedilemedi — depolama hatası olabilir.");
    }
  });

  // --- arama ---
  searchInput.addEventListener("input", render);

  // --- görünüm (tema): "system" | "light" | "dark" ---
  const THEME_KEY = "kutuphane-theme";
  const themeDialog = document.getElementById("theme-dialog");
  const themeItems = [...themeDialog.querySelectorAll(".action-item")];
  const themeMedia = matchMedia("(prefers-color-scheme: dark)");
  let themeMode = "system";

  function resolveTheme(mode) {
    if (mode === "dark" || mode === "light") return mode;
    return themeMedia.matches ? "dark" : "light"; // sistem
  }
  function applyMode(mode) {
    themeMode = mode;
    const theme = resolveTheme(mode);
    document.documentElement.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#000000" : "#F9F9F9";
    for (const item of themeItems) {
      item.classList.toggle("selected", item.dataset.mode === mode);
    }
  }
  function initTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    applyMode(stored === "light" || stored === "dark" ? stored : "system");
  }
  // "Sistem" seçiliyken cihazın teması değişirse canlı uygula
  themeMedia.addEventListener("change", () => {
    if (themeMode === "system") applyMode("system");
  });

  // yumuşak (aşağı kayarak) kapanış
  function closeThemeDialog() {
    if (!themeDialog.open || themeDialog.classList.contains("closing")) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      themeDialog.close();
      return;
    }
    themeDialog.classList.add("closing");
    setTimeout(() => {
      themeDialog.classList.remove("closing");
      themeDialog.close();
    }, 300); // CSS sheet-down süresiyle aynı
  }

  // menüdeki "Görünüm" → seçici sayfa
  document.getElementById("menu-theme").addEventListener("click", () => {
    appMenu.hidden = true;
    menuToggle.setAttribute("aria-expanded", "false");
    themeDialog.showModal();
  });
  for (const item of themeItems) {
    item.addEventListener("click", () => {
      const mode = item.dataset.mode;
      applyMode(mode);
      localStorage.setItem(THEME_KEY, mode);
      closeThemeDialog();
    });
  }
  document.getElementById("theme-cancel").addEventListener("click", closeThemeDialog);
  // dışarı dokununca kapat
  themeDialog.addEventListener("click", (e) => {
    if (e.target === themeDialog) closeThemeDialog();
  });
  // Esc de yumuşak kapansın
  themeDialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeThemeDialog();
  });

  // --- header menüsü ---
  const menuToggle = document.getElementById("menu-toggle");
  const appMenu = document.getElementById("app-menu");
  menuToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !appMenu.hidden;
    appMenu.hidden = open;
    menuToggle.setAttribute("aria-expanded", String(!open));
  });
  document.addEventListener("click", (e) => {
    if (!appMenu.hidden && !e.target.closest(".menu-wrap")) {
      appMenu.hidden = true;
      menuToggle.setAttribute("aria-expanded", "false");
    }
  });

  // --- yedekle / geri yükle ---
  document.getElementById("menu-backup").addEventListener("click", async () => {
    appMenu.hidden = true;
    try {
      const count = await Backup.exportAll();
      toast(`${count} kitap yedeklendi — dosya indiriliyor.`);
    } catch (err) {
      if (err.message === "empty") toast("Yedeklenecek kitap yok.");
      else {
        console.error("Yedekleme hatası:", err);
        toast("Yedekleme başarısız oldu.");
      }
    }
  });

  document.getElementById("menu-restore").addEventListener("click", () => {
    appMenu.hidden = true;
    restoreInput.click();
  });

  restoreInput.addEventListener("change", async () => {
    const file = restoreInput.files[0];
    restoreInput.value = "";
    if (!file) return;
    try {
      const { header, dataOffset } = await Backup.readHeader(file);
      const ok = await showConfirm({
        title: "Yedeği geri yükle",
        text: `Yedek dosyasında ${header.books.length} kitap var. Kitaplığınızdaki aynı kitapların üzerine yazılacak, diğerleri korunacak. Devam edilsin mi?`,
        okText: "Geri Yükle",
      });
      if (!ok) return;
      const count = await Backup.restore(file, header, dataOffset);
      await loadBooks();
      render();
      toast(`${count} kitap geri yüklendi.`);
    } catch (err) {
      console.error("Geri yükleme hatası:", err);
      toast(
        err.message === "invalid-format"
          ? "Bu dosya geçerli bir kütüphane yedeği değil."
          : "Geri yükleme başarısız oldu."
      );
    }
  });

  // --- ekleme butonları ---
  document.getElementById("add-book-btn").addEventListener("click", openAddDialog);
  document.getElementById("empty-add-btn").addEventListener("click", openAddDialog);

  // --- large-title: kaydırınca kompakt başlığı göster ---
  const navBar = document.getElementById("nav-bar");
  const largeTitle = document.getElementById("large-title");
  const titleObserver = new IntersectionObserver(
    ([entry]) => navBar.classList.toggle("scrolled", !entry.isIntersecting),
    { rootMargin: "-44px 0px 0px 0px", threshold: 0 }
  );
  titleObserver.observe(largeTitle);

  // --- başlangıç ---
  async function loadBooks() {
    for (const id of coverUrls.keys()) dropCoverUrl(id);
    books = (await DB.getAllBooks()) || [];
  }

  async function init() {
    initTheme();

    DB.requestPersist().then((granted) => {
      if (!granted) {
        console.warn(
          "Kalıcı depolama izni verilmedi — tarayıcı, alan azalırsa veriyi temizleyebilir. Düzenli yedek almanız önerilir."
        );
      }
    });

    try {
      await loadBooks();
    } catch (err) {
      console.error("Kitaplar yüklenemedi:", err);
      toast("Kitaplık açılamadı.");
    }
    render();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("sw.js")
        .catch((err) => console.warn("Service worker kaydedilemedi:", err));
    }
  }

  init();

  return { toast, render };
})();
