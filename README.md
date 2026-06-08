# 🏕️ CoFund Local - Quản Lý Quỹ & Chi Tiêu Chuyến Đi Thông Minh

CoFund Local là ứng dụng di động tối ưu giúp các nhóm bạn bè, gia đình dễ dàng quản lý quỹ chung, hạch toán hóa đơn chi tiêu và quyết toán sòng phẳng sau mỗi chuyến đi du lịch, dã ngoại.

Ứng dụng được xây dựng trên nền tảng **React Native (Expo)** và lưu trữ dữ liệu cục bộ an toàn, bảo mật bằng **SQLite**.

---

## 🚀 Tính Năng Nổi Bật (Phase 3)

### 1. Tách Biệt Nguồn Chi Tiêu Linh Hoạt
Không còn bó buộc mọi khoản chi đều phải trừ vào quỹ chung. CoFund Local hỗ trợ 2 nguồn chi:
* **🏦 Chi bằng Quỹ chung (Paid by Fund):** Tiền của hóa đơn được rút trực tiếp từ số dư Quỹ chung của nhóm.
* **👤 Thành viên tự ứng (Paid out-of-pocket):** Một thành viên tự rút tiền túi ra thanh toán hóa đơn. Số tiền này **KHÔNG** trừ vào quỹ chung, mà được xem như một khoản đóng góp phụ (tiền ứng trước) của thành viên đó và được cộng vào Số dư ròng để cấn trừ khi quyết toán.

### 2. Cách Thức Phân Chia Hóa Đơn Linh Hoạt
Bất kể thành viên đã nộp bao nhiêu tiền quỹ, hóa đơn có thể được phân chia theo ý muốn:
* **🧮 Chia đều (EQUAL):** Tự động chia đều $50-50$ hoặc chia đều cho số lượng người tham gia gánh hóa đơn.
* **📊 Chia theo phần trăm (PERCENT):** Cấu hình thủ công từng thành viên chịu trách nhiệm bao nhiêu $\%$ tổng hóa đơn.

### 3. Thuật Toán Làm Tròn VNĐ Tuyệt Đối (Largest Remainder Method)
Khi thực hiện phép chia tiền lẻ trong hệ đơn vị VNĐ (không có xu lẻ lẻ), sai số làm tròn là không tránh khỏi. 
CoFund áp dụng giải thuật **Largest Remainder Method** toán học:
1. Tính toán phần tiền lẻ thô (`rawAmount`) của từng người.
2. Làm tròn sàn (`Math.floor`) để lấy phần nguyên đồng VNĐ.
3. Sắp xếp danh sách theo phần thập phân giảm dần.
4. Lấy phần dư còn lại (`totalAmount - sumFloors`) và phân bổ mỗi người thêm $1$ VNĐ theo thứ tự ưu tiên trên cho đến khi khớp $100\%$ hóa đơn.

### 4. Tinh Giản Nợ Quyết Toán Thông Minh (Greedy Debt Simplification)
Khi kết thúc chuyến đi, thay vì chuyển khoản chéo phức tạp (A chuyển B, B chuyển C, C chuyển A), ứng dụng áp dụng thuật toán **Tham lam (Greedy)** tối ưu hóa đồ thị nợ (tương tự Splitwise):
* Gom nhóm thành hai phía: Người nợ quỹ (Số dư ròng $< 0$) và Chủ nợ (Số dư ròng $> 0$).
* Liên tục cấn trừ trực tiếp người nợ nhiều nhất cho người được trả nhiều nhất.
* Đưa ra danh sách giao dịch chuyển tiền trực tiếp ngắn nhất và tối ưu nhất để cân bằng quỹ về $0$đ.

---

## 📊 Mô Hình Hạch Toán Toán Học (Net Balance)

Số dư ròng (**Net Balance**) của từng thành viên biểu thị số tiền thực tế họ đang thừa hoặc thiếu trong chuyến đi:

$$\text{Net Balance} = (\text{Tổng nạp quỹ trực tiếp}) + (\text{Tổng tiền tự ứng túi}) - (\text{Tổng tiền splits gánh chịu})$$

* **Net Balance $> 0$ (Chủ nợ):** Thành viên đóng góp/ứng tiền nhiều hơn số tiền họ tiêu $\rightarrow$ **Được nhận lại tiền hoàn** khi quyết toán.
* **Net Balance $< 0$ (Con nợ):** Thành viên tiêu xài/gánh nợ nhiều hơn số tiền họ đóng góp $\rightarrow$ **Phải chuyển khoản nộp thêm** khi quyết toán.
* **Net Balance $= 0$:** Thành viên đã sòng phẳng hoàn toàn.

---

## 💾 Cấu Trúc Cơ Sở Dữ Liệu SQLite

```
               [ groups ]
                   | (1:1)
               [  funds  ] 
                   | (1:N)
         [ contributions ]
           (Nạp quỹ chung)
                   | 
              [ profiles ] <---+
                   |           |
                   | (1:N)     | (1:N)
                   v           |
              [ expenses ] <---+ (paid_by: NULL hoặc ID thành viên)
                   | (1:N)
               [ splits ] (calculated_amount, ratio)
```

---

## 🛠️ Hướng Dẫn Cài Đặt & Chạy Ứng Dụng

### 1. Yêu cầu hệ thống
* Đã cài đặt **Node.js** (Phiên bản 18 trở lên).
* Điện thoại đã cài đặt ứng dụng **Expo Go** (tải miễn phí trên App Store hoặc Google Play).

### 2. Cài đặt các thư viện liên quan
Mở terminal tại thư mục dự án và chạy:
```bash
npm install
```

### 3. Chạy ứng dụng trên máy local
Khởi động máy chủ Expo hỗ trợ đường truyền ngầm định (Tunnel) để điện thoại kết nối không lo chặn tường lửa:
```bash
npx expo start --tunnel
```
*Quét mã QR hiển thị trên màn hình terminal bằng ứng dụng camera (iOS) hoặc Expo Go (Android).*

### 4. Chạy kiểm thử tự động (Unit Tests)
Chạy bộ unit test toán học độc lập bằng Jest:
```bash
npm run test
```

---

## 📸 Hướng Dẫn Sử Dụng Chi Tiết & Ảnh Minh Họa

### Kịch bản thực tế mẫu (Bất đối xứng):
> **Nhóm:** `An` và `Bình`.
> * `An` nạp quỹ **70 đ**, `Bình` nạp quỹ **30 đ**. (Tổng quỹ chung có 100 đ).
> * **Hóa đơn 1:** Trị giá **100 đ** chi bằng quỹ chung, chia đều **50-50** (`An` gánh 50đ, `Bình` gánh 50đ).
> * **Hóa đơn 2:** `An` tự ứng tiền túi ra **100 đ**, chia đều **50-50** (`An` gánh 50đ, `Bình` gánh 50đ).

#### 📍 Bước 1: Xem Số dư Ròng ban đầu (Sau Hóa đơn 1)
Sau khi tiêu hết quỹ 100đ, bấm vào tab **Số dư Ròng**:

```
+-------------------------------------------------------+
|  Du lịch Bảo Lâm                      Quỹ: 0 đ  |
+-------------------------------------------------------+
| [Số dư Ròng]  |  Lịch sử Chi  |  + Chi tiêu  |  Quyết toán |
+-------------------------------------------------------+
|                                                       |
|  👤 An                                                |
|  Nạp quỹ: 70 đ | Ứng túi: 0 đ | Gánh splits: 50 đ     |
|  ==> Số dư Ròng: +20 đ (Được hoàn lại)                |
|                                                       |
|  👤 Bình                                              |
|  Nạp quỹ: 30 đ | Ứng túi: 0 đ | Gánh splits: 50 đ     |
|  ==> Số dư Ròng: -20 đ (Cần đóng thêm)                 |
|                                                       |
+-------------------------------------------------------+
```

#### 📍 Bước 2: Thêm Hóa đơn thứ 2 (An tự ứng tiền túi)
Bấm sang tab **+ Chi tiêu** để ghi nhận hóa đơn mới:

```
+-------------------------------------------------------+
|  ➕ Ghi nhận hóa đơn mới                               |
+-------------------------------------------------------+
|  Mô tả khoản chi:                                     |
|  [ Ăn sáng dã ngoại                     ]             |
|                                                       |
|  Số tiền (VNĐ):                                       |
|  [ 100                                  ]             |
|                                                       |
|  Phương thức thanh toán:                              |
|  ( Chi bằng Quỹ )  [👤 An ứng tiền túi]  ( Bình ứng )  |
|                                                       |
|  Cách thức phân chia hóa đơn:                         |
|  [🧮 Chia đều (EQUAL)]    ( Chia theo % (PERCENT) )    |
|                                                       |
|  Ai tham gia gánh hóa đơn?                            |
|  [x] An  (Số dư: +20đ)                                |
|  [x] Bình (Số dư: -20đ)                               |
|                                                       |
|               [ LƯU HÓA ĐƠN & PHÂN CHIA ]             |
+-------------------------------------------------------+
```

#### 📍 Bước 3: Xem Báo cáo Quyết toán Tinh giản nợ
Sau khi hóa đơn thứ 2 lưu thành công, hãy bấm sang tab **Quyết toán** để xem cấn trừ:

```
+-------------------------------------------------------+
|  🤝 Quyết toán thông minh (Tối giản chuyển tiền)       |
+-------------------------------------------------------+
|  Danh sách giao dịch trực tiếp tối ưu:                 |
|                                                       |
|   🔴 Bình   👉  chuyển khoản  👉   70 đ   👉  🟢 An    |
|                                                       |
|  ---------------------------------------------------  |
|  💡 Ý nghĩa:                                          |
|  • Tổng số tiền Bình chi tiêu vượt mức nộp ban đầu là |
|    70đ, Bình chỉ cần chuyển thẳng cho An để sòng phẳng. |
|  • Triệt tiêu mọi giao dịch trung gian chuyển chéo.   |
+-------------------------------------------------------+
```

---

## 🧪 Quản Lý Mã Nguồn

Dự án sử dụng quy chuẩn mã nguồn sạch:
- Kiểm tra tính typesafe nghiêm ngặt: `npm run ts:check`.
- Thư mục kiểm thử đặt tại `src/utils/__tests__/` bảo đảm tách biệt logic nghiệp vụ.

Chúc bạn và nhóm có những chuyến đi dã ngoại sòng phẳng và vui vẻ cùng **CoFund Local**! 🏕️💸
