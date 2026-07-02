/* IndexedDB katmanı — kitap metadata'sı ile PDF blob'ları ayrı store'larda tutulur,
   böylece ana sayfa açılırken PDF'ler belleğe yüklenmez. */
"use strict";

const DB_NAME = "kutuphane";
const DB_VERSION = 1;
const STORE_BOOKS = "books"; // {id, title, author, coverBlob, currentPage, totalPages, addedAt, lastReadAt}
const STORE_FILES = "files"; // {id, pdf: Blob}

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function _tx(storeNames, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        const result = fn(tx);
        tx.oncomplete = () => resolve(result.__value !== undefined ? result.__value : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
      })
  );
}

function _reqValue(request, holder) {
  request.onsuccess = () => {
    holder.__value = request.result;
  };
  return holder;
}

const DB = {
  /** Tüm kitap metadata'sını döndürür (PDF blob'ları hariç). */
  getAllBooks() {
    return _tx(STORE_BOOKS, "readonly", (tx) =>
      _reqValue(tx.objectStore(STORE_BOOKS).getAll(), {})
    );
  },

  getBook(id) {
    return _tx(STORE_BOOKS, "readonly", (tx) =>
      _reqValue(tx.objectStore(STORE_BOOKS).get(id), {})
    );
  },

  putBook(book) {
    return _tx(STORE_BOOKS, "readwrite", (tx) => {
      tx.objectStore(STORE_BOOKS).put(book);
      return {};
    });
  },

  getFile(id) {
    return _tx(STORE_FILES, "readonly", (tx) =>
      _reqValue(tx.objectStore(STORE_FILES).get(id), {})
    );
  },

  putFile(id, pdfBlob) {
    return _tx(STORE_FILES, "readwrite", (tx) => {
      tx.objectStore(STORE_FILES).put({ id, pdf: pdfBlob });
      return {};
    });
  },

  /** Kitap + PDF'ini tek transaction'da kaydeder. */
  putBookWithFile(book, pdfBlob) {
    return _tx([STORE_BOOKS, STORE_FILES], "readwrite", (tx) => {
      tx.objectStore(STORE_BOOKS).put(book);
      tx.objectStore(STORE_FILES).put({ id: book.id, pdf: pdfBlob });
      return {};
    });
  },

  deleteBook(id) {
    return _tx([STORE_BOOKS, STORE_FILES], "readwrite", (tx) => {
      tx.objectStore(STORE_BOOKS).delete(id);
      tx.objectStore(STORE_FILES).delete(id);
      return {};
    });
  },

  /** Kalıcı depolama izni ister; tarayıcının veriyi otomatik silmesini engeller. */
  async requestPersist() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    try {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    } catch (err) {
      console.warn("storage.persist başarısız:", err);
      return false;
    }
  },
};
