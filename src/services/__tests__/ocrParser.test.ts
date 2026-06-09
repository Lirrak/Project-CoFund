jest.mock('@react-native-ml-kit/text-recognition', () => {
  return {
    recognize: jest.fn(),
  };
});

import { OCRParser } from '../ocrParser';

describe('OCRParser Heuristic & Regex Tests', () => {
  test('should parse various Vietnamese currency formats correctly', () => {
    expect(OCRParser.parseAmount('220.000')).toBe(220000);
    expect(OCRParser.parseAmount('đ220.000')).toBe(220000);
    expect(OCRParser.parseAmount('đ153.200')).toBe(153200);
    expect(OCRParser.parseAmount('-đ63.500')).toBe(63500);
    expect(OCRParser.parseAmount('130 000')).toBe(130000);
    expect(OCRParser.parseAmount('35 000')).toBe(35000);
    expect(OCRParser.parseAmount('450k')).toBe(450000);
    expect(OCRParser.parseAmount('125K')).toBe(125000);
    expect(OCRParser.parseAmount('150000')).toBe(150000);
  });

  test('should extract the correct final total amount from a Shopee/Grab settlement bill', () => {
    const mockLines = [
      '220.000',
      '1 220.000',
      'Tổng tiền sản phẩm',
      'đ220.000',
      'Giá sản phẩm',
      'đ220.000',
      'Phí vận chuyển ước tính',
      'đ0',
      'Phụ phí',
      '-đ63.500',
      'Thuế',
      '-đ3.300',
      'Tổng thu đơn hàng ước tính',
      'đ153.200'
    ];

    const detectedAmount = OCRParser.extractBillAmount(mockLines);
    expect(detectedAmount).toBe(153200); // Phải ưu tiên 153.200 thay vì 220.000 nhờ điểm cộng Tổng cuối cùng (Final)
  });

  test('should extract the correct final total amount from Am Thuc Ganh bill with space separators', () => {
    const mockLines = [
      'Ẩm Thực GÁNH',
      '02 Ngô Thì Sĩ - TP Đà Nẵng',
      'HOÁ ĐƠN TẠM TÍNH',
      'Bàn: TẦNG 1 - 10 A',
      'Tên món SL Đ.Giá T. Tiền',
      'Ram chả cá 1 35 000 35 000',
      'Bún đậu Gánh 1 50 000 50 000',
      'Cá viên chiên 1 25 000 25 000',
      'Chè gánh 1 20 000 20 000',
      'Tổng Tiền Thanh Toán:       130 000'
    ];

    const detectedAmount = OCRParser.extractBillAmount(mockLines);
    expect(detectedAmount).toBe(130000); // Phải nhận diện chính xác 130 000
  });

  test('should extract the correct final total amount from Ca Phe Hoang Phuc bill with phone numbers', () => {
    const mockLines = [
      'CÀ PHÊ HOÀNG PHÚC',
      'Đường Số 24 KDC An Khánh, P. An Khánh',
      'ĐT: 0974.300.007 - 0909.191.195',
      'HÓA ĐƠN BÁN HÀNG',
      'Bàn 05',
      'Ngày: 18/02/2019 Số: 021900003',
      'Thu ngân: Administrator',
      'Mặt hàng SL Giá T tiền',
      'Cà phê đá 1 10,000 10,000',
      'Bún thịt Xào 1 15,000 15,000',
      'Cà phê sữa đá 1 12,000 12,000',
      'Cơm tấm 1 17,000 17,000',
      'Tổng:',
      '54,000'
    ];

    const detectedAmount = OCRParser.extractBillAmount(mockLines);
    expect(detectedAmount).toBe(54000); // Phải bỏ qua số điện thoại 300.007 và nhận diện đúng 54.000 dưới chữ Tổng:
  });

  test('should extract the correct final total amount from Quan Khoi bill with columnar layout', () => {
    const mockLines = [
      'QUÁN KHÓI',
      '06 Tân Kỳ Tân Quý, P.15, Q. Tân Bình, HCM',
      'PHIẾU THANH TOÁN',
      'Khu: A',
      'Bàn: 1',
      'Tên món SL ĐG T.Tiền',
      'Cà tím nướng mỡ hành 1 36,000 36,000',
      'Bông cải xào dầu hào 1 36,000 36,000',
      'Bầu luộc hột vịt 1 36,000 36,000',
      'Zet 1 22,000 22,000',
      '555 xanh 1 32,000 32,000',
      'Ken chai 1 18,000 18,000',
      'Tổng cộng',
      '180,000'
    ];

    const detectedAmount = OCRParser.extractBillAmount(mockLines);
    expect(detectedAmount).toBe(180000); // Phải nhận diện chính xác 180.000 và không lấy nhầm Zet 22.000
  });
});
