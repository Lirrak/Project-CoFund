# 🏕️ CoFund Local - Quản Lý Quỹ & Chi Tiêu Chuyến Đi Thông Minh

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![React Native](https://img.shields.io/badge/React_Native-0.81-61dafb.svg)](https://reactnative.dev/)
[![Expo](https://img.shields.io/badge/Expo-54.0-000000.svg)](https://expo.dev/)
[![Jest](https://img.shields.io/badge/Jest-29.7-brightgreen.svg)](https://jestjs.io/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003b57.svg)](https://www.sqlite.org/)

CoFund Local là ứng dụng di động tối ưu giúp các hội nhóm, gia đình, bạn bè dễ dàng quản lý quỹ chung, tự động hạch toán hóa đơn chi tiêu linh hoạt và đề xuất phương án quyết toán sòng phẳng nhất sau mỗi chuyến đi du lịch, dã ngoại.

Ứng dụng được xây dựng trên nền tảng **React Native (Expo)** và lưu trữ toàn bộ dữ liệu cục bộ an toàn, bảo mật bằng công nghệ **SQLite**.

---

## 🚀 Tính Năng Nổi Bật (Phase 3 - Phiên Bản Mới)

### 1. Tách Biệt Nguồn Chi Tiêu Linh Hoạt
Không còn bó buộc mọi khoản chi đều phải trừ vào quỹ chung. CoFund Local hỗ trợ 2 nguồn chi chuyên sâu:
* **🏦 Chi bằng Quỹ chung (Paid by Fund):** Tiền của hóa đơn được rút trực tiếp từ số dư Quỹ chung của nhóm.
* **👤 Thành viên tự ứng (Paid out-of-pocket):** Một thành viên tự rút tiền túi ra thanh toán hóa đơn. Số tiền này **KHÔNG** trừ vào quỹ chung, mà được xem như một khoản đóng góp phụ (tiền ứng trước) của thành viên đó và được cộng dồn vào Số dư ròng khi quyết toán.

### 2. Hai Cách Thức Phân Chia Hóa Đơn Linh Hoạt
Bất kể thành viên đã nạp bao nhiêu tiền quỹ, hóa đơn có thể được phân chia theo ý muốn:
* **🧮 Chia đều (EQUAL):** Tự động chia đều $50-50$ hoặc chia đều cho số lượng người tham gia gánh hóa đơn.
* **📊 Chia theo phần trăm (PERCENT):** Cho phép cấu hình thủ công từng thành viên chịu trách nhiệm bao nhiêu $\%$ tổng hóa đơn (Ví dụ: người ăn nhiều gánh 70%, người ăn ít gánh 30%).

### 3. Thuật Toán Làm Tròn VNĐ Tuyệt Đối (Largest Remainder Method)
Khi thực hiện phép chia tiền lẻ trong hệ đơn vị VNĐ, sai số làm tròn là không tránh khỏi. CoFund áp dụng giải thuật **Largest Remainder Method (Phương pháp phần dư lớn nhất)** toán học để bảo đảm khớp 100% số tiền:
1. Tính toán phần tiền lẻ thô (`rawAmount`) của từng người gánh nợ.
2. Làm tròn sàn (`Math.floor`) để lấy phần nguyên đồng VNĐ.
3. Sắp xếp danh sách theo phần thập phân (`fraction`) giảm dần.
4. Lấy phần dư còn lại (`totalAmount - sumFloors`) và phân bổ mỗi người thêm $1$ VNĐ theo thứ tự ưu tiên trên cho đến khi khớp $100\%$ hóa đơn.

### 4. Tinh Giản Nợ Quyết Toán Thông Minh (Greedy Debt Simplification)
Khi kết thúc chuyến đi, thay vì thực hiện chuyển khoản chéo phức tạp (A chuyển B, B chuyển C, C chuyển A), ứng dụng áp dụng thuật toán **Tham lam (Greedy)** tối ưu hóa đồ thị nợ (tương tự thuật toán của Splitwise):
* Gom nhóm thành hai phía: Người nợ quỹ (Số dư ròng $< 0$) và Chủ nợ (Số dư ròng $> 0$).
* Luôn ưu tiên cấn trừ trực tiếp người nợ nhiều nhất cho người được trả nhiều nhất.
* Trích xuất danh sách giao dịch chuyển khoản trực tiếp ngắn nhất và tối ưu nhất để đưa toàn bộ quỹ về trạng thái sòng phẳng về $0$đ.

---

## 📊 Mô Hình Hạch Toán Toán Học (Net Balance)

Số dư ròng (**Net Balance**) của từng thành viên biểu thị số tiền thực tế họ đang thừa hoặc thiếu trong chuyến đi:

$$\text{Net Balance} = (\text{Tổng nạp quỹ trực tiếp}) + (\text{Tổng tiền tự ứng túi}) - (\text{Tổng tiền splits gánh chịu})$$

* **Net Balance $> 0$ (Chủ nợ):** Thành viên đóng góp hoặc ứng tiền nhiều hơn số tiền họ tiêu thụ thực tế $\rightarrow$ **Được nhận lại tiền hoàn** khi quyết toán.
* **Net Balance $< 0$ (Con nợ):** Thành viên tiêu dùng hoặc gánh nợ nhiều hơn số tiền họ đóng đóng góp ban đầu $\rightarrow$ **Phải chuyển khoản nộp thêm** khi quyết toán.
* **Net Balance $= 0$:** Thành viên đã sòng phẳng hoàn toàn.

---

## 💾 Cấu Trúc Cơ Sở Dữ Liệu SQLite

Dữ liệu cục bộ được lưu trữ an toàn bằng SQLite thông qua thư viện `expo-sqlite`:

```
               [ groups ]
                   | (1:1)
               [  funds  ] (balance: Số dư quỹ chung)
                   | (1:N)
         [ contributions ]
           (Nạp quỹ chung)
                   | 
              [ profiles ] <---+
                   |           |
                   | (1:N)     | (1:N)
                   v           |
              [ expenses ] <---+ (paid_by: NULL nếu chi bằng quỹ, hoặc ID thành viên tự ứng)
                   | (1:N)
               [ splits ] (calculated_amount: Số tiền gánh, ratio: Tỷ lệ)
```

---

## 🛠️ Hướng Dẫn Cài Đặt & Chạy Ứng Dụng

### 1. Yêu cầu hệ thống
* Đã cài đặt **Node.js** (Khuyên dùng phiên bản 18 hoặc 20 trở lên).
* Điện thoại đã cài đặt ứng dụng **Expo Go** (Tải miễn phí trên iOS App Store hoặc Google Play Store).

### 2. Cài đặt các thư viện liên quan
Mở terminal tại thư mục gốc của dự án và chạy:
```bash
npm install
```

### 3. Chạy ứng dụng trên máy local
Khởi động máy chủ Expo hỗ trợ đường truyền ngầm định (Tunnel) để điện thoại kết nối không lo chặn tường lửa hay khác lớp mạng Wi-Fi:
```bash
npx expo start --tunnel
```
*Quét mã QR hiển thị trên màn hình terminal bằng ứng dụng camera (iOS) hoặc ứng dụng Expo Go (Android) để bắt đầu trải nghiệm.*

### 4. Chạy kiểm thử tự động (Unit Tests)
Chạy bộ unit test toán học độc lập bằng Jest để xác minh tính chính xác của các thuật toán phân chia:
```bash
npm run test
```

---

## 📸 Hướng Dẫn Sử Dụng Chi Tiết & Ảnh Minh Họa Giao Diện

### 📐 CASE 1: Kịch bản Đóng Góp Lệch & Chia % Không Đều (Như Ảnh Minh Họa)
> **Thành viên:** `Em` và `Anh`.
> * `Em` nạp quỹ **75 đ**, `Anh` nạp quỹ **25 đ** vào Quỹ chung (Tổng quỹ chung có 100 đ).
> * Cả nhóm đi ăn hóa đơn **100 đ** chi bằng quỹ chung. Nhưng `Em` chỉ ăn hết **25% (25đ)**, `Anh` ăn nhiều gánh **75% (75đ)**.

#### 📍 Bước 1: Xem Số dư Ròng ban đầu (Bảng Cân Đối Net Balance)
Bấm vào tab **Số dư Ròng** để xem hạch toán tài chính tức thời:
```
+-------------------------------------------------------------+
|  Du lịch Bảo Lâm                         Quỹ chung: 0 đ     |
+-------------------------------------------------------------+
| [Số dư Ròng]  |  Lịch sử Chi  |  + Chi tiêu  |  Quyết toán  |
+-------------------------------------------------------------+
|                                                             |
|  📊 Bảng cân đối Số dư Ròng (Net Balance)                    |
|  Net Balance = (Nạp quỹ) + (Tự ứng) - (Tiền gánh splits)    |
|                                                             |
|  👤 Em                                                      |
|  Nạp quỹ: 75 đ | Ứng túi: 0 đ | Gánh splits: 25 đ           |
|  ==> Số dư Ròng: +50 đ  (Được hoàn)                         |
|                                                             |
|  👤 Anh                                                     |
|  Nạp quỹ: 25 đ | Ứng túi: 0 đ | Gánh splits: 75 đ           |
|  ==> Số dư Ròng: -50 đ  (Phải đóng)                         |
|                                                             |
+-------------------------------------------------------------+
```

#### 📍 Bước 2: Xem Báo cáo Quyết toán Tinh giản nợ
Bấm sang tab **Quyết toán** để xem đề xuất chuyển tiền mặt tối ưu nhất để cả nhóm sòng phẳng:
```
+-------------------------------------------------------------+
|  🤝 Quyết toán thông minh (Tối giản chuyển tiền)            |
+-------------------------------------------------------------+
|  Danh sách giao dịch trực tiếp tối ưu:                      |
|                                                             |
|   🔴 Anh      👉  chuyển khoản  👉   50 đ   👉  🟢 Em       |
|                                                             |
|  ---------------------------------------------------------  |
|  💡 Ý nghĩa:                                                |
|  • Tổng số tiền Anh ăn vượt mức nạp ban đầu là 50đ.         |
|  • Anh chỉ cần chuyển khoản thẳng cho Em 50đ là quỹ chung  |
|    của cả nhóm tự động cân bằng về 0đ.                      |
+-------------------------------------------------------------+
```

---

### 📐 CASE 2: Kịch bản Kết Hợp Cả Quỹ Chung & Thành Viên Tự Ứng (Scenario 1 & 2)
> **Thành viên:** `An` và `Bình`.
> * `An` nạp quỹ **70 đ**, `Bình` nạp quỹ **30 đ** vào Quỹ chung (Quỹ chung có 100 đ).
> * **Hóa đơn 1:** Trị giá **100 đ** chi bằng quỹ chung, chia đều **EQUAL** (mỗi người gánh 50đ).
> * **Hóa đơn 2:** `An` tự bỏ tiền túi ứng trước **100 đ**, chia đều **EQUAL** (mỗi người gánh 50đ).

#### 📍 Bước 1: Giao Diện Thêm Hóa Đơn Thứ 2 (An tự ứng tiền túi)
Bấm sang tab **+ Chi tiêu** để nhập thông tin hóa đơn tự ứng:
```
+-------------------------------------------------------------+
|  ➕ Ghi nhận hóa đơn mới                                    |
+-------------------------------------------------------------+
|  Mô tả khoản chi:                                           |
|  [ Ăn sáng dã ngoại                       ]                 |
|                                                             |
|  Số tiền (VNĐ):                                             |
|  [ 100                                    ]                 |
|                                                             |
|  Phương thức thanh toán:                                    |
|  ( Chi bằng Quỹ chung )  [👤 An ứng tiền túi]  ( Bình ứng )  |
|                                                             |
|  Cách thức phân chia hóa đơn:                               |
|  [🧮 Chia đều (EQUAL)]    ( Chia theo % (PERCENT) )          |
|                                                             |
|  Ai cùng tham gia gánh hóa đơn này?                         |
|  [x] An  (Số dư Ròng: +20đ)                                 |
|  [x] Bình (Số dư Ròng: -20đ)                                |
|                                                             |
|                 [ LƯU HÓA ĐƠN & PHÂN CHIA ]                 |
+-------------------------------------------------------------+
```

#### 📍 Bước 2: Xem Báo cáo Quyết toán Sau Cả 2 Hóa Đơn
Sau khi lưu hóa đơn tự ứng thứ 2 thành công, hãy bấm sang tab **Quyết toán**:
```
+-------------------------------------------------------------+
|  🤝 Quyết toán thông minh (Tối giản chuyển tiền)            |
+-------------------------------------------------------------+
|  Danh sách giao dịch trực tiếp tối ưu:                      |
|                                                             |
|   🔴 Bình     👉  chuyển khoản  👉   70 đ   👉  🟢 An       |
|                                                             |
|  ---------------------------------------------------------  |
|  💡 Giải thích hạch toán:                                   |
|  • An: đóng góp 70đ + tự ứng 100đ - gánh nợ 100đ = +70đ.     |
|  • Bình: đóng góp 30đ + tự ứng 0đ - gánh nợ 100đ = -70đ.    |
|  • Bình chỉ cần chuyển thẳng 70đ cho An là hoàn tất!        |
+-------------------------------------------------------------+
```

---

## 🧪 Quản Lý Mã Nguồn & Tiêu Chuẩn

Dự án áp dụng chặt chẽ các tiêu chuẩn mã nguồn sạch:
- **Tính Typesafe nghiêm ngặt:** Chạy kiểm tra tĩnh bằng `npm run ts:check`.
- **Tách biệt kiểm thử:** Thư mục kiểm thử đặt tại `src/utils/__tests__/` chứa đầy đủ mã nguồn giả lập cơ sở dữ liệu để chạy test độc lập cực kỳ nhanh chóng.

Chúc bạn và nhóm có những chuyến hành trình thật vui vẻ, trọn vẹn và luôn sòng phẳng tài chính cùng **CoFund Local**! 🏕️💸
