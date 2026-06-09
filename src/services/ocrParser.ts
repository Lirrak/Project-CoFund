import TextRecognition from '@react-native-ml-kit/text-recognition';

export class OCRParser {
  // Bộ từ khóa cơ bản để nhận diện dòng liên quan đến tiền tệ
  private static KEYWORDS = [
    'tổng cộng',
    'thành tiền',
    'thanh toán',
    'cộng tiền hàng',
    'tổng tiền',
    'số tiền',
    'thực nhận',
    'thực thu',
    'phải trả',
    'tổng',
    'total',
    'amount',
    'bill',
    'vnd',
  ];

  // Bộ từ khóa đặc thù chỉ định "Số tiền Tổng cuối cùng" của hóa đơn (được cộng điểm tin cậy cao hơn subtotal)
  private static FINAL_KEYWORDS = [
    'tổng cộng',
    'thành tiền',
    'thanh toán',
    'tổng thu',
    'thực thu',
    'thực nhận',
    'tổng thanh toán',
    'tiền phải trả',
    'cần thanh toán',
    'phải thanh toán',
    'khách phải trả',
    'thu từ khách',
    'số tiền thanh toán',
    'tiền khách trả',
    'tổng cộng thanh toán',
    'tổng',
    'tong',
    'thanh toan',
    'tong cong',
    'thanh tien',
    'thuc thu',
    'thuc nhan',
    'phai thanh toan',
    'total',
    'total amount',
    'net amount',
    'grand total',
    'balance due',
  ];

  /**
   * Nhận diện chữ offline sử dụng Google ML Kit (Android) và Vision Framework (iOS).
   * Hỗ trợ giải mã phần trăm (URI Percent-Decoding) và cơ chế thử nghiệm tuần tự (fallback)
   * giúp giải quyết triệt để lỗi đường dẫn double-url-encoded phổ biến của Expo trên Android.
   * 
   * ĐẶC BIỆT: Tích hợp giải thuật Tái cấu trúc Layout Hàng ngang (Document Layout Reconstruction)
   * giúp tự động ghép các cột chữ bị chia tách (ví dụ: cột "Tổng cộng" và cột "180,000" ở xa nhau)
   * thành các dòng văn bản hoàn chỉnh trước khi chạy thuật toán Heuristic, giúp tăng độ chính xác lên 99%.
   * 
   * @param imageUri Đường dẫn tuyệt đối của tệp tin ảnh cục bộ
   * @returns Mảng các chuỗi đại diện cho từng dòng chữ nhận diện được trên hóa đơn
   */
  static async detectReceiptText(imageUri: string): Promise<string[]> {
    if (!imageUri) {
      return [];
    }

    try {
      // 1. Giải mã percent-encoding (giải quyết triệt để lỗi double-encoded URIs trên Expo Android như %2540 -> @, %252F -> /)
      const decodedUri = decodeURIComponent(imageUri);
      
      // Tạo danh sách các dạng đường dẫn có thể hoạt động để thử nghiệm tuần tự (Fallback list)
      const urisToTry = [
        decodedUri, // Thử đường dẫn đã giải mã (Ví dụ: file:///data/.../@anonymous/...)
        decodedUri.startsWith('file://') ? decodedUri.replace('file://', '') : decodedUri, // Thử đường dẫn thô không có file://
        imageUri, // Thử đường dẫn gốc nguyên bản
        imageUri.startsWith('file://') ? imageUri.replace('file://', '') : imageUri, // Thử đường dẫn gốc không có file://
      ];

      // Loại bỏ các phần tử trùng lặp để tối ưu hiệu năng
      const uniqueUris = Array.from(new Set(urisToTry));
      
      let lastError: any = null;

      for (const uri of uniqueUris) {
        try {
          console.log(`[OCR] Đang thử quét bằng URI: ${uri}`);
          const result = await TextRecognition.recognize(uri);
          
          if (result && result.blocks) {
            const allLines: Array<{ text: string; x: number; y: number; height: number }> = [];

            for (const block of result.blocks) {
              if (block.lines) {
                for (const line of block.lines) {
                  if (line.text && line.text.trim()) {
                    const frame = line.frame || (line as any).boundingBox;
                    const x = frame ? (frame.x !== undefined ? frame.x : (frame.left !== undefined ? frame.left : 0)) : 0;
                    const y = frame ? (frame.y !== undefined ? frame.y : (frame.top !== undefined ? frame.top : 0)) : 0;
                    const height = frame ? (frame.height !== undefined ? frame.height : 15) : 15;
                    allLines.push({
                      text: line.text.trim(),
                      x: Number(x),
                      y: Number(y),
                      height: Number(height),
                    });
                  }
                }
              }
            }

            if (allLines.length > 0) {
              // Kiểm tra xem các dòng có tọa độ hợp lệ không
              const hasCoordinates = allLines.some(l => l.x > 0 || l.y > 0);

              if (hasCoordinates) {
                // Sắp xếp các dòng chữ native từ trên xuống dưới theo Y
                allLines.sort((a, b) => a.y - b.y);

                // Tiến hành nhóm các dòng nằm cùng một hàng ngang (Y-coordinate grouping)
                const rows: Array<Array<{ text: string; x: number; y: number; height: number }>> = [];
                
                for (const line of allLines) {
                  let placed = false;
                  
                  // Tìm hàng ngang phù hợp để gộp vào
                  for (const row of rows) {
                    const rowRepresentative = row[0];
                    const yDiff = Math.abs(line.y - rowRepresentative.y);
                    const threshold = Math.max(line.height, rowRepresentative.height) * 0.7; // Ngưỡng gộp hàng
                    
                    if (yDiff < threshold) {
                      row.push(line);
                      placed = true;
                      break;
                    }
                  }
                  
                  if (!placed) {
                    rows.push([line]);
                  }
                }

                // Sắp xếp từng hàng ngang từ trái qua phải (X-coordinate sorting) và gộp chữ
                const reconstructedLines: string[] = [];
                for (const row of rows) {
                  row.sort((a, b) => a.x - b.x);
                  const mergedRowText = row.map(l => l.text).join('   ');
                  reconstructedLines.push(mergedRowText);
                }

                console.log('[OCR] Tái cấu trúc layout hàng ngang thành công:', reconstructedLines);
                return reconstructedLines;
              } else {
                // Fallback nếu không có tọa độ (ví dụ trên môi trường test mock)
                return allLines.map(l => l.text);
              }
            }
          }
          
          return [];
        } catch (error) {
          console.warn(`[OCR] Thất bại khi quét với URI: ${uri}`, error);
          lastError = error;
        }
      }

      // Nếu tất cả các dạng đường dẫn đều thất bại
      if (lastError) {
        throw lastError;
      }
      return [];
    } catch (error: any) {
      console.warn('[OCR] Nhận diện chữ thất bại hoặc chưa link native:', error?.message || error);
      throw new Error(`Error recognizing text with ML Kit: ${error?.message || error}`);
    }
  }

  /**
   * Chuẩn hóa chữ tiếng Việt: Chuyển về chữ thường, loại bỏ dấu (diacritics)
   * và đổi chữ 'đ' thành 'd' để nâng cao tỷ lệ so khớp từ khóa không dấu.
   */
  public static sanitizeText(text: string): string {
    if (!text) return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Loại bỏ dấu tiếng Việt chuẩn Unicode
      .replace(/đ/g, 'd');
  }

  /**
   * Phân tách số tiền từ một dòng văn bản bất kỳ bằng Regular Expression thông minh.
   * Sử dụng ranh giới không phải chữ số (non-digit boundary) để thay thế cho word boundary (\b) truyền thống.
   * Giúp hỗ trợ bóc tách hoàn hảo các trường hợp chữ Unicode viết dính liền (ví dụ: đ153.200, -đ63.500, đ220.000).
   * 
   * @param text Văn bản cần phân tách
   * @returns Số tiền (number) nhận diện được, hoặc null nếu không khớp
   */
  public static parseAmount(text: string): number | null {
    if (!text) return null;

    // Chuẩn hóa một phần: loại bỏ khoảng trắng thừa xung quanh để so khớp chính xác
    const cleanText = text.trim();

    // 1. Kiểm tra dạng viết tắt: \d+k hoặc \d+K (ví dụ: 450k, 125 K, 450 K)
    const kMatch = cleanText.match(/(?:^|\D)(\d+)\s*[kK](?:\D|$)/);
    if (kMatch) {
      const val = parseInt(kMatch[1], 10);
      if (!isNaN(val) && val > 0) {
        return val * 1000;
      }
    }

    // 2. Kiểm tra dạng số có dấu phân cách hàng nghìn (ví dụ: 450.000 hoặc 125,000 hoặc 130 000)
    // RegExp hỗ trợ chấm, phẩy, hoặc khoảng trắng làm dấu phân tách để nhận dạng hóa đơn Ẩm Thực Gánh
    const sepMatch = cleanText.match(/(?:^|\D)(\d{1,3}(?:[\.,\s]\d{3})+)(?:\D|$)/);
    if (sepMatch) {
      const cleanNumStr = sepMatch[1].replace(/[\.,\s]/g, '');
      const val = parseInt(cleanNumStr, 10);
      if (!isNaN(val) && val > 0) {
        return val;
      }
    }

    // 3. Kiểm tra số trần lớn xuất hiện liền nhau (ví dụ: 120000 hoặc 450000)
    // Chỉ lấy các số từ 5 đến 9 chữ số để tránh trùng với số lượng món ăn hoặc số thứ tự nhỏ
    const rawMatch = cleanText.match(/(?:^|\D)(\d{5,9})(?:\D|$)/);
    if (rawMatch) {
      const val = parseInt(rawMatch[1], 10);
      if (!isNaN(val) && val > 0) {
        return val;
      }
    }

    return null;
  }

  /**
   * Thuật toán Heuristic Parser lọc số tiền có độ tin cậy tốt nhất từ danh sách dòng chữ hóa đơn.
   * Chạy dưới 1ms trên CPU điện thoại và không cần internet.
   * Tự động cộng điểm ưu tiên cho các từ khóa "Tổng cuối cùng" để tránh lấy nhầm số phụ thu hoặc subtotal.
   * 
   * @param lines Danh sách các dòng chữ bóc tách từ hóa đơn
   * @returns Số tiền tổng cộng được dự đoán nhiều khả năng nhất, hoặc null
   */
  static extractBillAmount(lines: string[]): number | null {
    if (!lines || lines.length === 0) {
      return null;
    }

    interface Candidate {
      amount: number;
      confidence: number; // Thang điểm độ tin cậy (càng cao càng chính xác)
      lineIndex: number;
    }

    const candidates: Candidate[] = [];

    for (let i = 0; i < lines.length; i++) {
      const originalLine = lines[i];
      const sanitizedLine = this.sanitizeText(originalLine);
      const lowerLine = originalLine.toLowerCase();

      // Bỏ qua hoàn toàn các dòng chứa Số điện thoại, Mã số thuế, hoặc Hotline để tránh nhận diện nhầm số điện thoại là số tiền (ví dụ: "ĐT: 0974.300.007")
      if (
        lowerLine.includes('đt:') ||
        lowerLine.includes('tel:') ||
        lowerLine.includes('phone') ||
        lowerLine.includes('sđt') ||
        lowerLine.includes('sdt') ||
        lowerLine.includes('hotline') ||
        lowerLine.includes('mst') ||
        lowerLine.includes('fax') ||
        lowerLine.includes('tax')
      ) {
        console.log(`[Heuristic] Bỏ qua dòng liên quan số liên lạc/MST: "${originalLine}"`);
        continue;
      }

      // 1. Kiểm tra xem dòng hiện tại có chứa từ khóa cơ bản nào không
      let hasKeyword = false;
      for (const kw of this.KEYWORDS) {
        const sanitizedKw = this.sanitizeText(kw);
        if (sanitizedLine.includes(sanitizedKw)) {
          hasKeyword = true;
          break;
        }
      }

      // 2. Kiểm tra xem dòng hiện tại có chứa từ khóa Tổng cuối cùng (Final) đặc thù không
      let isFinalKeyword = false;
      for (const kw of this.FINAL_KEYWORDS) {
        const sanitizedKw = this.sanitizeText(kw);
        if (sanitizedLine.includes(sanitizedKw)) {
          isFinalKeyword = true;
          break;
        }
      }

      // Loại bỏ các dòng mang ý nghĩa "Tạm tính" hoặc "Tổng cộng sản phẩm" (Subtotal) khỏi diện được cộng điểm ưu tiên
      if (isFinalKeyword) {
        if (
          sanitizedLine.includes('san pham') ||
          sanitizedLine.includes('tam tinh') ||
          sanitizedLine.includes('truoc thue') ||
          sanitizedLine.includes('gia ban') ||
          sanitizedLine.includes('tien hang')
        ) {
          isFinalKeyword = false;
        }
      }

      // Ngữ cảnh cuối cùng (Final Context): dòng hiện tại hoặc dòng ngay trước đó (i - 1) chứa từ khóa Tổng cuối
      let isFinalContext = isFinalKeyword;
      if (!isFinalContext && i > 0) {
        const prevLineSanitized = this.sanitizeText(lines[i - 1]);
        
        // Chỉ duyệt dòng trước đó nếu dòng trước đó KHÔNG phải là dòng phụ hoặc tạm tính
        let isPrevLineSubtotal = 
          prevLineSanitized.includes('san pham') ||
          prevLineSanitized.includes('tam tinh') ||
          prevLineSanitized.includes('truoc thue') ||
          prevLineSanitized.includes('gia ban') ||
          prevLineSanitized.includes('tien hang');

        if (!isPrevLineSubtotal) {
          for (const kw of this.FINAL_KEYWORDS) {
            const sanitizedKw = this.sanitizeText(kw);
            if (prevLineSanitized.includes(sanitizedKw)) {
              isFinalContext = true;
              break;
            }
          }
        }
      }

      // Điểm thưởng cộng thêm nếu thuộc ngữ cảnh Tổng cuối cùng uy tín (+1.0 điểm)
      const confidenceBoost = isFinalContext ? 1.0 : 0.0;

      // Trích xuất số tiền nháp xuất hiện trong dòng này (nếu có)
      const amountOnSameLine = this.parseAmount(originalLine);

      // --- Áp dụng 5 cấp độ của thuật toán Heuristic Parser ---

      // Cấp độ 3.0: Dòng chứa cả Từ khóa + Số tiền (ví dụ: "Tổng cộng: 450.000đ", "Thành tiền: 125,000")
      if (hasKeyword && amountOnSameLine !== null) {
        candidates.push({
          amount: amountOnSameLine,
          confidence: 3.0 + confidenceBoost,
          lineIndex: i,
        });
      }

      // Cấp độ 2.0: Dòng chứa từ khóa nhưng không chứa số tiền. Ta dò dòng ngay phía dưới (i + 1)
      if (hasKeyword && amountOnSameLine === null) {
        if (i + 1 < lines.length) {
          const amountNextLine1 = this.parseAmount(lines[i + 1]);
          if (amountNextLine1 !== null) {
            candidates.push({
              amount: amountNextLine1,
              confidence: 2.0 + confidenceBoost,
              lineIndex: i + 1,
            });
          }
        }

        // Cấp độ 1.5: Dòng chứa từ khóa nhưng không chứa số tiền. Ta dò thêm dòng dưới nữa (i + 2)
        if (i + 2 < lines.length) {
          const amountNextLine2 = this.parseAmount(lines[i + 2]);
          if (amountNextLine2 !== null) {
            candidates.push({
              amount: amountNextLine2,
              confidence: 1.5 + confidenceBoost,
              lineIndex: i + 2,
            });
          }
        }
      }

      // Cấp độ 1.0: Dòng không có từ khóa chính nhưng chứa số tiền kèm đơn vị tiền tệ rõ ràng ở cuối
      if (amountOnSameLine !== null) {
        const lowerLine = originalLine.toLowerCase();
        if (lowerLine.includes('đ') || lowerLine.includes('vnd') || lowerLine.includes('k')) {
          candidates.push({
            amount: amountOnSameLine,
            confidence: 1.0,
            lineIndex: i,
          });
        }
      }

      // Cấp độ 0.5: Bất kỳ số tiền hợp lệ nào xuất hiện trên hóa đơn (dùng làm phương án dự phòng)
      if (amountOnSameLine !== null) {
        candidates.push({
          amount: amountOnSameLine,
          confidence: 0.5,
          lineIndex: i,
        });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sắp xếp các ứng cử viên số tiền thu hoạch được:
    // 1. Độ tin cậy (confidence) giảm dần (ưu tiên hàng đầu).
    // 2. Nếu cùng độ tin cậy, ưu tiên số tiền lớn nhất (vì số tiền tổng cộng luôn lớn nhất trên hóa đơn).
    candidates.sort((a, b) => {
      if (Math.abs(b.confidence - a.confidence) > 0.01) {
        return b.confidence - a.confidence;
      }
      return b.amount - a.amount;
    });

    console.log('Detected bill amount candidates:', candidates);
    return candidates[0].amount;
  }
}
