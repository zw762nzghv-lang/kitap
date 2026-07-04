/* pdf.js tabanlı okuyucu — sürekli (yukarıdan aşağıya) kaydırmalı; kaldığı yeri hatırlar.

   ÖNEMLİ (iOS siyah ekran çözümü):
   Her sayfa ekran-dışı bir canvas'a çizilir, ardından bir görüntüye (<img>)
   dönüştürülür ve canvas DOM'da TUTULMAZ. Nedeni: iOS Safari, DOM'da canlı duran
   <canvas> backing-store'larını bellek baskısında sessizce boşaltıp siyaha çevirir
   ve pdf.js bunu bilmediği için yeniden çizmez → okurken siyah ekran. <img> ise
   tarayıcının görüntü belleği tarafından yönetilir: bellek gerekirse çözümlenmiş
   bitmap düşürülür ama sıkıştırılmış kaynaktan otomatik yeniden çözümlenir; asla
   kalıcı siyah kalmaz. */
"use strict";

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const Reader = (() => {
  const view = document.getElementById("reader-view");
  const titleEl = document.getElementById("reader-title");
  const body = document.getElementById("reader-body");
  const pagesEl = document.getElementById("pdf-pages");
  const pageInput = document.getElementById("page-input");
  const pageTotal = document.getElementById("page-total");
  const btnPrev = document.getElementById("page-prev");
  const btnNext = document.getElementById("page-next");

  let book = null;        // App'in bellekteki kitap nesnesi (paylaşılan referans)
  let pdfDoc = null;
  let blobUrl = null;
  let wrappers = [];      // her sayfa için sarmalayıcı <div> (içinde <img>)
  let renderTasks = new Map(); // index -> pdf.js render görevi
  let io = null;          // görünüre giren sayfaları tembel render eden gözlemci
  let currentIndex = 0;   // en üstteki görünür sayfa (0 tabanlı)
  let zoom = 1;           // genişliğe-sığdır çarpanı
  let estAspect = 1.414;  // yükseklik/genişlik tahmini (A4 varsayılan)
  let saveTimer = null;
  let scrollRaf = null;
  let closeTimer = null;
  let onCloseCb = null;
  let lastBodyWidth = 0;   // resize'da genişlik gerçekten değişti mi kontrolü
  let willChangeTimer = null;

  // Aynı anda bellekte tutulan tüm sayfa görüntülerinin yaklaşık toplam piksel
  // tavanı. Aşılınca ekrandaki sayfadan en uzak olanlar boşaltılır. Zoom arttıkça
  // sayfa başına piksel büyüdüğü için canlı sayfa sayısı otomatik düşer.
  const PIXEL_BUDGET = 40e6;

  async function open(bookRecord, onClose) {
    clearTimeout(closeTimer);      // önceki kapanış animasyonunu iptal et
    pagesEl.textContent = "";
    wrappers = [];
    book = bookRecord;
    onCloseCb = onClose || null;
    zoom = 1;
    titleEl.textContent = book.title;

    view.hidden = false;
    // will-change yalnızca kayma animasyonu boyunca uygulanır; kalıcı bırakılırsa
    // iOS, canvas/görüntü dolu uzun kaydırma ağacını sürekli ayrı bir GPU
    // katmanında tutar ve tile belleği yetmeyince siyah alanlar oluşabilir.
    view.style.willChange = "transform";
    clearTimeout(willChangeTimer);
    willChangeTimer = setTimeout(() => { view.style.willChange = ""; }, 450);
    void view.offsetWidth;         // reflow → geçiş çalışsın
    view.classList.add("reader--open");
    document.body.style.overflow = "hidden";

    try {
      const fileRec = await DB.getFile(book.id);
      if (!fileRec || !fileRec.pdf) throw new Error("PDF bulunamadı");
      blobUrl = URL.createObjectURL(fileRec.pdf);
      pdfDoc = await pdfjsLib.getDocument(blobUrl).promise;

      if (book.totalPages !== pdfDoc.numPages) {
        book.totalPages = pdfDoc.numPages;
        scheduleSave();
      }

      // ilk sayfanın en-boy oranını tahmin olarak al
      const first = await pdfDoc.getPage(1);
      const fv = first.getViewport({ scale: 1 });
      estAspect = fv.height / fv.width;

      pageTotal.textContent = pdfDoc.numPages;
      pageInput.max = pdfDoc.numPages;

      buildPages();
      layout();
      lastBodyWidth = body.clientWidth;
      setupObserver();

      // kaldığı sayfaya konumlan
      currentIndex = Math.min(Math.max((book.currentPage || 1) - 1, 0), pdfDoc.numPages - 1);
      jumpToIndex(currentIndex, "auto");
      updatePageIndicator();
      renderNear();
    } catch (err) {
      console.error("Okuyucu açılamadı:", err);
      App.toast("Kitap açılamadı — dosya bozuk olabilir.");
      close();
    }
  }

  function buildPages() {
    pagesEl.textContent = "";
    wrappers = [];
    for (let i = 0; i < pdfDoc.numPages; i++) {
      const w = document.createElement("div");
      w.className = "pdf-page";
      w.dataset.page = String(i + 1);
      w._index = i;
      w._aspect = estAspect;
      w._rendered = false;
      w._rendering = false;
      w._px = 0;          // bu sayfanın görüntü pikseli (bütçe için)
      w._url = null;      // görüntü blob URL'i (temizlik için)
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      w.appendChild(img);
      pagesEl.appendChild(w);
      wrappers.push(w);
    }
  }

  // genişliğe sığdır: tüm sayfalar aynı CSS genişliğinde
  function pageWidth() {
    const padding = 32; // .reader-body yatay padding (16 + 16)
    const available = Math.max(body.clientWidth - padding, 200);
    return available * zoom;
  }

  function layout() {
    const cssW = pageWidth();
    for (const w of wrappers) {
      w.style.width = `${cssW}px`;
      w.style.height = `${cssW * (w._aspect || estAspect)}px`;
    }
  }

  async function render(i) {
    const w = wrappers[i];
    if (!w || !pdfDoc || w._rendered || w._rendering) return;
    w._rendering = true;
    try {
      const page = await pdfDoc.getPage(i + 1);
      if (!pdfDoc || wrappers[i] !== w) return; // bu arada kapandı/değişti
      const baseViewport = page.getViewport({ scale: 1 });
      w._aspect = baseViewport.height / baseViewport.width;

      const cssW = parseFloat(w.style.width) || pageWidth();
      w.style.height = `${cssW * w._aspect}px`;

      // dpr'yi 2 ile sınırla: 3x ekranlarda görüntü belleği ~%55 azalır,
      // görünür keskinlik farkı olmadan.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = (cssW / baseViewport.width) * dpr;
      const viewport = page.getViewport({ scale });

      // ekran-dışı canvas (DOM'a EKLENMEZ)
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      // saydam PDF'lerde siyah zemin görünmesin diye önce beyaza boya
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const task = page.render({ canvasContext: ctx, viewport });
      renderTasks.set(i, task);
      await task.promise;
      renderTasks.delete(i);
      if (!pdfDoc || wrappers[i] !== w) { canvas.width = 0; canvas.height = 0; return; }

      // canvas → görüntü blob'u; ardından canvas'ı serbest bırak
      const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob || !pdfDoc || wrappers[i] !== w) return;

      const url = URL.createObjectURL(blob);
      if (w._url) URL.revokeObjectURL(w._url);
      w._url = url;
      const img = w.querySelector("img");
      if (img) img.src = url;
      w._px = viewport.width * viewport.height;
      w._rendered = true;
      w.classList.add("rendered");
      enforceBudget();
    } catch (err) {
      if (!(err && err.name === "RenderingCancelledException")) {
        console.error("Sayfa render edilemedi:", err);
      }
    } finally {
      w._rendering = false;
    }
  }

  function unrender(i) {
    const w = wrappers[i];
    if (!w) return;
    const task = renderTasks.get(i);
    if (task) { task.cancel(); renderTasks.delete(i); }
    if (!w._rendered && !w._rendering) return;
    const img = w.querySelector("img");
    if (img) img.removeAttribute("src");
    if (w._url) { URL.revokeObjectURL(w._url); w._url = null; }
    w._px = 0;
    w._rendered = false;
    w._rendering = false;
    w.classList.remove("rendered");
    // yükseklik korunur; kaydırma konumu sabit kalır
  }

  // toplam canlı görüntü pikselini bütçe altında tut; ekrandaki sayfadan
  // en uzak olanları boşalt (görünen + komşusu daima korunur)
  function enforceBudget() {
    let total = 0;
    const live = [];
    for (let i = 0; i < wrappers.length; i++) {
      const w = wrappers[i];
      if (w && w._rendered) { live.push(i); total += w._px; }
    }
    if (total <= PIXEL_BUDGET) return;
    live.sort((a, b) => Math.abs(b - currentIndex) - Math.abs(a - currentIndex));
    for (const i of live) {
      if (total <= PIXEL_BUDGET) break;
      if (Math.abs(i - currentIndex) <= 1) continue;
      total -= wrappers[i]._px;
      unrender(i);
    }
  }

  // görünür pencere çevresindeki sayfaları render et
  function renderNear() {
    const span = 2;
    for (let i = currentIndex - span; i <= currentIndex + span; i++) {
      if (i >= 0 && i < wrappers.length) render(i);
    }
  }

  function setupObserver() {
    if (io) io.disconnect();
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = e.target._index;
        if (e.isIntersecting) render(i);
        else unrender(i); // pencereden çıkan sayfaları serbest bırak (bellek)
      }
    }, { root: body, rootMargin: "400px 0px" });
    for (const w of wrappers) io.observe(w);
  }

  // en üstteki görünür sayfayı bul (currentIndex'ten yürüyerek — ucuz)
  function updateCurrentFromScroll() {
    if (view.hidden || !pdfDoc || wrappers.length === 0) return;
    const bodyTop = body.getBoundingClientRect().top;
    const threshold = 48;
    const belowTop = (i) =>
      wrappers[i].getBoundingClientRect().bottom - bodyTop <= threshold;
    let i = Math.min(Math.max(currentIndex, 0), wrappers.length - 1);
    while (i < wrappers.length - 1 && belowTop(i)) i++;
    while (i > 0 && !belowTop(i - 1)) i--;
    if (i !== currentIndex) {
      currentIndex = i;
      updatePageIndicator();
      book.currentPage = i + 1;
      book.lastReadAt = Date.now();
      scheduleSave();
    }
  }

  function updatePageIndicator() {
    if (document.activeElement !== pageInput) pageInput.value = currentIndex + 1;
    btnPrev.disabled = currentIndex <= 0;
    btnNext.disabled = currentIndex >= wrappers.length - 1;
  }

  function jumpToIndex(i, behavior) {
    const w = wrappers[i];
    if (!w) return;
    const top = body.scrollTop + (w.getBoundingClientRect().top - body.getBoundingClientRect().top) - 8;
    body.scrollTo({ top, behavior: behavior || "smooth" });
  }

  function goTo(pageNum) {
    if (!pdfDoc) return;
    const i = Math.min(Math.max(pageNum - 1, 0), wrappers.length - 1);
    currentIndex = i;
    updatePageIndicator();
    renderNear();
    jumpToIndex(i, "smooth");
    book.currentPage = i + 1;
    book.lastReadAt = Date.now();
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      DB.putBook(book).catch((err) => console.error("İlerleme kaydedilemedi:", err));
    }, 400);
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      DB.putBook(book).catch((err) => console.error("İlerleme kaydedilemedi:", err));
    }
  }

  function close() {
    if (view.hidden) return;
    flushSave();
    clearTimeout(willChangeTimer);
    view.style.willChange = "transform";      // çıkış animasyonu boyunca
    view.classList.remove("reader--open");   // sağa doğru kayarak çık
    for (const task of renderTasks.values()) task.cancel();
    renderTasks.clear();
    if (io) { io.disconnect(); io = null; }
    for (const w of wrappers) {
      if (w._url) { URL.revokeObjectURL(w._url); w._url = null; }
    }
    if (pdfDoc) { pdfDoc.destroy(); pdfDoc = null; }
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    const cb = onCloseCb;
    onCloseCb = null;
    book = null;
    // görsel içerik kayma animasyonu boyunca dursun; sonra temizle
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      pagesEl.textContent = "";
      wrappers = [];
      view.hidden = true;
      view.style.willChange = "";
      document.body.style.overflow = "";
    }, 360);
    if (cb) cb();
  }

  function setZoom(next) {
    if (!pdfDoc) return;
    zoom = Math.min(Math.max(next, 0.5), 4);
    const anchor = currentIndex;
    layout();                       // yeni genişlik/yükseklikler
    for (let i = 0; i < wrappers.length; i++) unrender(i); // yeni ölçekte yeniden çizilsin
    jumpToIndex(anchor, "auto");    // konumu koru
    currentIndex = anchor;
    setupObserver();                // görünür tüm sayfalar yeniden tetiklensin
    renderNear();
  }

  // --- olaylar ---
  document.getElementById("reader-back").addEventListener("click", close);
  btnPrev.addEventListener("click", () => goTo(currentIndex));       // bir önceki sayfa
  btnNext.addEventListener("click", () => goTo(currentIndex + 2));   // bir sonraki sayfa
  document.getElementById("zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
  document.getElementById("zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));

  pageInput.addEventListener("change", () => {
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n)) goTo(n);
    else pageInput.value = currentIndex + 1;
  });

  body.addEventListener("scroll", () => {
    if (view.hidden) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      updateCurrentFromScroll();
    });
  }, { passive: true });

  document.addEventListener("keydown", (e) => {
    if (view.hidden) return;
    if (e.target === pageInput) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") { goTo(currentIndex); e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "PageDown") { goTo(currentIndex + 2); e.preventDefault(); }
    else if (e.key === "Escape") close();
    // ArrowUp/ArrowDown/Space: tarayıcının doğal kaydırması
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (view.hidden || !pdfDoc) return;
    // Mobilde kaydırırken URL/araç çubuğu gizlenip görünür → sadece YÜKSEKLİK
    // değişir ve resize tetiklenir. Sayfa genişliği değişmediyse yeniden düzen
    // gereksiz; aksi halde sayfalar boşaltılıp siyah flaş oluşur. Yalnızca
    // genişlik gerçekten değişince yeniden düzenle.
    if (body.clientWidth === lastBodyWidth) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (view.hidden || !pdfDoc) return;
      lastBodyWidth = body.clientWidth;
      const anchor = currentIndex;
      layout();
      for (let i = 0; i < wrappers.length; i++) unrender(i);
      jumpToIndex(anchor, "auto");
      setupObserver();   // görünür TÜM sayfalar yeniden tetiklensin (yalnız ±2 değil)
      renderNear();
    }, 150);
  });

  // sekme kapanırken bekleyen ilerlemeyi yaz
  window.addEventListener("pagehide", flushSave);

  return { open, close };
})();
