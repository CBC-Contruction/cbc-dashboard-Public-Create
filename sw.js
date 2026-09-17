/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE WORKER — CBC Cost Dashboard Pro
   ───────────────────────────────────────────────────────────────────────────
   Vì sao có file này: index.html dòng 7 và dòng 12 đã gọi manifest.json và
   sw.js từ lâu, nhưng CẢ HAI FILE CHƯA TỪNG TỒN TẠI. Lỗi bị .catch() ghi
   thành console.warn nên không ai thấy. Hệ quả: không cài được lên điện
   thoại, và mất mạng ngoài công trường là trắng trang.

   Nguyên tắc bộ nhớ đệm ở đây:
     · Trang app (index.html)  -> ưu tiên mạng, hỏng thì lấy bản đã lưu
       (để sửa app xong là người dùng nhận ngay, nhưng mất sóng vẫn mở được)
     · Thư viện CDN có số phiên bản trong đường dẫn -> lấy bản đã lưu trước
     · Gọi Supabase / Google / Anthropic -> TUYỆT ĐỐI KHÔNG lưu đệm
       (dữ liệu chi phí phải luôn là số mới nhất, lưu đệm là sai số liệu)

   LƯU Ý QUAN TRỌNG: Service Worker chỉ chạy khi trang được mở qua http://
   hoặc https:// . Mở file bằng cách bấm đúp (đường dẫn file:///) thì trình
   duyệt không cho chạy — đây là quy định của trình duyệt, không phải lỗi.
   ═══════════════════════════════════════════════════════════════════════════ */

/* Đổi số này mỗi lần sửa danh sách file bên dưới -> trình duyệt sẽ dọn
   bộ nhớ đệm cũ và nạp lại từ đầu. */
/* v2 · 01/09/2026 — đổi số phiên bản để trình duyệt DỌN SẠCH bộ nhớ đệm cũ.
   Bộ đệm cbc-v1 có thể đang chứa nội dung sai khoá (xem ghi chú ở nhánh
   điều hướng), phải bỏ đi chứ không dùng lại. */
const CACHE_VERSION = 'cbc-v2';
const SHELL_CACHE = CACHE_VERSION + '-shell';
const LIB_CACHE   = CACHE_VERSION + '-lib';

/* Nạp sẵn khi cài đặt — CHỈ những file dùng chung cho mọi phiên bản.
   v2 · 01/09/2026 — ĐÃ BỎ './' và './index.html' khỏi danh sách này.
   Thư mục có ba bản HTML cùng tồn tại; nạp sẵn đích danh index.html là ép
   bản gốc vào bộ đệm dù người dùng đang mở bản khác. Trang nào được mở thì
   nhánh điều hướng tự lưu trang đó theo đúng URL của nó. */
const SHELL_FILES = [
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

/* Máy chủ dữ liệu — không bao giờ được lưu đệm.
   Lưu đệm mấy đường này là người dùng nhìn thấy số tiền cũ mà tưởng số mới. */
const NEVER_CACHE = [
  'supabase.co',
  'supabase.in',
  'accounts.google.com',
  'apis.google.com',
  'api.anthropic.com'
];

/* Thư viện ngoài — đường dẫn đã có số phiên bản nên lưu đệm là an toàn. */
const LIB_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

function isNeverCache(url) {
  return NEVER_CACHE.some(function (h) { return url.hostname.indexOf(h) >= 0; });
}
function isLib(url) {
  return LIB_HOSTS.some(function (h) { return url.hostname === h; });
}

/* ── CÀI ĐẶT: nạp sẵn vỏ ứng dụng ─────────────────────────────────────── */
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      /* addAll() hỏng toàn bộ nếu một file lỗi. Nạp từng file để một file
         thiếu không làm chết cả lần cài đặt. */
      return Promise.all(SHELL_FILES.map(function (f) {
        return c.add(new Request(f, { cache: 'reload' })).catch(function (err) {
          console.warn('[SW] Không nạp được:', f, err.message);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

/* ── KÍCH HOẠT: dọn bộ nhớ đệm của phiên bản cũ ───────────────────────── */
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        if (n.indexOf(CACHE_VERSION) !== 0) {
          console.log('[SW] Dọn bộ nhớ đệm cũ:', n);
          return caches.delete(n);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* ── LẤY TÀI NGUYÊN ───────────────────────────────────────────────────── */
self.addEventListener('fetch', function (e) {
  const req = e.request;

  /* Chỉ xử lý GET. POST/PATCH/DELETE (ghi dữ liệu) phải đi thẳng ra mạng. */
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Dữ liệu thật — đi thẳng, không đụng vào. */
  if (isNeverCache(url)) return;

  /* Mở trang: ưu tiên mạng, mất mạng thì dùng bản đã lưu.

     v2 · 01/09/2026 — SỬA LỖI PHỤC VỤ NHẦM PHIÊN BẢN
     Bản đầu lưu nội dung trang dưới khoá CỐ ĐỊNH './index.html':
         c.put('./index.html', copy)      rồi     caches.match('./index.html')
     Thư mục có ba bản cùng tồn tại (index.html, index_v2, index_v3). Mở bản
     nào thì nội dung bản đó ghi đè lên cùng một khoá. Mất mạng là trình duyệt
     lấy ra bản được lưu gần nhất, BẤT KỂ người dùng mở URL nào — im lặng,
     không dấu hiệu. Có thể đang xem v3 mà thực chất chạy bản gốc còn nguyên lỗi.
     Nay lưu và tra theo CHÍNH request đó, mỗi bản một khoá riêng. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true })
          .then(function (hit) { return hit || offlineFallback(); });
      })
    );
    return;
  }

  /* Thư viện CDN: dùng bản đã lưu, đồng thời âm thầm tải bản mới cho lần sau. */
  if (isLib(url)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        const fresh = fetch(req).then(function (res) {
          /* res.type === 'opaque' là phản hồi khác miền không có CORS —
             không đọc được nội dung nhưng vẫn dùng và lưu đệm được. */
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(LIB_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return hit; });
        return hit || fresh;
      })
    );
    return;
  }

  /* File cùng thư mục (ảnh biểu tượng, manifest…): bản lưu trước, không có thì tải.

     v2 · 01/09/2026 — THÊM .catch()
     Bản đầu thiếu .catch ở đây. fetch hỏng là promise bị từ chối lọt thẳng
     vào respondWith, trình duyệt ghi "Uncaught (in promise) TypeError:
     Failed to fetch at sw.js:143" và trả lỗi mạng cho tài nguyên đó.
     Trong Service Worker, MỌI nhánh của respondWith đều phải trả về một
     Response — không bao giờ được để promise bị từ chối thoát ra. */
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function (err) {
          return new Response(
            'Không tải được: ' + req.url + '\n' + (err && err.message ? err.message : ''),
            { status: 504, statusText: 'Khong tai duoc',
              headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
          );
        });
      })
    );
  }
});

/* Trang báo mất mạng — chỉ hiện khi chưa từng mở app lần nào trên máy này. */
function offlineFallback() {
  return new Response(
    '<!doctype html><html lang="vi"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Mất kết nối</title>' +
    '<body style="margin:0;height:100vh;display:flex;align-items:center;' +
    'justify-content:center;background:#0B1219;color:#EFF6FF;' +
    'font-family:Arial,sans-serif;text-align:center;padding:24px">' +
    '<div><div style="font-size:44px;margin-bottom:14px">📡</div>' +
    '<div style="font-size:17px;font-weight:700;margin-bottom:8px">Chưa có kết nối mạng</div>' +
    '<div style="font-size:13px;color:#94B8D4;line-height:1.6;max-width:380px">' +
    'Máy này chưa lưu bản app nào để dùng ngoại tuyến.<br>' +
    'Mở app một lần khi có mạng, các lần sau mất sóng vẫn vào được.</div>' +
    '</div></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
  );
}

/* Cho phép trang chủ động yêu cầu cập nhật ngay: đã có sẵn cho lần sau,
   khi cần chỉ việc gọi reg.waiting.postMessage({type:'SKIP_WAITING'}). */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
