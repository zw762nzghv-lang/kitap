# Kütüphane

Kişisel PDF kitaplığınız. Tamamen statik bir PWA — sunucu yok, hesap yok; kitaplarınız
yalnızca kendi tarayıcınızda (IndexedDB) saklanır ve uygulama çevrimdışı da çalışır.

## Özellikler
- PDF + kapak görseliyle kitap ekleme (başlık dosya adından ön-doldurulur)
- pdf.js ile okuma; kaldığınız sayfa hatırlanır ("Devam et")
- Başlık/yazar arama, kitap düzenleme ve silme
- Açık/koyu tema (kahve-toprak tonları)
- Kapak yüklenmezse tipografik placeholder kapak
- **Yedekle / Geri Yükle**: tüm kitaplık (PDF'ler + kapaklar + okuma ilerlemesi)
  tek bir `.klib` dosyasına dışa aktarılır ve geri yüklenir

## Çalıştırma
Statik dosyalardır; herhangi bir sunucuyla açın (service worker `file://` ile çalışmaz):

```bash
python3 -m http.server 8090
# http://localhost:8090
```

## GitHub Pages'e yayınlama
Depoya push'layıp Settings → Pages → "Deploy from a branch" seçmeniz yeterli.
Tüm yollar göreli olduğundan alt dizinde (`kullanici.github.io/depo/`) sorunsuz çalışır.

## Önemli notlar
- Veriler tarayıcıya bağlıdır: farklı tarayıcı/cihaz kitaplığı görmez. Taşımak için
  **menü (⋮) → Yedekle** ile `.klib` dosyası alın, diğer cihazda **Geri Yükle** yapın.
- Uygulama açılışta `navigator.storage.persist()` ister; yine de tek veri güvenceniz
  düzenli yedek almaktır.
- Tarayıcı verilerini ("site verileri" dahil) temizlerseniz kitaplık silinir.
