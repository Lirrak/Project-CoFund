import React, { useState, useEffect, useRef } from 'react';
import { useRealtimeSync } from '../hooks/useRealtimeSync';
import { BeautifulPieChart } from '../components/BeautifulPieChart';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  TextInput,
  Alert,
  ActivityIndicator,
  Platform,
  StatusBar,
  Image,
  Modal,
  Pressable,
  Dimensions,
} from 'react-native';
import { LocalDB, LocalGroupMember } from '../services/sqlite';
import {
  calculateMemberNetBalances,
  createExpenseWithSplits,
  splitCalculator,
  MemberState,
  DebtTransaction,
  SplitType,
  SplitInput,
} from '../utils/splitCalculator';
import { saveBillImageLocally } from '../services/imageStore';
import { OCRParser } from '../services/ocrParser';
import * as ImagePicker from 'expo-image-picker';
import { Paths, File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

interface TripExpensesScreenProps {
  tripId: number;
  tripName: string;
  groupId: number;
  onGoBack: () => void;
}

interface DisplayExpense {
  id: number;
  total_amount: number;
  description: string;
  created_at: string;
  paidByName: string; // Tên hiển thị người trả, hoặc "Quỹ chung"
  billImageUri?: string | null; // Đường dẫn ảnh hóa đơn cục bộ
  splits: Array<{
    displayName: string;
    ratio: number;
    calculatedAmount: number;
  }>;
}

const MEMBER_COLORS = [
  '#3B82F6', // Xanh Dương
  '#10B981', // Xanh Lá
  '#F59E0B', // Vàng Hổ Phách
  '#EF4444', // Đỏ
  '#8B5CF6', // Tím
  '#EC4899', // Hồng
  '#14B8A6', // Xanh Ngọc
  '#F97316', // Cam
];

function TripExpensesScreenContent({ tripId, tripName, groupId, onGoBack }: TripExpensesScreenProps) {
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'balances' | 'expenses' | 'add' | 'settlement'>('balances');

  // Trạng thái Toast Notification nội bộ
  const [toastVisible, setToastVisible] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string>('');
  const [toastType, setToastType] = useState<string>('');

  // Trạng thái Modal chi tiết hóa đơn và phân rã splits
  const [selectedExpense, setSelectedExpense] = useState<DisplayExpense | null>(null);
  const [expenseModalVisible, setExpenseModalVisible] = useState<boolean>(false);

  const showToast = (message: string, type: string) => {
    setToastMessage(message);
    setToastType(type);
    setToastVisible(true);
    setTimeout(() => {
      setToastVisible(false);
    }, 4000);
  };

  // Đăng ký realtime sync kết nối Supabase WebSockets
  useRealtimeSync(groupId, (event) => {
    // Tải lại dữ liệu từ SQLite cục bộ tức thì khi nhận được sự kiện
    loadData();
    if (event.message) {
      showToast(event.message, event.table);
    }
  });

  // Dữ liệu từ DB
  const [memberStates, setMemberStates] = useState<MemberState[]>([]);
  const [members, setMembers] = useState<LocalGroupMember[]>([]);
  const [expenses, setExpenses] = useState<DisplayExpense[]>([]);
  const [fundBalance, setFundBalance] = useState<number>(0);

  // Trạng thái quyết toán & Chú thích popup
  const [isSettlementActive, setIsSettlementActive] = useState<boolean>(false);
  const [showAboutSettlementModal, setShowAboutSettlementModal] = useState<boolean>(false);
  const [isCompletingSettlement, setIsCompletingSettlement] = useState<boolean>(false);

  // Form thêm chi tiêu mới
  const [amount, setAmount] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [paidByUserId, setPaidByUserId] = useState<number | null>(null); // null = Chi từ Quỹ chung
  const [selectedMemberIds, setSelectedMemberIds] = useState<number[]>([]);
  const [splitType, setSplitType] = useState<SplitType>('EQUAL');
  const [memberPercents, setMemberPercents] = useState<Record<number, string>>({}); // Lưu trữ % tùy chọn
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Trạng thái OCR AI & Giao diện ảnh
  const [billImageUri, setBillImageUri] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState<boolean>(false);
  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);

  // Tải toàn bộ dữ liệu liên quan
  const loadData = async () => {
    try {
      setLoading(true);
      const db = LocalDB.getInstance();

      // 1. Tính toán số dư ròng (Net Balance) của các thành viên trong nhóm
      const states = await calculateMemberNetBalances(groupId);
      setMemberStates(states);

      // 2. Lấy danh sách thành viên nhóm để thiết lập form
      const groupMembers = await db.getGroupMembers(groupId);
      setMembers(groupMembers);
      if (groupMembers.length > 0 && selectedMemberIds.length === 0) {
        setSelectedMemberIds(groupMembers.map(m => m.id)); // mặc định gán cho tất cả
      }

      // 3. Lấy thông tin quỹ để cập nhật số dư hiển thị
      const fund = await db.getFundByGroupId(groupId);
      if (fund) {
        setFundBalance(fund.balance);
      }

      // 4. Lấy danh sách hóa đơn chi tiêu kèm thông tin splits của chuyến đi này
      // Sử dụng LEFT JOIN để lấy được cả hóa đơn có paid_by là NULL (Chi từ quỹ chung)
      const expenseRows = await db.getAllAsync<any>(
        `SELECT e.id, e.total_amount, e.description, e.bill_image_uri, e.created_at, p.display_name as paidByName
         FROM expenses e
         LEFT JOIN profiles p ON e.paid_by = p.id
         WHERE e.trip_id = ?
         ORDER BY e.id DESC;`,
        [tripId]
      );

      const splitRows = await db.getAllAsync<any>(
        `SELECT s.expense_id, s.calculated_amount, s.ratio, p.display_name as displayName
         FROM splits s
         JOIN profiles p ON s.user_id = p.id
         JOIN expenses e ON s.expense_id = e.id
         WHERE e.trip_id = ?;`,
        [tripId]
      );

      const formattedExpenses: DisplayExpense[] = expenseRows.map(exp => {
        const itemSplits = splitRows
          .filter(s => s.expense_id === exp.id)
          .map(s => ({
            displayName: s.displayName,
            ratio: s.ratio,
            calculatedAmount: s.calculated_amount,
          }));
        return {
          id: exp.id,
          total_amount: exp.total_amount,
          description: exp.description || 'Chi tiêu không tên',
          created_at: exp.created_at,
          paidByName: exp.paidByName || '🏦 Quỹ chung',
          billImageUri: exp.bill_image_uri,
          splits: itemSplits,
        };
      });

      setExpenses(formattedExpenses);
    } catch (error) {
      console.error('Error loading trip expenses data:', error);
      Alert.alert('Lỗi', 'Không thể tải dữ liệu chi tiêu.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [tripId, groupId]);

  // Xử lý nộp chi tiêu mới
  const handleAddExpense = async () => {
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      Alert.alert('Thông báo', 'Vui lòng nhập số tiền hợp lệ lớn hơn 0.');
      return;
    }
    if (!description.trim()) {
      Alert.alert('Thông báo', 'Vui lòng nhập mô tả chi tiêu.');
      return;
    }
    if (selectedMemberIds.length === 0) {
      Alert.alert('Thông báo', 'Vui lòng chọn ít nhất một thành viên gánh hóa đơn.');
      return;
    }

    // Nếu chia theo phần trăm (PERCENT) -> kiểm tra tính hợp lệ và tổng phần trăm
    let splitsInput: SplitInput[] = [];
    if (splitType === 'EQUAL') {
      splitsInput = selectedMemberIds.map(userId => ({ userId }));
    } else {
      let sum = 0;
      for (const userId of selectedMemberIds) {
        const pctStr = memberPercents[userId];
        const pct = Number(pctStr || 0);
        if (isNaN(pct) || pct <= 0) {
          Alert.alert('Thông báo', 'Vui lòng nhập phần trăm gánh nợ hợp lệ lớn hơn 0 cho các thành viên được chọn.');
          return;
        }
        sum += pct;
        splitsInput.push({ userId, percent: pct });
      }

      if (Math.abs(sum - 100) > 0.01) {
        Alert.alert('Thông báo', `Tổng phần trăm gánh hóa đơn phải bằng chính xác 100%. Hiện tại đang là ${sum.toFixed(1)}%.`);
        return;
      }
    }

    try {
      setIsSubmitting(true);
      const expenseId = await createExpenseWithSplits(
        tripId,
        paidByUserId, // số ID hoặc null
        Number(amount),
        description.trim(),
        billImageUri || '', // Lưu trữ ảnh hóa đơn cục bộ (nếu có)
        splitsInput,
        splitType
      );

      if (expenseId) {
        Alert.alert('Thành công', 'Đã ghi nhận chi tiêu và tự động hạch toán số dư ròng thành công!');
        setAmount('');
        setDescription('');
        setBillImageUri(null); // Reset đường dẫn ảnh hóa đơn
        setMemberPercents({});
        // Reload lại toàn bộ dữ liệu
        await loadData();
        setActiveTab('expenses');
      }
    } catch (error) {
      console.error('Failed to create expense:', error);
      Alert.alert('Lỗi', 'Không thể ghi nhận hóa đơn. Hãy kiểm tra lại kết nối cơ sở dữ liệu.');
    } finally {
      setIsSubmitting(false);
    }
  };



  // Xử lý luồng chạy OCR offline & bóc tách số tiền
  const handleProcessImage = async (tempUri: string) => {
    try {
      setOcrLoading(true);
      
      // 1. Sao chép ảnh vào thư mục ứng dụng chính thức lâu dài
      const savedUri = await saveBillImageLocally(tempUri);
      setBillImageUri(savedUri);

      // 2. Chạy OCR Offline bóc tách chữ tiếng Việt bằng Google ML Kit
      const lines = await OCRParser.detectReceiptText(savedUri);
      
      if (lines.length === 0) {
        Alert.alert('Nhận diện chữ', 'Không phát hiện được ký tự nào trên hóa đơn này. Vui lòng nhập số tiền thủ công.');
        return;
      }

      console.log('Detected OCR lines:', lines);

      // 3. Phân tích bóc tách số tiền bằng Heuristics offline nhanh <1s
      const detectedAmount = OCRParser.extractBillAmount(lines);

      // 4. Cập nhật kết quả vào form nhập liệu nếu tìm thấy số tiền hợp lệ
      if (detectedAmount && detectedAmount > 0) {
        setAmount(detectedAmount.toString());
        // Điền mô tả gợi ý kèm tên ảnh hóa đơn
        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        setDescription(`Hóa đơn tự động quét lúc ${timeStr}`);
        Alert.alert(
          'AI Nhận diện thành công 🎉', 
          `Đã phát hiện số tiền: ${detectedAmount.toLocaleString('vi-VN')} đ.\nSố tiền và mô tả gợi ý đã được điền tự động vào biểu mẫu.`
        );
      } else {
        Alert.alert(
          'Không tìm thấy số tiền', 
          'AI đã đọc được chữ nhưng không xác định chắc chắn được Số tiền tổng của hóa đơn. Vui lòng tự điền số tiền.'
        );
      }

    } catch (error: any) {
      console.warn('Error processing bill image:', error);
      const errorMsg = error?.message || '';
      
      // Kiểm tra xem có phải lỗi do thiếu native linking (chạy trong Expo Go) hay không
      if (
        errorMsg.includes("doesn't seem to be linked") || 
        errorMsg.includes("unlinked") || 
        errorMsg.includes("NativeModules") ||
        errorMsg.includes("null is not an object")
      ) {
        Alert.alert(
          'Môi trường Expo Go 💡',
          'Tính năng Google ML Kit OCR Offline yêu cầu phải chạy trên bản Build Native (hoặc Development Client).\n\nBạn có muốn kích hoạt "Trình giả lập OCR" để kiểm thử đầy đủ các luồng hoạt động (lưu trữ ảnh cục bộ, hạch toán SQLite, vẽ biểu đồ, xem ảnh thu phóng) ngay trong Expo Go không?',
          [
            {
              text: 'Nhập thủ công',
              style: 'cancel',
            },
            {
              text: 'Chạy Giả lập',
              style: 'default',
              onPress: async () => {
                try {
                  setOcrLoading(true);
                  // Giả lập lưu ảnh chụp cục bộ vào FileSystem
                  const savedUri = await saveBillImageLocally(tempUri);
                  setBillImageUri(savedUri);

                  // Danh sách các loại hóa đơn Việt Nam giả lập đa dạng để kiểm thử sinh động
                  const mockBills = [
                    {
                      name: 'QUÁN KHÓI (Tân Bình)',
                      description: 'QUÁN KHÓI (Hóa đơn quét giả lập)',
                      lines: [
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
                      ]
                    },
                    {
                      name: 'Cà phê Hoàng Phúc (Cần Thơ)',
                      description: 'Cà phê Hoàng Phúc (Hóa đơn quét giả lập)',
                      lines: [
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
                      ]
                    },
                    {
                      name: 'Ẩm Thực GÁNH (Đà Nẵng)',
                      description: 'Ẩm Thực GÁNH (Hóa đơn quét giả lập)',
                      lines: [
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
                      ]
                    },
                    {
                      name: 'ShopeeFood (Grab)',
                      description: 'GrabFood (Hóa đơn quét giả lập)',
                      lines: [
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
                      ]
                    },
                    {
                      name: 'Highlands Coffee',
                      description: 'Highlands Coffee (Hóa đơn quét giả lập)',
                      lines: [
                        'HIGHLANDS COFFEE',
                        'ĐC: 135 Nguyễn Huệ, Q.1',
                        'Phin Sữa Đá Size L: 45.000',
                        'Trà Đào Thanh Đào Size M: 49.000',
                        'Bánh Mì Thịt Nướng: 31.000',
                        'CỘNG TIỀN HÀNG: 125.000',
                        'Thành tiền: 125.000',
                        'Cảm ơn quý khách!'
                      ]
                    },
                    {
                      name: 'Taxi Mai Linh',
                      description: 'Taxi Mai Linh (Hóa đơn quét giả lập)',
                      lines: [
                        'TAXI MAI LINH',
                        'SỐ XE: 4321',
                        'QUÃNG ĐƯỜNG: 5.2 KM',
                        'ĐƠN GIÁ: 15.000/KM',
                        'TỔNG CỘNG THANH TOÁN',
                        '85.000 đ',
                        'CẢM ƠN QUÝ KHÁCH!'
                      ]
                    },
                    {
                      name: 'Nhà hàng Hải Sản',
                      description: 'Nhà hàng Hải Sản (Hóa đơn quét giả lập)',
                      lines: [
                        'NHÀ HÀNG HẢI SẢN PHỐ BIỂN',
                        'Lẩu hải sản thập cẩm: 450.000',
                        'Cua hoàng đế hấp sả: 650.000',
                        'Nước ngọt lon x5: 150.000',
                        'Tổng cộng chưa thuế: 1.250.000',
                        'Thuế VAT 10%: 125.000',
                        'TỔNG TIỀN THANH TOÁN',
                        '1.250.000 đ'
                      ]
                    }
                  ];

                  // Lựa chọn ngẫu nhiên một loại hóa đơn để quét giả lập sinh động
                  const selectedBill = mockBills[Math.floor(Math.random() * mockBills.length)];

                  // Chạy trực tiếp qua thuật toán Heuristic Parser vừa cải tiến của ocrParser
                  const detectedAmount = OCRParser.extractBillAmount(selectedBill.lines);
                  if (detectedAmount && detectedAmount > 0) {
                    setAmount(detectedAmount.toString());
                    setDescription(selectedBill.description);
                    Alert.alert(
                      `Giả lập thành công [${selectedBill.name}] 🎉`,
                      `Đã giả lập quét thành công số tiền: ${detectedAmount.toLocaleString('vi-VN')} đ.\n\nBạn có thể nhấn nút "Lưu hóa đơn" để trải nghiệm hạch toán SQLite và bấm "Xem ảnh" ở Lịch sử.`
                    );
                  }
                } catch (simError: any) {
                  console.error('Simulated OCR error:', simError);
                  Alert.alert('Lỗi giả lập', simError?.message || 'Không thể lưu ảnh hóa đơn cục bộ.');
                } finally {
                  setOcrLoading(false);
                }
              }
            }
          ]
        );
      } else {
        Alert.alert('Lỗi phân tích', error?.message || 'Có lỗi xảy ra khi xử lý ảnh hóa đơn.');
      }
    } finally {
      setOcrLoading(false);
    }
  };

  // Kích hoạt camera chụp ảnh hóa đơn mới
  const handleCaptureInvoice = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Quyền truy cập', 'Vui lòng cấp quyền truy cập Camera trong Cài đặt thiết bị để chụp ảnh hóa đơn.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.9,
    });

    if (!result.canceled && result.assets && result.assets.length > 0) {
      await handleProcessImage(result.assets[0].uri);
    }
  };

  // Kích hoạt thư viện chọn ảnh hóa đơn có sẵn
  const handlePickInvoice = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Quyền truy cập', 'Vui lòng cấp quyền truy cập Thư viện ảnh để chọn ảnh hóa đơn.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.9,
    });

    if (!result.canceled && result.assets && result.assets.length > 0) {
      await handleProcessImage(result.assets[0].uri);
    }
  };

  // Hàm tạo dữ liệu CSV từ danh sách chi tiêu
  const generateCSVContent = (expensesList: DisplayExpense[]): string => {
    const BOM = '\uFEFF';
    const headers = ['Ngày', 'Người thanh toán', 'Mô tả', 'Tổng tiền (đ)', 'Chi tiết phân chia gánh nợ'];
    
    const escapeCSV = (val: string) => {
      const escaped = val.replace(/"/g, '""');
      return `"${escaped}"`;
    };

    const rows = expensesList.map(exp => {
      const date = exp.created_at;
      const payer = exp.paidByName;
      const desc = exp.description;
      const amount = exp.total_amount.toString();
      const splitDetail = exp.splits
        .map(s => `${s.displayName}: ${Math.round(s.calculatedAmount).toLocaleString('vi-VN')}đ (${(s.ratio * 100).toFixed(1)}%)`)
        .join('; ');

      return [
        escapeCSV(date),
        escapeCSV(payer),
        escapeCSV(desc),
        amount,
        escapeCSV(splitDetail)
      ].join(',');
    });

    return BOM + [headers.join(','), ...rows].join('\n');
  };

  // Hàm xử lý xuất file CSV và chia sẻ qua Sharing API
  const handleExportCSV = async () => {
    if (expenses.length === 0) {
      Alert.alert('Thông báo', 'Không có dữ liệu chi tiêu để xuất.');
      return;
    }

    try {
      const csvContent = generateCSVContent(expenses);
      const sanitizedTripName = tripName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_');
      const fileName = `CoFund_ChiTieu_${sanitizedTripName}.csv`;
      
      const file = new File(Paths.cache, fileName);
      file.write(csvContent, { encoding: 'utf8' });
      const fileUri = file.uri;

      const isSharingAvailable = await Sharing.isAvailableAsync();
      if (isSharingAvailable) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'text/csv',
          dialogTitle: `Xuất lịch sử chi tiêu: ${tripName}`,
          UTI: 'public.comma-separated-values-text', // iOS
        });
      } else {
        Alert.alert('Lỗi', 'Thiết bị của bạn không hỗ trợ chia sẻ tệp tin.');
      }
    } catch (error) {
      console.error('Failed to export CSV:', error);
      Alert.alert('Lỗi', 'Không thể xuất hoặc chia sẻ tệp CSV.');
    }
  };

  // Toggle thành viên gánh hóa đơn
  const toggleSelectMember = (userId: number) => {
    if (selectedMemberIds.includes(userId)) {
      setSelectedMemberIds(selectedMemberIds.filter(id => id !== userId));
      // Xóa % tương ứng nếu có
      const newPercents = { ...memberPercents };
      delete newPercents[userId];
      setMemberPercents(newPercents);
    } else {
      setSelectedMemberIds([...selectedMemberIds, userId]);
    }
  };

  // Thay đổi % gánh nợ của thành viên
  const handlePercentChange = (userId: number, value: string) => {
    setMemberPercents({
      ...memberPercents,
      [userId]: value,
    });
  };

  // Định dạng tiền VNĐ hiển thị
  const formatVND = (value: number) => {
    return Math.round(value).toLocaleString('vi-VN') + ' đ';
  };

  // Tính toán báo cáo tinh giản nợ, tích hợp Quỹ chung làm thực thể ảo nếu số dư khác 0
  const getExtendedMemberStates = () => {
    const extended = [...memberStates];
    if (Math.abs(fundBalance) > 0.1) {
      extended.push({
        userId: -999, // ID đặc biệt cho Quỹ chung
        displayName: 'Quỹ chung',
        totalContributed: 0,
        totalPaidOutOfPocket: 0,
        totalSpent: 0,
        netBalance: -fundBalance, // Nếu Quỹ chung âm, ảo netBalance dương => Chủ nợ; ngược lại => Con nợ
      });
    }
    return extended;
  };

  const debtTransactions = splitCalculator.simplifyDebts(getExtendedMemberStates());

  // Render từng dòng giao dịch thanh toán quyết toán
  const renderTransactionItem = (tx: DebtTransaction, idx: number) => {
    const isFromFund = tx.fromUserId === -999;
    const isToFund = tx.toUserId === -999;

    return (
      <View key={idx} style={styles.transactionItem}>
        <View style={styles.txLine}>
          {isFromFund ? (
            <>
              <Text style={styles.txFromName}>🏦 Quỹ chung</Text>
              <Text style={[styles.txArrow, { color: '#EAB308', fontWeight: 'bold' }]}> 📥 Rút / Hoàn trả</Text>
              <Text style={styles.txAmount}> {formatVND(tx.amount)}</Text>
              <Text style={styles.txArrow}> cho </Text>
              <Text style={styles.txToName}>{tx.toDisplayName}</Text>
            </>
          ) : isToFund ? (
            <>
              <Text style={styles.txFromName}>{tx.fromDisplayName}</Text>
              <Text style={[styles.txArrow, { color: '#10B981', fontWeight: 'bold' }]}> 📤 Nộp tiền vào</Text>
              <Text style={styles.txToName}> 🏦 Quỹ chung</Text>
              <Text style={styles.txAmount}> {formatVND(tx.amount)}</Text>
            </>
          ) : (
            <>
              <Text style={styles.txFromName}>{tx.fromDisplayName}</Text>
              <Text style={styles.txArrow}> 👉 chuyển khoản </Text>
              <Text style={styles.txAmount}>{formatVND(tx.amount)}</Text>
              <Text style={styles.txArrow}> cho </Text>
              <Text style={styles.txToName}>{tx.toDisplayName}</Text>
            </>
          )}
        </View>
      </View>
    );
  };

  // Hoàn tất quyết toán và cập nhật số dư thực tế trong DB
  const handleCompleteSettlement = async () => {
    Alert.alert(
      'Xác nhận Hoàn tất Quyết toán',
      'Hệ thống sẽ ghi nhận các giao dịch cấn trừ này vào lịch sử đóng quỹ, giúp đưa số dư ròng của tất cả thành viên và số dư Quỹ chung về đúng 0 đ sòng phẳng. Bạn có chắc chắn muốn hoàn tất?',
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Đồng ý',
          style: 'default',
          onPress: async () => {
            setIsCompletingSettlement(true);
            try {
              const db = LocalDB.getInstance();
              
              // Lấy fundId của nhóm
              const fund = await db.getFundByGroupId(groupId);
              if (!fund) {
                Alert.alert('Lỗi', 'Không tìm thấy quỹ của nhóm.');
                return;
              }

              // Chuẩn bị danh sách đóng góp cấn trừ để nạp/rút quỹ
              const settlementContributions = memberStates
                .filter(m => Math.abs(m.netBalance) > 0.1)
                .map(m => ({
                  userId: m.userId,
                  amount: -m.netBalance,
                }));

              if (settlementContributions.length > 0) {
                const success = await db.addSettlementContributions(fund.id, settlementContributions);
                if (success) {
                  Alert.alert('Thành công', 'Đã ghi nhận các giao dịch quyết toán và đưa số dư ròng cả nhóm về 0đ sòng phẳng!');
                  setIsSettlementActive(false);
                  await loadData(); // Làm mới dữ liệu hiển thị
                } else {
                  Alert.alert('Lỗi', 'Không thể lưu các giao dịch quyết toán vào cơ sở dữ liệu.');
                }
              } else {
                Alert.alert('Thông tin', 'Số dư cả nhóm hiện tại đã sòng phẳng 0đ rồi.');
              }
            } catch (err) {
              console.error('Error completing settlement:', err);
              Alert.alert('Lỗi', 'Có lỗi xảy ra trong quá trình hoàn tất quyết toán.');
            } finally {
              setIsCompletingSettlement(false);
            }
          },
        },
      ]
    );
  };

  if (loading && memberStates.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        {/* Header Skeleton */}
        <View style={styles.header}>
          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: '#3B82F6' }} />
          <View style={{ flex: 1, marginLeft: 16 }}>
            <View style={{ width: '60%', height: 18, backgroundColor: '#3B82F6', borderRadius: 4 }} />
            <View style={{ width: '40%', height: 12, backgroundColor: '#60A5FA', borderRadius: 4, marginTop: 4 }} />
          </View>
        </View>

        {/* TabBar Skeleton */}
        <View style={styles.tabBar}>
          {[1, 2, 3, 4].map((i) => (
            <View key={i} style={{ flex: 1, paddingVertical: 14, alignItems: 'center' }}>
              <View style={{ width: '70%', height: 12, backgroundColor: '#E5E7EB', borderRadius: 4 }} />
            </View>
          ))}
        </View>

        <ScrollView style={styles.content}>
          <View style={styles.tabContent}>
            {/* Chart Skeleton */}
            <View style={{ backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, marginVertical: 12 }}>
              <View style={{ width: '50%', height: 14, backgroundColor: '#E5E7EB', borderRadius: 4, marginBottom: 16 }} />
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: '#E5E7EB' }} />
                <View style={{ flex: 1, marginLeft: 24 }}>
                  <View style={{ width: '80%', height: 12, backgroundColor: '#E5E7EB', borderRadius: 4, marginVertical: 4 }} />
                  <View style={{ width: '60%', height: 12, backgroundColor: '#E5E7EB', borderRadius: 4, marginVertical: 4 }} />
                  <View style={{ width: '70%', height: 12, backgroundColor: '#E5E7EB', borderRadius: 4, marginVertical: 4 }} />
                </View>
              </View>
            </View>

            {/* List Skeleton */}
            <View style={{ backgroundColor: '#FFFFFF', borderRadius: 16, padding: 16, marginVertical: 12 }}>
              <View style={{ width: '70%', height: 14, backgroundColor: '#E5E7EB', borderRadius: 4, marginBottom: 16 }} />
              {[1, 2, 3].map((i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 12 }}>
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#E5E7EB' }} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <View style={{ width: '40%', height: 12, backgroundColor: '#E5E7EB', borderRadius: 4 }} />
                    <View style={{ width: '70%', height: 10, backgroundColor: '#F3F4F6', borderRadius: 4, marginTop: 4 }} />
                  </View>
                  <View style={{ width: 60, height: 12, backgroundColor: '#E5E7EB', borderRadius: 4 }} />
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backIcon} onPress={onGoBack}>
          <Text style={styles.backIconText}>←</Text>
        </TouchableOpacity>
        <View style={styles.headerTitleContainer}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {tripName}
          </Text>
          <Text style={styles.headerSubtitle}>
            Quỹ chung: {formatVND(fundBalance)}
          </Text>
        </View>
        <View style={styles.headerPlaceholder} />
      </View>

      {/* Tabs Menu */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'balances' && styles.tabItemActive]}
          onPress={() => setActiveTab('balances')}
        >
          <Text style={[styles.tabText, activeTab === 'balances' && styles.tabTextActive]}>Số dư Ròng</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'expenses' && styles.tabItemActive]}
          onPress={() => setActiveTab('expenses')}
        >
          <Text style={[styles.tabText, activeTab === 'expenses' && styles.tabTextActive]}>Lịch sử Chi</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'add' && styles.tabItemActive]}
          onPress={() => setActiveTab('add')}
        >
          <Text style={[styles.tabText, activeTab === 'add' && styles.tabTextActive]}>+ Chi tiêu</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'settlement' && styles.tabItemActive]}
          onPress={() => setActiveTab('settlement')}
        >
          <Text style={[styles.tabText, activeTab === 'settlement' && styles.tabTextActive]}>Quyết toán</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content}>
        {/* TAB 1: SỐ DƯ RÒNG CỦA TỪNG THÀNH VIÊN */}
        {activeTab === 'balances' && (() => {
          const totalTripSpent = memberStates.reduce((sum, m) => sum + m.totalSpent, 0);
          const pieChartData = memberStates.map((m, idx) => ({
            id: m.userId,
            label: m.displayName,
            value: m.totalContributed,
            color: MEMBER_COLORS[idx % MEMBER_COLORS.length],
          }));

          return (
            <View style={styles.tabContent}>
              {/* Biểu đồ tròn đóng góp quỹ nhóm */}
              <BeautifulPieChart
                data={pieChartData}
                title="💰 Tỉ lệ Đóng góp Quỹ nhóm"
                centerLabel={memberStates.length.toString()}
              />

              {/* Bảng Chúa nợ và Chủ nợ */}
              <View style={styles.debtorCreditorContainer}>
                {/* Chủ nợ */}
                <View style={[styles.debtorCreditorCard, styles.creditorCard]}>
                  <Text style={styles.debtorCreditorHeader}>💰 Chủ nợ (Hoàn tiền)</Text>
                  {memberStates.filter(m => m.netBalance > 0).length === 0 ? (
                    <Text style={styles.debtorCreditorEmpty}>Không có chủ nợ</Text>
                  ) : (
                    memberStates
                      .filter(m => m.netBalance > 0)
                      .sort((a, b) => b.netBalance - a.netBalance)
                      .map((m, mIdx) => (
                        <View key={`${m.userId}-${mIdx}`} style={styles.debtorCreditorRow}>
                          <Text style={styles.debtorCreditorName} numberOfLines={1}>🟢 {m.displayName}</Text>
                          <Text style={styles.debtorCreditorAmount}>+{formatVND(m.netBalance)}</Text>
                        </View>
                      ))
                  )}
                </View>

                {/* Chúa nợ */}
                <View style={[styles.debtorCreditorCard, styles.debtorCard]}>
                  <Text style={styles.debtorCreditorHeader}>👑 Chúa nợ (Phải đóng)</Text>
                  {memberStates.filter(m => m.netBalance < 0).length === 0 ? (
                    <Text style={styles.debtorCreditorEmpty}>Không có chúa nợ</Text>
                  ) : (
                    memberStates
                      .filter(m => m.netBalance < 0)
                      .sort((a, b) => a.netBalance - b.netBalance)
                      .map((m, mIdx) => (
                        <View key={`${m.userId}-${mIdx}`} style={styles.debtorCreditorRow}>
                          <Text style={styles.debtorCreditorName} numberOfLines={1}>🔴 {m.displayName}</Text>
                          <Text style={styles.debtorCreditorAmount}>{formatVND(m.netBalance)}</Text>
                        </View>
                      ))
                  )}
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>📊 Bảng cân đối Số dư Ròng (Net Balance)</Text>
                <Text style={styles.cardDesc}>
                  Số tiền thực tế mỗi người được nhận lại (+) hoặc cần phải nộp thêm (-) để đưa toàn bộ chuyến đi về trạng thái cân bằng.
                  {'\n'}
                  <Text style={styles.boldText}>Net Balance = (Nạp quỹ) + (Tự ứng) - (Tiền gánh splits)</Text>
                </Text>

                {memberStates.map((m, idx) => {
                  const percent = totalTripSpent > 0 ? (m.totalSpent / totalTripSpent) * 100 : 0;
                  const color = MEMBER_COLORS[idx % MEMBER_COLORS.length];
                  return (
                    <View key={m.userId} style={styles.balanceItemContainer}>
                      <View style={styles.balanceItem}>
                        <View style={styles.memberInfo}>
                          <View style={[styles.avatar, { backgroundColor: color }]}>
                            <Text style={styles.avatarText}>{(m.displayName || 'Thành viên').charAt(0).toUpperCase()}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.memberName}>{m.displayName || 'Thành viên'}</Text>
                            <Text style={styles.memberContribution}>
                              Nạp quỹ: {formatVND(m.totalContributed)} | Ứng túi: {formatVND(m.totalPaidOutOfPocket)}
                            </Text>
                            <Text style={styles.memberContribution}>
                              Tiền gánh splits: {formatVND(m.totalSpent)} ({percent.toFixed(1)}%)
                            </Text>
                          </View>
                        </View>
                        <View style={styles.balanceRight}>
                          <Text style={[styles.memberBalance, m.netBalance >= 0 ? styles.positiveText : styles.negativeText]}>
                            {m.netBalance >= 0 ? '+' : ''}{formatVND(m.netBalance)}
                          </Text>
                          <Text style={styles.memberRatio}>
                            {m.netBalance >= 0 ? 'Được hoàn' : 'Phải đóng'}
                          </Text>
                        </View>
                      </View>
                      
                      {/* Progress Bar dưới tên từng thành viên */}
                      {totalTripSpent > 0 && (
                        <View style={styles.memberProgressBarBg}>
                          <View 
                            style={[
                              styles.memberProgressBarFill, 
                              { 
                                width: `${percent}%`, 
                                backgroundColor: color 
                              }
                            ]} 
                          />
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            </View>
          );
        })()}

        {/* TAB 2: LỊCH SỬ CHI TIÊU VÀ PHÂN CHIA CHI TIẾT */}
        {activeTab === 'expenses' && (
          <View style={styles.tabContent}>
            <View style={styles.expensesHeaderRow}>
              <Text style={styles.sectionTitle}>Danh sách hóa đơn</Text>
              {expenses.length > 0 && (
                <TouchableOpacity style={styles.exportButton} onPress={handleExportCSV}>
                  <Text style={styles.exportButtonText}>📥 Xuất dữ liệu CSV</Text>
                </TouchableOpacity>
              )}
            </View>
            {expenses.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyEmoji}>💸</Text>
                <Text style={styles.emptyText}>Chưa có khoản chi tiêu nào được ghi nhận cho chuyến đi này.</Text>
              </View>
            ) : (
              expenses.map(exp => {
                const avatarBgColor = MEMBER_COLORS[exp.id % MEMBER_COLORS.length];
                const initial = exp.paidByName ? exp.paidByName.charAt(0).toUpperCase() : '🏦';

                return (
                  <TouchableOpacity
                    key={exp.id}
                    style={styles.expenseCard}
                    activeOpacity={0.7}
                    onPress={() => {
                      setSelectedExpense(exp);
                      setExpenseModalVisible(true);
                    }}
                  >
                    <View style={styles.expenseListRow}>
                      {/* Avatar người trả tiền */}
                      <View style={[styles.payerAvatar, { backgroundColor: avatarBgColor }]}>
                        <Text style={styles.payerAvatarText}>{initial}</Text>
                      </View>

                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <View style={styles.expensesHeaderRow}>
                          <Text style={styles.expenseDesc} numberOfLines={1}>{exp.description}</Text>
                          <Text style={styles.expenseAmount}>{formatVND(exp.total_amount)}</Text>
                        </View>

                        <View style={styles.expenseSubRow}>
                          <Text style={styles.expensePaidBy}>
                            Nguồn chi: <Text style={styles.boldText}>{exp.paidByName}</Text>
                          </Text>
                          {/* Trạng thái sync */}
                          <View style={styles.syncBadge}>
                            <Text style={styles.syncBadgeText}>☁️ Đã lưu đám mây</Text>
                          </View>
                        </View>
                        
                        <View style={styles.expenseFooterRow}>
                          <Text style={styles.expenseDate}>{exp.created_at}</Text>
                          {exp.billImageUri ? (
                            <View style={styles.viewBillBadge}>
                              <Text style={styles.viewBillBadgeText}>📄 Có ảnh hóa đơn</Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        )}

        {/* TAB 3: THÊM CHI TIÊU MỚI (CHIA ĐỀU HOẶC PERCENT) */}
        {activeTab === 'add' && (
          <View style={styles.tabContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>➕ Ghi nhận hóa đơn mới</Text>
              
              {/* KHU VỰC THIẾT LẬP AI OCR */}
              <View style={styles.aiConfigContainer}>
                {/* NÚT CHỤP / CHỌN ẢNH HOÁ ĐƠN */}
                <View style={styles.ocrButtonRow}>
                  <TouchableOpacity style={styles.ocrTriggerButton} onPress={handleCaptureInvoice}>
                    <Text style={styles.ocrTriggerButtonText}>📸 Chụp hóa đơn</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.ocrTriggerButton, styles.ocrTriggerGalleryButton]} onPress={handlePickInvoice}>
                    <Text style={styles.ocrTriggerButtonText}>🖼️ Chọn từ máy</Text>
                  </TouchableOpacity>
                </View>

                {/* TRẠNG THÁI LOADING PHÂN TÍCH */}
                {ocrLoading && (
                  <View style={styles.ocrLoadingBox}>
                    <ActivityIndicator size="small" color="#1E3A8A" />
                    <Text style={styles.ocrLoadingText}>AI đang phân tích hóa đơn...</Text>
                  </View>
                )}

                {/* XEM TRƯỚC ẢNH HOÁ ĐƠN ĐÃ LƯU */}
                {billImageUri && (
                  <View style={styles.billPreviewCard}>
                    <Image source={{ uri: billImageUri }} style={styles.billPreviewThumbnail} />
                    <View style={styles.billPreviewInfo}>
                      <Text style={styles.billPreviewFileName} numberOfLines={1}>
                        {billImageUri.split('/').pop()}
                      </Text>
                      <TouchableOpacity onPress={() => setBillImageUri(null)}>
                        <Text style={styles.billPreviewDeleteBtn}>✕ Gỡ ảnh</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>

              <Text style={styles.inputLabel}>Mô tả khoản chi *</Text>
              <TextInput
                style={styles.input}
                placeholder="Ví dụ: Taxi ra sân bay, Ăn hải sản tối..."
                value={description}
                onChangeText={setDescription}
              />

              <Text style={styles.inputLabel}>Số tiền (VNĐ) *</Text>
              <TextInput
                style={styles.input}
                placeholder="Nhập số tiền..."
                keyboardType="numeric"
                value={amount}
                onChangeText={setAmount}
              />

              <Text style={styles.inputLabel}>Phương thức thanh toán *</Text>
              <View style={styles.payerList}>
                {/* Lựa chọn chi bằng Quỹ chung */}
                <TouchableOpacity
                  style={[styles.payerButton, paidByUserId === null && styles.payerButtonActive]}
                  onPress={() => setPaidByUserId(null)}
                >
                  <Text style={[styles.payerButtonText, paidByUserId === null && styles.payerButtonTextActive]}>
                    🏦 Chi bằng Quỹ chung
                  </Text>
                </TouchableOpacity>

                {/* Các thành viên tự ứng tiền túi */}
                {members.map(m => (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.payerButton, paidByUserId === m.id && styles.payerButtonActive]}
                    onPress={() => setPaidByUserId(m.id)}
                  >
                    <Text style={[styles.payerButtonText, paidByUserId === m.id && styles.payerButtonTextActive]}>
                      👤 {m.display_name} ứng tiền túi
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.inputLabel}>Cách thức phân chia hóa đơn *</Text>
              <View style={styles.payerList}>
                <TouchableOpacity
                  style={[styles.payerButton, splitType === 'EQUAL' && styles.payerButtonActive]}
                  onPress={() => setSplitType('EQUAL')}
                >
                  <Text style={[styles.payerButtonText, splitType === 'EQUAL' && styles.payerButtonTextActive]}>
                    🧮 Chia đều (EQUAL)
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.payerButton, splitType === 'PERCENT' && styles.payerButtonActive]}
                  onPress={() => setSplitType('PERCENT')}
                >
                  <Text style={[styles.payerButtonText, splitType === 'PERCENT' && styles.payerButtonTextActive]}>
                    📊 Chia theo % (PERCENT)
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.inputLabel}>Ai cùng tham gia gánh hóa đơn này? *</Text>
              <View style={styles.checklist}>
                {members.map(m => {
                  const isChecked = selectedMemberIds.includes(m.id);
                  return (
                    <View key={m.id} style={[styles.checkItem, isChecked && styles.checkItemActive]}>
                      <TouchableOpacity
                        style={styles.checkboxContainer}
                        onPress={() => toggleSelectMember(m.id)}
                      >
                        <View style={[styles.checkbox, isChecked && styles.checkboxChecked]} />
                        <Text style={[styles.checkText, isChecked && styles.boldText]}>{m.display_name}</Text>
                      </TouchableOpacity>

                      {/* Hiển thị ô nhập phần trăm nếu chọn PERCENT */}
                      {isChecked && splitType === 'PERCENT' && (
                        <View style={styles.percentInputContainer}>
                          <TextInput
                            style={styles.percentInput}
                            keyboardType="numeric"
                            placeholder="0"
                            maxLength={3}
                            value={memberPercents[m.id] || ''}
                            onChangeText={(val) => handlePercentChange(m.id, val)}
                          />
                          <Text style={styles.percentSymbol}>%</Text>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>

              <TouchableOpacity
                style={[styles.submitButton, isSubmitting && styles.disabledButton]}
                onPress={handleAddExpense}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.submitButtonText}>Lưu hóa đơn & Phân chia</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* TAB 4: QUYẾT TOÁN & BÁO CÁO TINH GIẢN NỢ */}
        {activeTab === 'settlement' && (
          <View style={styles.tabContent}>
            <View style={styles.card}>
              <View style={styles.settlementHeaderRow}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={styles.cardTitle}>🤝 Quyết toán thông minh (Tối giản chuyển tiền)</Text>
                </View>
                <TouchableOpacity
                  style={styles.lightbulbButton}
                  onPress={() => setShowAboutSettlementModal(true)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.lightbulbButtonText}>💡</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.cardDesc}>
                Nhóm của bạn muốn kết thúc chuyến đi và cân bằng tài chính? Chỉ cần những người âm tiền chuyển khoản đúng số tiền dưới đây cho người dư dôi, toàn bộ nhóm sẽ hoàn toàn sòng phẳng!
              </Text>

              {debtTransactions.length === 0 ? (
                <View style={styles.successSettlement}>
                  <Text style={styles.successSettlementEmoji}>🎉</Text>
                  <Text style={styles.successSettlementTitle}>Tất cả số dư ròng đã bằng 0!</Text>
                  <Text style={styles.successSettlementDesc}>
                    Cả nhóm đã hoàn thành chia tiền sòng phẳng tuyệt đối. Không cần thêm bất kỳ giao dịch chuyển tiền cấn trừ nào khác.
                  </Text>
                </View>
              ) : !isSettlementActive ? (
                <View style={styles.initialSettlementView}>
                  <Text style={styles.settlementPromptText}>
                    Hệ thống đã sẵn sàng tính toán phương án chuyển tiền tối giản nhất cho nhóm của bạn.
                  </Text>

                  <TouchableOpacity
                    style={styles.startSettlementBtn}
                    onPress={() => setIsSettlementActive(true)}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.startSettlementBtnText}>🚀 Bắt đầu Quyết toán</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.transactionList}>
                  {debtTransactions.map((tx, idx) => renderTransactionItem(tx, idx))}

                  <TouchableOpacity
                    style={[styles.completeSettlementBtn, isCompletingSettlement && styles.disabledButton]}
                    onPress={handleCompleteSettlement}
                    disabled={isCompletingSettlement}
                    activeOpacity={0.8}
                  >
                    {isCompletingSettlement ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.completeSettlementBtnText}>✅ Xác nhận đã chuyển & Hoàn tất Quyết toán</Text>
                    )}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.cancelSettlementBtn}
                    onPress={() => setIsSettlementActive(false)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.cancelSettlementBtnText}>Quay lại</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        )}
        
        {/* Khoảng trống ở dưới ScrollView */}
        <View style={{ height: 40 }} />
      </ScrollView>

      {/* MODAL PHÓNG TO XEM ẢNH HOÁ ĐƠN TRONG LỊCH SỬ */}
      <Modal
        visible={previewImageUri !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setPreviewImageUri(null)}
      >
        <SafeAreaView style={styles.modalBackground}>
          <TouchableOpacity 
            style={styles.modalCloseButton} 
            onPress={() => setPreviewImageUri(null)}
          >
            <Text style={styles.modalCloseButtonText}>✕ Đóng</Text>
          </TouchableOpacity>
          <View style={styles.modalImageContainer}>
            {previewImageUri && (
              <Image 
                source={{ uri: previewImageUri }} 
                style={styles.modalFullImage} 
                resizeMode="contain" 
              />
            )}
          </View>
        </SafeAreaView>
      </Modal>

      {/* MODAL GIẢI THÍCH Ý NGHĨA QUYẾT TOÁN (CHÚ THÍCH POPUP) */}
      <Modal
        visible={showAboutSettlementModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowAboutSettlementModal(false)}
      >
        <View style={styles.popOverOverlay}>
          {/* Nhấn ra ngoài nền để đóng popup */}
          <Pressable 
            style={StyleSheet.absoluteFill} 
            onPress={() => setShowAboutSettlementModal(false)} 
          />
          
          <View style={styles.popOverContent}>
            <View style={styles.popOverHeader}>
              <Text style={styles.popOverTitle}>💡 Khi nào cần Quyết toán?</Text>
              <TouchableOpacity onPress={() => setShowAboutSettlementModal(false)}>
                <Text style={styles.popOverCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flex: 1, width: '100%' }}>
              <ScrollView 
                style={styles.popOverBody} 
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 20 }}
              >
                {/* Hộp thông báo khi nào cần quyết toán di chuyển vào trong Modal */}
                <View style={[styles.infoAlertBox, { marginTop: 0, marginBottom: 16 }]}>
                  <Text style={styles.infoAlertTitle}>🔔 Hướng dẫn quyết toán</Text>
                  <Text style={styles.infoAlertText}>
                    • Khi chuyến đi hoặc sự kiện đã kết thúc và nhóm muốn chia đều sòng phẳng toàn bộ chi phí.
                  </Text>
                  <Text style={styles.infoAlertText}>
                    • Khi bạn muốn đưa số dư ròng của các thành viên về 0đ và cân bằng Quỹ chung về 0đ để bắt đầu một đợt chi tiêu hoặc chuyến đi mới.
                  </Text>
                </View>

                <Text style={styles.popOverSectionTitle}>1. Số dư Ròng (Net Balance)</Text>
                <Text style={styles.popOverText}>
                  Biểu thị số tiền thực tế một thành viên đang thừa hoặc thiếu trong chuyến đi:
                </Text>
                <Text style={styles.popOverBullet}>
                  • <Text style={{fontWeight: 'bold'}}>Số dư âm (Con nợ):</Text> Là người chi tiêu, ăn uống nhiều hơn số tiền họ đã đóng góp hoặc tự ứng. Họ cần chuyển khoản trả tiền cho nhóm.
                </Text>
                <Text style={styles.popOverBullet}>
                  • <Text style={{fontWeight: 'bold'}}>Số dư dương (Chủ nợ):</Text> Là người đã nộp quỹ nhiều hoặc tự rút tiền túi ứng trước cho nhóm chi tiêu. Họ cần nhận lại tiền bù đắp từ các thành viên khác.
                </Text>

                <Text style={styles.popOverSectionTitle}>2. Tinh giản nợ thông minh</Text>
                <Text style={styles.popOverText}>
                  Thay vì mọi người phải chuyển tiền lẻ tẻ qua lại lẫn nhau nhiều lần, ứng dụng sử dụng thuật toán cấn trừ nợ nâng cao (tương tự Splitwise).
                </Text>
                <Text style={styles.popOverText}>
                  Thuật toán sẽ tính toán và gom các khoản nợ lại để đưa ra số lượt chuyển tiền **tối thiểu**, chuyển khoản trực tiếp từ người nợ nhiều nhất đến người nhận nhiều nhất.
                </Text>

                <Text style={styles.popOverSectionTitle}>3. Sự tham gia của Quỹ chung</Text>
                <Text style={styles.popOverText}>
                  Nếu nhóm có chi tiêu trực tiếp bằng Quỹ chung và dẫn đến Quỹ chung bị âm hoặc dương, Quỹ chung sẽ tham gia vào quyết toán như một thành viên:
                </Text>
                <Text style={styles.popOverBullet}>
                  • Nếu <Text style={{fontWeight: 'bold', color: '#EF4444'}}>Quỹ chung bị âm</Text>, các thành viên nợ tiền cần nộp tiền vào Quỹ chung để bù đắp phần đã chi lạm phát.
                </Text>
                <Text style={styles.popOverBullet}>
                  • Nếu <Text style={{fontWeight: 'bold', color: '#10B981'}}>Quỹ chung còn dư</Text>, số tiền thừa đó sẽ được rút ra hoàn trả lại sòng phẳng cho những người đã đóng dư ban đầu.
                </Text>
              </ScrollView>
            </View>
            <TouchableOpacity 
              style={styles.popOverCloseBtn} 
              onPress={() => setShowAboutSettlementModal(false)}
            >
              <Text style={styles.popOverCloseBtnText}>Đóng</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal chi tiết hóa đơn, ảnh hóa đơn & phân rã gánh nợ */}
      <Modal
        visible={expenseModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setExpenseModalVisible(false)}
      >
        <View style={styles.popOverOverlay}>
          <Pressable 
            style={StyleSheet.absoluteFill} 
            onPress={() => setExpenseModalVisible(false)} 
          />
          
          <View style={[styles.popOverContent, { height: SCREEN_HEIGHT * 0.82 }]}>
            <View style={styles.popOverHeader}>
              <Text style={styles.popOverTitle}>📝 Chi tiết Chi tiêu</Text>
              <TouchableOpacity onPress={() => setExpenseModalVisible(false)}>
                <Text style={styles.popOverCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>

            {selectedExpense && (
              <View style={{ flex: 1, width: '100%' }}>
                <ScrollView 
                  style={styles.popOverBody} 
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ paddingBottom: 20 }}
                >
                  <View style={styles.modalInfoCard}>
                    <Text style={styles.modalExpenseDesc}>{selectedExpense.description}</Text>
                    <Text style={styles.modalExpenseAmount}>{formatVND(selectedExpense.total_amount)}</Text>
                    
                    <View style={styles.modalInfoRow}>
                      <Text style={styles.modalInfoLabel}>Nguồn chi trả:</Text>
                      <Text style={styles.modalInfoValue}>{selectedExpense.paidByName}</Text>
                    </View>
                    
                    <View style={styles.modalInfoRow}>
                      <Text style={styles.modalInfoLabel}>Ngày tạo:</Text>
                      <Text style={styles.modalInfoValue}>{selectedExpense.created_at}</Text>
                    </View>

                    <View style={styles.modalInfoRow}>
                      <Text style={styles.modalInfoLabel}>Trạng thái đồng bộ:</Text>
                      <View style={[styles.syncBadge, { marginHorizontal: 0 }]}>
                        <Text style={styles.syncBadgeText}>☁️ Đã lưu đám mây</Text>
                      </View>
                    </View>
                  </View>

                  {/* Phần rã splits gánh nợ */}
                  <Text style={styles.modalSectionTitle}>📊 Bảng phân rã gánh nợ</Text>
                  <View style={styles.splitsTable}>
                    <View style={styles.tableHeaderRow}>
                      <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Thành viên</Text>
                      <Text style={[styles.tableHeaderCell, { flex: 1, textAlign: 'center' }]}>Tỉ lệ</Text>
                      <Text style={[styles.tableHeaderCell, { flex: 2, textAlign: 'right' }]}>Số tiền gánh</Text>
                    </View>
                    
                    {selectedExpense.splits.map((split, sIdx) => {
                      const cellColor = MEMBER_COLORS[sIdx % MEMBER_COLORS.length];
                      return (
                        <View key={sIdx} style={styles.tableBodyRow}>
                          <View style={{ flex: 2, flexDirection: 'row', alignItems: 'center' }}>
                            <View style={[styles.tableAvatar, { backgroundColor: cellColor }]}>
                              <Text style={styles.tableAvatarText}>{(split.displayName || 'Thành viên').charAt(0).toUpperCase()}</Text>
                            </View>
                            <Text style={styles.tableMemberName}>{split.displayName || 'Thành viên'}</Text>
                          </View>
                          <Text style={[styles.tableBodyCell, { flex: 1, textAlign: 'center', fontWeight: '600', color: '#64748B' }]}>
                            {(split.ratio * 100).toFixed(1)}%
                          </Text>
                          <Text style={[styles.tableBodyCell, { flex: 2, textAlign: 'right', fontWeight: 'bold', color: '#1E293B' }]}>
                            {formatVND(split.calculatedAmount)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>

                  {/* Ảnh hóa đơn đính kèm */}
                  <Text style={styles.modalSectionTitle}>🖼️ Ảnh hóa đơn / Biên lai</Text>
                  {selectedExpense.billImageUri ? (
                    <View style={styles.modalBillImageContainer}>
                      <Image
                        source={{ uri: selectedExpense.billImageUri }}
                        style={styles.modalBillImage}
                        resizeMode="contain"
                      />
                      <TouchableOpacity
                        style={styles.zoomImageBtn}
                        onPress={() => {
                          setPreviewImageUri(selectedExpense.billImageUri || null);
                        }}
                      >
                        <Text style={styles.zoomImageBtnText}>🔍 Thu phóng ảnh</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.emptyImagePlaceholder}>
                      <Text style={styles.emptyImagePlaceholderIcon}>📄</Text>
                      <Text style={styles.emptyImagePlaceholderText}>Hóa đơn này không đính kèm ảnh chụp biên lai.</Text>
                    </View>
                  )}
                </ScrollView>
              </View>
            )}

            <TouchableOpacity 
              style={styles.popOverCloseBtn} 
              onPress={() => setExpenseModalVisible(false)}
            >
              <Text style={styles.popOverCloseBtnText}>Đóng</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Toast Notification nội bộ */}
      {toastVisible && (
        <View style={styles.toastContainer}>
          <View style={styles.toastCard}>
            <View style={styles.toastHeaderRow}>
              <Text style={styles.toastTitle}>🔔 Đồng bộ Realtime</Text>
              <Text style={styles.toastTime}>Vừa xong</Text>
            </View>
            <Text style={styles.toastText}>{toastMessage}</Text>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 24 : 0,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#4B5563',
    fontWeight: '500',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1E3A8A',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backIcon: {
    padding: 4,
  },
  backIconText: {
    fontSize: 26,
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  headerTitleContainer: {
    flex: 1,
    marginLeft: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#93C5FD',
    marginTop: 2,
  },
  headerPlaceholder: {
    width: 32,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  tabItem: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  tabItemActive: {
    borderBottomWidth: 3,
    borderBottomColor: '#1E3A8A',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  },
  tabTextActive: {
    color: '#1E3A8A',
    fontWeight: 'bold',
  },
  content: {
    flex: 1,
  },
  tabContent: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 6,
  },
  cardDesc: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
    marginBottom: 16,
  },
  balanceItemContainer: {
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    paddingVertical: 12,
  },
  balanceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  memberProgressBarBg: {
    height: 6,
    backgroundColor: '#F3F4F6',
    borderRadius: 3,
    marginTop: 8,
    overflow: 'hidden',
    marginLeft: 52,
  },
  memberProgressBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  aiConfigContainer: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  chartCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  chartCardTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#374151',
    marginBottom: 12,
  },
  stackedBarContainer: {
    flexDirection: 'row',
    height: 16,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#E5E7EB',
    marginBottom: 12,
  },
  legendContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 4,
  },
  legendText: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },
  expensesHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  exportButton: {
    backgroundColor: '#1E3A8A',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  exportButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  memberInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  memberName: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  memberContribution: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 2,
  },
  balanceRight: {
    alignItems: 'flex-end',
  },
  memberBalance: {
    fontSize: 15,
    fontWeight: 'bold',
  },
  memberRatio: {
    fontSize: 11,
    color: '#6B7280',
    marginTop: 2,
  },
  positiveText: {
    color: '#10B981',
  },
  negativeText: {
    color: '#EF4444',
  },
  emptyContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    marginTop: 8,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
  },
  expenseCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  expenseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  expenseDesc: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1F2937',
    flex: 1,
    marginRight: 8,
  },
  expensePaidBy: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 4,
  },
  boldText: {
    fontWeight: 'bold',
  },
  expenseAmount: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1E3A8A',
  },
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 12,
  },
  splitListTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4B5563',
    marginBottom: 8,
  },
  splitList: {
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    padding: 8,
  },
  splitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  splitMemberName: {
    fontSize: 13,
    color: '#4B5563',
  },
  splitAmountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  splitRatio: {
    fontSize: 11,
    color: '#9CA3AF',
    marginRight: 6,
  },
  splitAmount: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  expenseDate: {
    fontSize: 10,
    color: '#9CA3AF',
    marginTop: 12,
    textAlign: 'right',
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#374151',
    marginTop: 14,
    marginBottom: 6,
  },
  inputSubLabel: {
    fontSize: 11,
    color: '#6B7280',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1F2937',
  },
  payerList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  payerButton: {
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 20,
  },
  payerButtonActive: {
    backgroundColor: '#1E3A8A',
    borderColor: '#1E3A8A',
  },
  payerButtonText: {
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '500',
  },
  payerButtonTextActive: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  checklist: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
  },
  checkItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  checkItemActive: {
    backgroundColor: '#EFF6FF',
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingVertical: 4,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#9CA3AF',
    marginRight: 10,
  },
  checkboxChecked: {
    backgroundColor: '#1E3A8A',
    borderColor: '#1E3A8A',
  },
  checkText: {
    fontSize: 14,
    color: '#374151',
  },
  percentInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    paddingHorizontal: 8,
    width: 70,
    height: 36,
  },
  percentInput: {
    flex: 1,
    fontSize: 14,
    color: '#1F2937',
    padding: 0,
    textAlign: 'right',
    fontWeight: 'bold',
  },
  percentSymbol: {
    fontSize: 12,
    color: '#6B7280',
    marginLeft: 2,
    fontWeight: '600',
  },
  submitButton: {
    backgroundColor: '#10B981',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  disabledButton: {
    backgroundColor: '#9CA3AF',
  },
  submitButtonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  successSettlement: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  successSettlementEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  successSettlementTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#10B981',
    marginBottom: 6,
  },
  successSettlementDesc: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 16,
  },
  transactionList: {
    gap: 10,
  },
  transactionItem: {
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#3B82F6',
  },
  txLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  txFromName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#EF4444',
  },
  txArrow: {
    fontSize: 13,
    color: '#6B7280',
  },
  txAmount: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1E3A8A',
  },
  txToName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#10B981',
  },

  ocrButtonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  ocrTriggerButton: {
    flex: 1,
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ocrTriggerGalleryButton: {
    backgroundColor: '#6B7280',
  },
  ocrTriggerButtonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 13,
  },
  ocrLoadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    paddingVertical: 8,
    marginTop: 10,
    gap: 6,
  },
  ocrLoadingText: {
    fontSize: 12,
    color: '#1E3A8A',
    fontWeight: '500',
  },
  billPreviewCard: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 8,
    marginTop: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  billPreviewThumbnail: {
    width: 44,
    height: 44,
    borderRadius: 6,
    backgroundColor: '#E5E7EB',
  },
  billPreviewInfo: {
    flex: 1,
    marginLeft: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  billPreviewFileName: {
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '500',
    flex: 1,
    marginRight: 8,
  },
  billPreviewDeleteBtn: {
    fontSize: 11,
    color: '#EF4444',
    fontWeight: 'bold',
  },
  expenseFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  viewBillBadge: {
    backgroundColor: '#EFF6FF',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  viewBillBadgeText: {
    fontSize: 11,
    color: '#1E40AF',
    fontWeight: 'bold',
  },
  modalBackground: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCloseButton: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 50 : 20,
    right: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    zIndex: 10,
  },
  modalCloseButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  modalImageContainer: {
    width: '100%',
    height: '80%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalFullImage: {
    width: '100%',
    height: '100%',
  },
  settlementHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  lightbulbButton: {
    backgroundColor: '#EFF6FF',
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lightbulbButtonText: {
    fontSize: 16,
  },
  initialSettlementView: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  infoAlertBox: {
    backgroundColor: '#FFFBEB',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    width: '100%',
    marginBottom: 16,
  },
  infoAlertTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#B45309',
    marginBottom: 6,
  },
  infoAlertText: {
    fontSize: 12,
    color: '#78350F',
    lineHeight: 18,
    marginBottom: 4,
  },
  settlementPromptText: {
    fontSize: 13,
    color: '#4B5563',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
    paddingHorizontal: 10,
  },
  startSettlementBtn: {
    backgroundColor: '#10B981',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    elevation: 4,
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  startSettlementBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  completeSettlementBtn: {
    backgroundColor: '#1E3A8A',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    width: '100%',
  },
  completeSettlementBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
  },
  cancelSettlementBtn: {
    marginTop: 12,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  cancelSettlementBtnText: {
    color: '#4B5563',
    fontWeight: '600',
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  popOverOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  popOverContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    width: '100%',
    height: SCREEN_HEIGHT * 0.7,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 10,
  },
  popOverHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    paddingBottom: 14,
    marginBottom: 16,
  },
  popOverTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  popOverCloseIcon: {
    fontSize: 20,
    color: '#9CA3AF',
    fontWeight: 'bold',
    padding: 4,
  },
  popOverBody: {
    width: '100%',
    flex: 1,
    marginVertical: 8,
  },
  popOverSectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1E3A8A',
    marginTop: 12,
    marginBottom: 6,
  },
  popOverText: {
    fontSize: 13,
    color: '#4B5563',
    lineHeight: 18,
    marginBottom: 8,
  },
  popOverBullet: {
    fontSize: 13,
    color: '#4B5563',
    lineHeight: 18,
    marginBottom: 6,
    paddingLeft: 8,
  },
  popOverCloseBtn: {
    backgroundColor: '#1E3A8A',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
  },
  popOverCloseBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
  },
  toastContainer: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 50 : 30,
    left: 16,
    right: 16,
    zIndex: 9999,
  },
  toastCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#10B981',
  },
  toastHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  toastTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#34D399',
  },
  toastTime: {
    fontSize: 10,
    color: '#94A3B8',
  },
  toastText: {
    fontSize: 13,
    color: '#F8FAFC',
    fontWeight: '500',
  },
  debtorCreditorContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 12,
    paddingHorizontal: 4,
  },
  debtorCreditorCard: {
    flex: 1,
    borderRadius: 12,
    padding: 12,
    marginHorizontal: 4,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  creditorCard: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  debtorCard: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  debtorCreditorHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 8,
  },
  debtorCreditorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 4,
  },
  debtorCreditorName: {
    fontSize: 12,
    fontWeight: '500',
    color: '#334155',
    flex: 1,
  },
  debtorCreditorAmount: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
  },
  debtorCreditorEmpty: {
    fontSize: 12,
    color: '#94A3B8',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 8,
  },
  expenseListRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  payerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  payerAvatarText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  expenseSubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  syncBadge: {
    backgroundColor: '#DCFCE7',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginHorizontal: 4,
  },
  syncBadgeText: {
    color: '#15803D',
    fontSize: 10,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
    paddingBottom: 24,
    flexShrink: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0F172A',
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F1F5F9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCloseBtnText: {
    fontSize: 14,
    color: '#64748B',
    fontWeight: 'bold',
  },
  modalScrollView: {
    flexGrow: 1,
    flexShrink: 1,
  },
  modalScrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  modalInfoCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  modalExpenseDesc: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 6,
  },
  modalExpenseAmount: {
    fontSize: 24,
    fontWeight: '800',
    color: '#1E3A8A',
    marginBottom: 16,
  },
  modalInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 4,
  },
  modalInfoLabel: {
    fontSize: 13,
    color: '#64748B',
    fontWeight: '500',
  },
  modalInfoValue: {
    fontSize: 13,
    color: '#1E293B',
    fontWeight: '600',
  },
  modalSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 12,
    marginTop: 8,
  },
  splitsTable: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
    marginBottom: 20,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    padding: 12,
  },
  tableHeaderCell: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  tableBodyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  tableBodyCell: {
    fontSize: 13,
  },
  tableAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  tableAvatarText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: 'bold',
  },
  tableMemberName: {
    fontSize: 13,
    fontWeight: '500',
    color: '#1E293B',
  },
  modalBillImageContainer: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 8,
    alignItems: 'center',
  },
  modalBillImage: {
    width: '100%',
    height: 250,
    borderRadius: 12,
  },
  zoomImageBtn: {
    backgroundColor: '#1E3A8A',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 10,
  },
  zoomImageBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  emptyImagePlaceholder: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#CBD5E1',
    padding: 32,
    alignItems: 'center',
  },
  emptyImagePlaceholderIcon: {
    fontSize: 32,
    color: '#94A3B8',
    marginBottom: 8,
  },
  emptyImagePlaceholderText: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
  },
});

class ErrorBoundary extends React.Component<any, { hasError: boolean; error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <SafeAreaView style={{ flex: 1, backgroundColor: '#FFF', padding: 20, justifyContent: 'center' }}>
          <Text style={{ fontSize: 20, fontWeight: 'bold', color: '#EF4444', marginBottom: 10 }}>
            Đã xảy ra lỗi giao diện!
          </Text>
          <Text style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
            {this.state.error?.toString() || 'Lỗi không xác định'}
          </Text>
          <Text style={{ fontSize: 12, color: '#9CA3AF', fontFamily: 'monospace', marginBottom: 20 }}>
            {this.state.error?.stack || ''}
          </Text>
          <TouchableOpacity
            style={{ backgroundColor: '#1E3A8A', padding: 14, borderRadius: 8, alignItems: 'center' }}
            onPress={() => this.setState({ hasError: false, error: null })}
          >
            <Text style={{ color: '#FFF', fontWeight: 'bold' }}>Thử lại</Text>
          </TouchableOpacity>
        </SafeAreaView>
      );
    }

    return this.props.children;
  }
}

export function TripExpensesScreen(props: TripExpensesScreenProps) {
  return (
    <ErrorBoundary>
      <TripExpensesScreenContent {...props} />
    </ErrorBoundary>
  );
}
