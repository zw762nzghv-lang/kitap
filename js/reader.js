/* pdf.js tabanlı okuyucu — kaldığı sayfayı hatırlar. */
"use strict";

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const Reader = (() => {
  const view = document.getElementById("reader-view");
  const titleEl = document.getElementById("reader-title");
  const body = document.getElementById("reader-body");
  const canvas = document.getElementById("pdf-canvas");
  const ctx = canvas.getContext("2d");
  const pageInput = document.getElementById("page-input");
  const pageTotal = document.getElementById("page-total");
  const btnPrev = document.getElementById("page-prev");
  const btnNext = document.getElementById("page-next");

  let book = null;        // App'in bellekteki kitap nesnesi (paylaşılan referans)
  let pdfDoc = null;
  let blobUrl = null;
  let currentPage = 1;
  let zoom = 1;            // genişliğe-sığdır'ın çarpanı
  let renderTask = null;
  let saveTimer = null;
  let onCloseCb = null;

  async function open(bookRecord, onClose) {
    book = bookRecord;
    onCloseCb = onClose || null;
    zoom = 1;
    titleEl.textContent = book.title;
    view.hidden = false;
    document.body.style.overflow = "hidden";

    try {
      const fileRec = await DB.getFile(book.id);
      if (!fileRec || !fileRec.pdf) throw new Error("PDF bulunamadı");
      blobUrl = URL.createObjectURL(fileRec.pdf);
      pdfDoc = await pdfjsLib.getDocument(blobUrl).promise;

      // toplam sayfa bilinmiyorsa/yanlışsa düzelt
      if (book.totalPages !== pdfDoc.numPages) {
        book.totalPages = pdfDoc.numPages;
        scheduleSave();
      }

      currentPage = Math.min(Math.max(book.currentPage || 1, 1), pdfDoc.numPages);
      pageTotal.textContent = pdfDoc.numPages;
      pageInput.max = pdfDoc.numPages;
      await renderPage();
    } catch (err) {
      console.error("Okuyucu açılamadı:", err);
      App.toast("Kitap açılamadı — dosya bozuk olabilir.");
      close();
    }
  }

  async function renderPage() {
    if (!pdfDoc) return;
    if (renderTask) {
      renderTask.cancel();
      renderTask = null;
    }
    const page = await pdfDoc.getPage(currentPage);

    // genişliğe sığdır: gövde genişliğine göre taban ölçek
    const padding = 32;
    const available = Math.max(body.clientWidth - padding, 200);
    const baseViewport = page.getViewport({ scale: 1 });
    const fitScale = available / baseViewport.width;
    const scale = fitScale * zoom;
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * dpr });

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width / dpr}px`;
    canvas.style.height = `${viewport.height / dpr}px`;

    try {
      renderTask = page.render({ canvasContext: ctx, viewport });
      await renderTask.promise;
      renderTask = null;
    } catch (err) {
      if (err && err.name === "RenderingCancelledException") return;
      throw err;
    }

    pageInput.value = currentPage;
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= pdfDoc.numPages;
    body.scrollTop = 0;
  }

  function goTo(pageNum) {
    if (!pdfDoc) return;
    const target = Math.min(Math.max(pageNum, 1), pdfDoc.numPages);
    if (target === currentPage) {
      pageInput.value = currentPage;
      return;
    }
    currentPage = target;
    renderPage();
    book.currentPage = currentPage;
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
    flushSave();
    if (renderTask) {
      renderTask.cancel();
      renderTask = null;
    }
    if (pdfDoc) {
      pdfDoc.destroy();
      pdfDoc = null;
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    view.hidden = true;
    document.body.style.overflow = "";
    const cb = onCloseCb;
    onCloseCb = null;
    book = null;
    if (cb) cb();
  }

  function setZoom(next) {
    zoom = Math.min(Math.max(next, 0.5), 4);
    renderPage();
  }

  // --- olaylar ---
  document.getElementById("reader-back").addEventListener("click", close);
  btnPrev.addEventListener("click", () => goTo(currentPage - 1));
  btnNext.addEventListener("click", () => goTo(currentPage + 1));
  document.getElementById("zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
  document.getElementById("zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));

  pageInput.addEventListener("change", () => {
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n)) goTo(n);
    else pageInput.value = currentPage;
  });

  document.addEventListener("keydown", (e) => {
    if (view.hidden) return;
    if (e.target === pageInput) return;
    if (e.key === "ArrowLeft") goTo(currentPage - 1);
    else if (e.key === "ArrowRight") goTo(currentPage + 1);
    else if (e.key === "Escape") close();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (view.hidden || !pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderPage, 150);
  });

  // sekme kapanırken bekleyen ilerlemeyi yaz
  window.addEventListener("pagehide", flushSave);

  return { open, close };
})();
