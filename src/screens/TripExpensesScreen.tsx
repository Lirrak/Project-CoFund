import React, { useState, useEffect } from 'react';
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
import * as FileSystem from 'expo-file-system/legacy';

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

const MODEL_DIR = `${FileSystem.documentDirectory}models/`;
const MODEL_PATH = `${MODEL_DIR}qwen-1.5b.gguf`;
const DEFAULT_MODEL_URL = 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf';

function TripExpensesScreenContent({ tripId, tripName, groupId, onGoBack }: TripExpensesScreenProps) {
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'balances' | 'expenses' | 'add' | 'settlement'>('balances');

  // Dữ liệu từ DB
  const [memberStates, setMemberStates] = useState<MemberState[]>([]);
  const [members, setMembers] = useState<LocalGroupMember[]>([]);
  const [expenses, setExpenses] = useState<DisplayExpense[]>([]);
  const [fundBalance, setFundBalance] = useState<number>(0);

  // Form thêm chi tiêu mới
  const [amount, setAmount] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [paidByUserId, setPaidByUserId] = useState<number | null>(null); // null = Chi từ Quỹ chung
  const [selectedMemberIds, setSelectedMemberIds] = useState<number[]>([]);
  const [splitType, setSplitType] = useState<SplitType>('EQUAL');
  const [memberPercents, setMemberPercents] = useState<Record<number, string>>({}); // Lưu trữ % tùy chọn
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Cấu hình OCR AI & Local LLM
  const [billImageUri, setBillImageUri] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState<boolean>(false);
  const [aiMode, setAiMode] = useState<'heuristics' | 'llamacpp' | 'ondevice_llm'>('heuristics');
  const [llamaServerUrl, setLlamaServerUrl] = useState<string>('http://192.168.1.50:8080');
  const [showAiSettings, setShowAiSettings] = useState<boolean>(false);
  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);

  // Trạng thái tải mô hình AI On-Device (.gguf)
  const [isDownloadingModel, setIsDownloadingModel] = useState<boolean>(false);
  const [modelDownloadProgress, setModelDownloadProgress] = useState<number>(0);
  const [isModelReady, setIsModelReady] = useState<boolean>(false);

  // Tải toàn bộ dữ liệu liên quan
  const loadData = async () => {
    try {
      setLoading(true);
      const db = LocalDB.getInstance();

      // 0. Tải cấu hình cài đặt AI từ SQLite
      try {
        const savedAiMode = await db.getSetting('ai_mode');
        if (savedAiMode === 'heuristics' || savedAiMode === 'llamacpp' || savedAiMode === 'ondevice_llm') {
          setAiMode(savedAiMode);
        }
        const savedLlamaUrl = await db.getSetting('llama_server_url');
        if (savedLlamaUrl) {
          setLlamaServerUrl(savedLlamaUrl);
        }

        // Kiểm tra xem mô hình AI On-Device đã được tải về máy chưa
        const modelInfo = await FileSystem.getInfoAsync(MODEL_PATH);
        setIsModelReady(modelInfo.exists);
      } catch (err) {
        console.warn('Could not read settings, maybe tables are initializing...', err);
      }

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

  // Lưu cài đặt AI bền vững vào SQLite
  const saveAiSetting = async (key: string, value: string) => {
    const db = LocalDB.getInstance();
    await db.saveSetting(key, value);
  };

  // Hàm gọi API tới Local Llama.cpp Server để phân tích văn bản hóa đơn
  const parseAmountWithLlamaCpp = async (ocrLines: string[]): Promise<number | null> => {
    const fullText = ocrLines.join('\n');
    const prompt = `Bạn là trợ lý AI chuyên nghiệp phân tích hóa đơn tiếng Việt. 
Hãy đọc dữ liệu văn bản bóc tách từ hóa đơn dưới đây, tìm ra số tiền tổng cộng (Total Amount) cần thanh toán.
Yêu cầu bắt buộc: Trả về duy nhất một chuỗi JSON có định dạng: {"total_amount": số_tiền_chuyển_đổi_thành_số_nguyên}. Không giải thích gì thêm ngoài JSON.

Dữ liệu hóa đơn OCR:
"""
${fullText}
"""`;

    try {
      const response = await fetch(`${llamaServerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: "qwen",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      });

      const data = await response.json();
      const reply = data.choices[0].message.content.trim();
      
      // Tìm và trích xuất JSON từ câu trả lời của LLM
      const jsonMatch = reply.match(/\{.*\}/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.total_amount || null;
      }
      return null;
    } catch (error) {
      console.error('Lỗi kết nối tới local llama.cpp server:', error);
      Alert.alert(
        'Lỗi kết nối AI', 
        'Không thể kết nối tới máy chủ Llama.cpp nội bộ. Vui lòng kiểm tra địa chỉ IP hoặc chuyển sang chế độ Heuristics Offline.'
      );
      return null;
    }
  };

  // Hàm tải mô hình GGUF từ URL về thư mục cục bộ của ứng dụng
  const handleDownloadModel = async () => {
    try {
      setIsDownloadingModel(true);
      setModelDownloadProgress(0);

      // Đảm bảo thư mục models/ tồn tại
      const dirInfo = await FileSystem.getInfoAsync(MODEL_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
      }

      // Thiết lập download resumable kèm callback cập nhật tiến trình %
      const callback = (downloadProgress: any) => {
        const progress = downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite;
        setModelDownloadProgress(Math.round(progress * 100));
      };

      const downloadResumable = FileSystem.createDownloadResumable(
        DEFAULT_MODEL_URL,
        MODEL_PATH,
        {},
        callback
      );

      const result = await downloadResumable.downloadAsync();
      if (result && result.uri) {
        setIsModelReady(true);
        Alert.alert(
          'Tải mô hình thành công! 🎉',
          'Mô hình AI Qwen (1.5B) đã được lưu thành công trên thiết bị của bạn. Bạn đã sẵn sàng sử dụng trí tuệ nhân tạo offline 100%!'
        );
      }
    } catch (error: any) {
      console.error('Error downloading model:', error);
      Alert.alert('Lỗi tải mô hình', error?.message || 'Có lỗi xảy ra trong quá trình tải mô hình AI.');
    } finally {
      setIsDownloadingModel(false);
    }
  };

  // Gọi mô hình AI Llama.cpp trực tiếp TRÊN ĐIỆN THOẠI (On-Device Inference)
  const parseAmountWithOnDeviceLlama = async (ocrLines: string[]): Promise<number | null> => {
    const fullText = ocrLines.join('\n');
    const prompt = `Bạn là trợ lý AI chuyên nghiệp phân tích hóa đơn tiếng Việt. 
Hãy đọc dữ liệu văn bản bóc tách từ hóa đơn dưới đây, tìm ra số tiền tổng cộng (Total Amount) cần thanh toán.
Yêu cầu bắt buộc: Trả về duy nhất một chuỗi JSON có định dạng: {"total_amount": số_tiền_chuyển_đổi_thành_số_nguyên}. Không giải thích gì thêm ngoài JSON.

Dữ liệu hóa đơn OCR:
"""
${fullText}
"""`;

    // 1. Kiểm tra xem thư viện native react-native-llama có sẵn và hoạt động không
    let isLlamaLinked = false;
    try {
      // Thử load động thư viện native để tránh lỗi biên dịch trên môi trường Expo Go
      const LlamaModule = require('react-native-llama');
      if (LlamaModule && LlamaModule.initLlama) {
        isLlamaLinked = true;
      }
    } catch (e) {
      console.warn('react-native-llama is not linked in this build.');
    }

    if (!isLlamaLinked) {
      // Nếu không có native linking (chạy trong Expo Go hoặc chưa rebuilt), ném một lỗi cụ thể để kích hoạt Trình giả lập On-Device
      throw new Error("unlinked: Thư viện native 'react-native-llama' chưa được tích hợp vào build này.");
    }

    // 2. Chạy suy luận native on-device thực tế qua react-native-llama
    try {
      const LlamaModule = require('react-native-llama');
      
      console.log('Initializing on-device llama context from:', MODEL_PATH);
      const context = await LlamaModule.initLlama({
        model: MODEL_PATH,
        use_mlock: true,
        n_ctx: 1024,
      });

      console.log('Running on-device LLM inference...');
      const response = await context.completion({
        prompt: prompt,
        temperature: 0.1,
      });

      const reply = response.text.trim();
      console.log('On-device LLM reply:', reply);

      // Tìm và giải mã JSON
      const jsonMatch = reply.match(/\{.*\}/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.total_amount || null;
      }
      return null;
    } catch (error) {
      console.error('Error in on-device llama inference:', error);
      throw error;
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

      // 3. Phân tích bóc tách số tiền dựa trên cấu hình AI Mode
      let detectedAmount: number | null = null;
      if (aiMode === 'heuristics') {
        // Chế độ 1: Dùng Heuristics offline nhanh <1s
        detectedAmount = OCRParser.extractBillAmount(lines);
      } else if (aiMode === 'llamacpp') {
        // Chế độ 2: Dùng Llama.cpp Local Server
        detectedAmount = await parseAmountWithLlamaCpp(lines);
      } else if (aiMode === 'ondevice_llm') {
        // Chế độ 3: Chạy Llama.cpp trực tiếp trên điện thoại!
        if (!isModelReady) {
          Alert.alert(
            'Chưa tải mô hình AI 📥',
            'Bạn cần tải mô hình AI Qwen (1.5B) về điện thoại trước khi sử dụng chế độ On-Device LLM.\n\nVui lòng vào phần Cài đặt AI của biểu mẫu hóa đơn và bấm nút "Tải mô hình AI On-Device".'
          );
          return;
        }
        detectedAmount = await parseAmountWithOnDeviceLlama(lines);
      }

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

  // Tính toán báo cáo tinh giản nợ
  const debtTransactions = splitCalculator.simplifyDebts(memberStates);

  // Định dạng tiền VNĐ hiển thị
  const formatVND = (value: number) => {
    return Math.round(value).toLocaleString('vi-VN') + ' đ';
  };

  if (loading && memberStates.length === 0) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color="#1E3A8A" />
        <Text style={styles.loadingText}>Đang xử lý dữ liệu quỹ và chi tiêu...</Text>
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
        {activeTab === 'balances' && (
          <View style={styles.tabContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>📊 Bảng cân đối Số dư Ròng (Net Balance)</Text>
              <Text style={styles.cardDesc}>
                Số tiền thực tế mỗi người được nhận lại (+) hoặc cần phải nộp thêm (-) để đưa toàn bộ chuyến đi về trạng thái cân bằng.
                {'\n'}
                <Text style={styles.boldText}>Net Balance = (Nạp quỹ) + (Tự ứng) - (Tiền gánh splits)</Text>
              </Text>

              {memberStates.map(m => (
                <View key={m.userId} style={styles.balanceItem}>
                  <View style={styles.memberInfo}>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{m.displayName.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>{m.displayName}</Text>
                      <Text style={styles.memberContribution}>
                        Nạp quỹ: {formatVND(m.totalContributed)} | Ứng túi: {formatVND(m.totalPaidOutOfPocket)}
                      </Text>
                      <Text style={styles.memberContribution}>
                        Tiền gánh splits: {formatVND(m.totalSpent)}
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
              ))}
            </View>
          </View>
        )}

        {/* TAB 2: LỊCH SỬ CHI TIÊU VÀ PHÂN CHIA CHI TIẾT */}
        {activeTab === 'expenses' && (
          <View style={styles.tabContent}>
            <Text style={styles.sectionTitle}>Danh sách hóa đơn chuyến đi</Text>
            {expenses.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyEmoji}>💸</Text>
                <Text style={styles.emptyText}>Chưa có khoản chi tiêu nào được ghi nhận cho chuyến đi này.</Text>
              </View>
            ) : (
              expenses.map(exp => (
                <View key={exp.id} style={styles.expenseCard}>
                  <View style={styles.expenseHeader}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={styles.expenseDesc}>{exp.description}</Text>
                      <Text style={styles.expensePaidBy}>
                        Nguồn chi: <Text style={styles.boldText}>{exp.paidByName}</Text>
                      </Text>
                    </View>
                    <Text style={styles.expenseAmount}>{formatVND(exp.total_amount)}</Text>
                  </View>

                  <View style={styles.divider} />

                  <Text style={styles.splitListTitle}>Phân rã hóa đơn hạch toán:</Text>
                  <View style={styles.splitList}>
                    {exp.splits.map((s, idx) => (
                      <View key={idx} style={styles.splitRow}>
                        <Text style={styles.splitMemberName}>• {s.displayName}</Text>
                        <View style={styles.splitAmountContainer}>
                          <Text style={styles.splitRatio}>({(s.ratio * 100).toFixed(1)}%)</Text>
                          <Text style={styles.splitAmount}>{formatVND(s.calculatedAmount)}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                  <View style={styles.expenseFooterRow}>
                    <Text style={styles.expenseDate}>{exp.created_at}</Text>
                    {exp.billImageUri ? (
                      <TouchableOpacity 
                        style={styles.viewBillBadge}
                        onPress={() => setPreviewImageUri(exp.billImageUri || null)}
                      >
                        <Text style={styles.viewBillBadgeText}>📄 Xem ảnh hóa đơn</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              ))
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
                <View style={styles.aiConfigHeader}>
                  <Text style={styles.aiConfigTitle}>🤖 Động cơ AI phân tích hóa đơn</Text>
                  <TouchableOpacity onPress={() => setShowAiSettings(!showAiSettings)}>
                    <Text style={styles.aiSettingsToggle}>{showAiSettings ? '▼ Ẩn cấu hình' : '⚙️ Cài đặt'}</Text>
                  </TouchableOpacity>
                </View>

                {showAiSettings && (
                  <View style={styles.aiSettingsBox}>
                    <Text style={styles.aiSettingsLabel}>Chế độ nhận diện:</Text>
                    <View style={styles.aiModeRow}>
                      <TouchableOpacity
                        style={[styles.aiModeButton, aiMode === 'heuristics' && styles.aiModeButtonActive]}
                        onPress={async () => {
                          setAiMode('heuristics');
                          await saveAiSetting('ai_mode', 'heuristics');
                        }}
                      >
                        <Text style={[styles.aiModeButtonText, aiMode === 'heuristics' && styles.aiModeButtonTextActive]}>
                          ⚡ Heuristics
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.aiModeButton, aiMode === 'llamacpp' && styles.aiModeButtonActive]}
                        onPress={async () => {
                          setAiMode('llamacpp');
                          await saveAiSetting('ai_mode', 'llamacpp');
                        }}
                      >
                        <Text style={[styles.aiModeButtonText, aiMode === 'llamacpp' && styles.aiModeButtonTextActive]}>
                          💻 Laptop Server
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.aiModeButton, aiMode === 'ondevice_llm' && styles.aiModeButtonActive]}
                        onPress={async () => {
                          setAiMode('ondevice_llm');
                          await saveAiSetting('ai_mode', 'ondevice_llm');
                        }}
                      >
                        <Text style={[styles.aiModeButtonText, aiMode === 'ondevice_llm' && styles.aiModeButtonTextActive]}>
                          📱 On-Device LLM
                        </Text>
                      </TouchableOpacity>
                    </View>

                    {aiMode === 'llamacpp' && (
                      <View style={styles.llamaUrlContainer}>
                        <Text style={styles.aiSettingsLabel}>Llama Server API URL:</Text>
                        <TextInput
                          style={styles.llamaUrlInput}
                          value={llamaServerUrl}
                          onChangeText={async (val) => {
                            setLlamaServerUrl(val);
                            await saveAiSetting('llama_server_url', val);
                          }}
                          placeholder="http://192.168.1.50:8080"
                        />
                      </View>
                    )}

                    {aiMode === 'ondevice_llm' && (
                      <View style={styles.llamaUrlContainer}>
                        <Text style={styles.aiSettingsLabel}>Mô hình AI cục bộ trên điện thoại (Offline):</Text>
                        {isModelReady ? (
                          <View style={styles.modelReadyBox}>
                            <Text style={styles.modelReadyText}>✅ Qwen-1.5B đã sẵn sàng (950MB)</Text>
                            <TouchableOpacity onPress={handleDownloadModel} style={styles.modelRedownloadBtn}>
                              <Text style={styles.modelRedownloadText}>Tải lại 🔄</Text>
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <View>
                            {isDownloadingModel ? (
                              <View style={styles.downloadProgressBox}>
                                <Text style={styles.downloadProgressText}>📥 Đang tải mô hình: {modelDownloadProgress}%</Text>
                                <View style={styles.progressBarBg}>
                                  <View style={[styles.progressBarFill, { width: `${modelDownloadProgress}%` }]} />
                                </View>
                              </View>
                            ) : (
                              <TouchableOpacity style={styles.downloadModelBtn} onPress={handleDownloadModel}>
                                <Text style={styles.downloadModelBtnText}>📥 Tải mô hình AI On-Device (~950MB)</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                )}

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
              <Text style={styles.cardTitle}>🤝 Quyết toán thông minh (Tối giản chuyển tiền)</Text>
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
              ) : (
                <View style={styles.transactionList}>
                  {debtTransactions.map((tx, idx) => (
                    <View key={idx} style={styles.transactionItem}>
                      <View style={styles.txLine}>
                        <Text style={styles.txFromName}>{tx.fromDisplayName}</Text>
                        <Text style={styles.txArrow}>👉 chuyển khoản</Text>
                        <Text style={styles.txAmount}>{formatVND(tx.amount)}</Text>
                        <Text style={styles.txArrow}>cho</Text>
                        <Text style={styles.txToName}>{tx.toDisplayName}</Text>
                      </View>
                    </View>
                  ))}
                  
                  <View style={styles.warningCard}>
                    <Text style={styles.warningTitle}>💡 Ý nghĩa quyết toán:</Text>
                    <Text style={styles.warningText}>
                      • Các con nợ gánh nhiều hóa đơn hơn phần nộp quỹ ban đầu sẽ cấn trừ chuyển khoản thẳng cho chủ nợ (người nạp dư quỹ hoặc ứng nhiều tiền túi hơn).
                    </Text>
                    <Text style={styles.warningText}>
                      • Phương pháp tinh giản nợ này triệt tiêu số lần chuyển khoản trung gian, đem lại sự tiện lợi tối đa cho nhóm.
                    </Text>
                  </View>
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
    </SafeAreaView>
  );
}

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
  balanceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
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
  warningCard: {
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
  },
  warningTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#B45309',
    marginBottom: 6,
  },
  warningText: {
    fontSize: 12,
    color: '#78350F',
    lineHeight: 16,
    marginBottom: 4,
  },
  aiConfigContainer: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  aiConfigHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  aiConfigTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#1E3A8A',
  },
  aiSettingsToggle: {
    fontSize: 12,
    color: '#3B82F6',
    fontWeight: '600',
  },
  aiSettingsBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  aiSettingsLabel: {
    fontSize: 11,
    color: '#4B5563',
    fontWeight: '600',
    marginBottom: 4,
  },
  aiModeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  aiModeButton: {
    flex: 1,
    backgroundColor: '#F3F4F6',
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  aiModeButtonActive: {
    backgroundColor: '#DBEAFE',
    borderColor: '#3B82F6',
  },
  aiModeButtonText: {
    fontSize: 11,
    color: '#4B5563',
    fontWeight: '500',
  },
  aiModeButtonTextActive: {
    color: '#1E3A8A',
    fontWeight: 'bold',
  },
  llamaUrlContainer: {
    marginTop: 4,
  },
  llamaUrlInput: {
    backgroundColor: '#F3F4F6',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 12,
    color: '#1F2937',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  modelReadyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ECFDF5',
    borderRadius: 6,
    padding: 8,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    marginTop: 4,
  },
  modelReadyText: {
    fontSize: 12,
    color: '#065F46',
    fontWeight: '600',
  },
  modelRedownloadBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#D1FAE5',
    borderRadius: 4,
  },
  modelRedownloadText: {
    fontSize: 11,
    color: '#047857',
    fontWeight: 'bold',
  },
  downloadProgressBox: {
    backgroundColor: '#F9FAFB',
    borderRadius: 6,
    padding: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginTop: 4,
  },
  downloadProgressText: {
    fontSize: 12,
    color: '#1E3A8A',
    fontWeight: 'bold',
    marginBottom: 6,
  },
  progressBarBg: {
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#3B82F6',
    borderRadius: 4,
  },
  downloadModelBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 6,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  downloadModelBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 12,
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
