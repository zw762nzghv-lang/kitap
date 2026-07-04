/* Yedekleme / geri yükleme — tüm kitaplık tek bir .klib dosyasına yazılır.
   Format (base64 yok, bellek dostu):
     "KLIB1"                        5 bayt magic
     headerLength                   4 bayt uint32 (little-endian)
     header JSON (UTF-8)            kitap metadata'ları + blob boyutları
     blob baytları                  her kitap için sırayla: pdf, sonra (varsa) kapak */
"use strict";

const Backup = (() => {
  const MAGIC = "KLIB1";
  const FORMAT_VERSION = 1;

  /** Tüm kitaplığı tek bir Blob'a paketler (indirme yapmaz). */
  async function buildBlob() {
    const books = await DB.getAllBooks();
    if (!books.length) throw new Error("empty");

    const headerBooks = [];
    const blobParts = [];

    for (const book of books) {
      const fileRec = await DB.getFile(book.id);
      const pdf = fileRec && fileRec.pdf;
      if (!pdf) {
        console.warn("PDF'i olmayan kitap yedeğe alınamadı:", book.title);
        continue;
      }
      const cover = book.coverBlob || null;
      headerBooks.push({
        id: book.id,
        title: book.title,
        author: book.author,
        currentPage: book.currentPage,
        totalPages: book.totalPages,
        addedAt: book.addedAt,
        lastReadAt: book.lastReadAt,
        pdfSize: pdf.size,
        pdfType: pdf.type || "application/pdf",
        coverSize: cover ? cover.size : 0,
        coverType: cover ? cover.type : "",
      });
      blobParts.push(pdf);
      if (cover) blobParts.push(cover);
    }

    const headerJson = new TextEncoder().encode(
      JSON.stringify({ version: FORMAT_VERSION, exportedAt: Date.now(), books: headerBooks })
    );
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, headerJson.byteLength, true);

    const blob = new Blob([MAGIC, lenBuf, headerJson, ...blobParts], {
      type: "application/octet-stream",
    });
    return { blob, count: headerBooks.length };
  }

  /** Tek bir kitabı (PDF + kapak + okuma ilerlemesi) .klib Blob'una paketler. */
  async function buildBookBlob(bookId) {
    const book = await DB.getBook(bookId);
    if (!book) throw new Error("not-found");
    const fileRec = await DB.getFile(bookId);
    const pdf = fileRec && fileRec.pdf;
    if (!pdf) throw new Error("no-pdf");
    const cover = book.coverBlob || null;

    const headerBooks = [{
      id: book.id,
      title: book.title,
      author: book.author,
      currentPage: book.currentPage,
      totalPages: book.totalPages,
      addedAt: book.addedAt,
      lastReadAt: book.lastReadAt,
      pdfSize: pdf.size,
      pdfType: pdf.type || "application/pdf",
      coverSize: cover ? cover.size : 0,
      coverType: cover ? cover.type : "",
    }];
    const headerJson = new TextEncoder().encode(
      JSON.stringify({ version: FORMAT_VERSION, exportedAt: Date.now(), books: headerBooks })
    );
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, headerJson.byteLength, true);

    const parts = [MAGIC, lenBuf, headerJson, pdf];
    if (cover) parts.push(cover);
    const blob = new Blob(parts, { type: "application/octet-stream" });
    return { blob, book };
  }

  /** Tek kitabı native paylaşım ekranıyla paylaşır; desteklenmezse dosyayı indirir. */
  async function shareBook(bookId) {
    const { blob, book } = await buildBookBlob(bookId);
    const safe =
      (book.title || "kitap").replace(/[^\p{L}\p{N}\-_ ]/gu, "").trim().slice(0, 60) || "kitap";
    const filename = `${safe}.klib`;
    const file = new File([blob], filename, { type: "application/octet-stream" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: book.title });
        return "shared";
      } catch (err) {
        if (err && err.name === "AbortError") return "cancelled";
        // paylaşım başarısızsa aşağıda indirmeye düş
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return "downloaded";
  }

  async function exportAll() {
    const { blob, count } = await buildBlob();
    const date = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kutuphane-yedek-${date}.klib`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);

    return count;
  }

  /** Dosyayı okur, header'ı döndürür; henüz hiçbir şey yazmaz. */
  async function readHeader(file) {
    const prefix = new Uint8Array(await file.slice(0, 9).arrayBuffer());
    const magic = new TextDecoder().decode(prefix.slice(0, 5));
    if (magic !== MAGIC) throw new Error("invalid-format");
    const headerLen = new DataView(prefix.buffer, 5, 4).getUint32(0, true);
    if (headerLen <= 0 || headerLen > file.size) throw new Error("invalid-format");
    const headerText = await file.slice(9, 9 + headerLen).text();
    const header = JSON.parse(headerText);
    if (!header || !Array.isArray(header.books)) throw new Error("invalid-format");
    return { header, dataOffset: 9 + headerLen };
  }

  /** Header'ı okunmuş dosyadaki kitapları IndexedDB'ye yazar (aynı id varsa üzerine). */
  async function restore(file, header, dataOffset) {
    let offset = dataOffset;
    let count = 0;
    for (const meta of header.books) {
      const pdf = file.slice(offset, offset + meta.pdfSize, meta.pdfType || "application/pdf");
      offset += meta.pdfSize;
      let cover = null;
      if (meta.coverSize > 0) {
        cover = file.slice(offset, offset + meta.coverSize, meta.coverType || "image/jpeg");
        offset += meta.coverSize;
      }
      const book = {
        id: meta.id || crypto.randomUUID(),
        title: meta.title || "Adsız",
        author: meta.author || "",
        coverBlob: cover,
        currentPage: meta.currentPage || 1,
        totalPages: meta.totalPages || 0,
        addedAt: meta.addedAt || Date.now(),
        lastReadAt: meta.lastReadAt || null,
      };
      await DB.putBookWithFile(book, pdf);
      count++;
    }
    return count;
  }

  return { buildBlob, buildBookBlob, shareBook, exportAll, readHeader, restore };
})();
