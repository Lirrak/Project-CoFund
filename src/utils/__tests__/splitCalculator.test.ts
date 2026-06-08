import { calculateMemberNetBalances, createExpenseWithSplits, splitCalculator, MemberState } from '../splitCalculator';
import { LocalDB } from '../../services/sqlite';

// Mock toàn bộ LocalDB để có thể chạy test độc lập ngoài môi trường Expo SQLite
jest.mock('../../services/sqlite', () => {
  const mockDb = {
    getAllAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    runAsync: jest.fn(),
    withTransactionAsync: jest.fn((callback) => callback()),
  };
  return {
    LocalDB: {
      getInstance: () => mockDb,
    },
  };
});

describe('New Split Calculator (EQUAL & PERCENT Splits with Out-of-Pocket Logic) Tests', () => {
  const mockDb = LocalDB.getInstance() as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateMemberNetBalances tests', () => {
    it('nên tính toán chính xác Số dư ròng (Net Balance) dựa trên đóng góp, tự ứng và tiền gánh', async () => {
      // Giả lập trạng thái nhóm:
      // User A (1) đóng góp 100,000 đ, tự ứng 50,000 đ, gánh splits 40,000 đ -> Net Balance = 100k + 50k - 40k = +110k
      // User B (2) đóng góp 50,000 đ, tự ứng 0 đ, gánh splits 80,000 đ -> Net Balance = 50k + 0 - 80k = -30k
      mockDb.getAllAsync.mockResolvedValueOnce([
        {
          userId: 1,
          displayName: 'User A',
          totalContributed: 100000,
          totalPaidOutOfPocket: 50000,
          totalSpent: 40000,
        },
        {
          userId: 2,
          displayName: 'User B',
          totalContributed: 50000,
          totalPaidOutOfPocket: 0,
          totalSpent: 80000,
        },
      ]);

      const groupId = 99;
      const result = await calculateMemberNetBalances(groupId);

      expect(mockDb.getAllAsync).toHaveBeenCalledTimes(1);
      expect(mockDb.getAllAsync.mock.calls[0][1]).toEqual([groupId, groupId, groupId, groupId]);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        userId: 1,
        displayName: 'User A',
        totalContributed: 100000,
        totalPaidOutOfPocket: 50000,
        totalSpent: 40000,
        netBalance: 110000,
      });

      expect(result[1]).toEqual({
        userId: 2,
        displayName: 'User B',
        totalContributed: 50000,
        totalPaidOutOfPocket: 0,
        totalSpent: 80000,
        netBalance: -30000,
      });
    });
  });

  describe('Kịch bản kiểm thử tích hợp thực tế theo yêu cầu', () => {
    it('nên hạch toán chính xác Scenario 1 & Scenario 2 đề ra', async () => {
      // --- GIẢ ĐỊNH KỊCH BẢN SCENARIO 1 ---
      // A đóng 70đ, B đóng 30đ vào quỹ chung 100đ.
      // Hóa đơn 1 trị giá 100đ chi bằng quỹ (paid_by = null), chia đều EQUAL (50-50) giữa A và B.
      
      mockDb.getFirstAsync.mockResolvedValueOnce({ group_id: 123 }); // Get group ID
      mockDb.runAsync.mockResolvedValueOnce({ lastInsertRowId: 1 });  // INSERT expense 1
      mockDb.runAsync.mockResolvedValue({ lastInsertRowId: 1 });     // INSERT splits & UPDATE fund
      
      const tripId = 1;
      const expense1Id = await createExpenseWithSplits(
        tripId,
        null, // null = Chi bằng Quỹ chung
        100,  // Hóa đơn 1: 100đ
        'Hóa đơn 1 (Quỹ chung)',
        '',
        [
          { userId: 1 }, // A
          { userId: 2 }, // B
        ],
        'EQUAL'
      );

      expect(expense1Id).toBe(1);

      // Xác minh SQL insert expense có paid_by = null
      expect(mockDb.runAsync).toHaveBeenCalledWith(
        'INSERT INTO expenses (trip_id, paid_by, total_amount, description, bill_image_uri) VALUES (?, ?, ?, ?, ?);',
        [tripId, null, 100, 'Hóa đơn 1 (Quỹ chung)', '']
      );

      // Xác minh splits được chia đều 50-50 (mỗi người 50đ)
      const splitCalls = mockDb.runAsync.mock.calls.filter((call: any) => call[0].startsWith('INSERT INTO splits'));
      expect(splitCalls).toHaveLength(2);
      expect(splitCalls[0][1]).toEqual([1, 1, 0.5, 50]); // A gánh 50đ
      expect(splitCalls[1][1]).toEqual([1, 2, 0.5, 50]); // B gánh 50đ

      // Xác minh trừ tiền quỹ chung
      expect(mockDb.runAsync).toHaveBeenCalledWith(
        'UPDATE funds SET balance = balance - ? WHERE group_id = ?;',
        [100, 123]
      );

      // GIẢ LẬP HÀM BÁO CÁO NET BALANCES SAU SCENARIO 1:
      // A đóng 70, gánh 50 -> Net = +20đ
      // B đóng 30, gánh 50 -> Net = -20đ
      mockDb.getAllAsync.mockResolvedValueOnce([
        { userId: 1, displayName: 'User A', totalContributed: 70, totalPaidOutOfPocket: 0, totalSpent: 50 },
        { userId: 2, displayName: 'User B', totalContributed: 30, totalPaidOutOfPocket: 0, totalSpent: 50 },
      ]);
      const netBalances1 = await calculateMemberNetBalances(123);
      expect(netBalances1[0].netBalance).toBe(20);  // A dư dôi 20đ (được hoàn)
      expect(netBalances1[1].netBalance).toBe(-20); // B thiếu 20đ (phải nộp thêm)


      // --- GIẢ ĐỊNH KỊCH BẢN SCENARIO 2 ---
      // A tự ứng 100đ cho hóa đơn thứ 2, chia đều EQUAL (50-50) giữa A và B.
      mockDb.getFirstAsync.mockResolvedValueOnce({ group_id: 123 }); // Get group ID
      mockDb.runAsync.mockResolvedValueOnce({ lastInsertRowId: 2 });  // INSERT expense 2

      const expense2Id = await createExpenseWithSplits(
        tripId,
        1,   // A (userId 1) tự ứng tiền túi
        100, // Hóa đơn 2: 100đ
        'Hóa đơn 2 (A tự ứng)',
        '',
        [
          { userId: 1 },
          { userId: 2 },
        ],
        'EQUAL'
      );

      expect(expense2Id).toBe(2);

      // Xác minh SQL insert expense có paid_by = 1 (A)
      expect(mockDb.runAsync).toHaveBeenCalledWith(
        'INSERT INTO expenses (trip_id, paid_by, total_amount, description, bill_image_uri) VALUES (?, ?, ?, ?, ?);',
        [tripId, 1, 100, 'Hóa đơn 2 (A tự ứng)', '']
      );

      // Xác minh KHÔNG gọi update trừ quỹ vì đây là khoản thành viên tự ứng
      const updateFundCalls = mockDb.runAsync.mock.calls.filter((call: any) => call[0].startsWith('UPDATE funds'));
      expect(updateFundCalls).toHaveLength(1); // Chỉ gọi 1 lần của hóa đơn 1

      // GIẢ LẬP HÀM BÁO CÁO NET BALANCES SAU CẢ 2 SCENARIO:
      // A đóng góp 70, tự ứng 100, gánh splits 100 (50 ở exp 1 + 50 ở exp 2) -> Net = 70 + 100 - 100 = +70đ
      // B đóng góp 30, tự ứng 0, gánh splits 100 (50 ở exp 1 + 50 ở exp 2) -> Net = 30 + 0 - 100 = -70đ
      mockDb.getAllAsync.mockResolvedValueOnce([
        { userId: 1, displayName: 'User A', totalContributed: 70, totalPaidOutOfPocket: 100, totalSpent: 100 },
        { userId: 2, displayName: 'User B', totalContributed: 30, totalPaidOutOfPocket: 0, totalSpent: 100 },
      ]);
      const netBalances2 = await calculateMemberNetBalances(123);
      expect(netBalances2[0].netBalance).toBe(70);  // A dư dôi 70đ (được hoàn 70đ)
      expect(netBalances2[1].netBalance).toBe(-70); // B nợ 70đ (phải nộp thêm 70đ)

      // Xác minh giải thuật tinh giản nợ tính toán đúng giao dịch: B trả 70đ cho A
      const transactions = splitCalculator.simplifyDebts(netBalances2);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toEqual({
        fromUserId: 2,
        fromDisplayName: 'User B',
        toUserId: 1,
        toDisplayName: 'User A',
        amount: 70,
      });
    });

    it('nên giải quyết hoàn hảo case trong ảnh (Chia không đều PERCENT, đóng góp lệch)', async () => {
      // Case từ ảnh:
      // Em (A, userId 10) ăn 25, đóng quỹ 75 -> Net mong muốn = 75 - 25 = +50đ
      // Anh (B, userId 11) ăn 75, đóng quỹ 25 -> Net mong muốn = 25 - 75 = -50đ
      // Hóa đơn 100đ chi từ quỹ chung.
      
      mockDb.getFirstAsync.mockResolvedValueOnce({ group_id: 123 }); // Get group ID
      mockDb.runAsync.mockResolvedValueOnce({ lastInsertRowId: 10 }); // INSERT expense

      const tripId = 1;
      await createExpenseWithSplits(
        tripId,
        null, // chi bằng quỹ
        100,
        'Hóa đơn ăn chia theo phần %',
        '',
        [
          { userId: 10, percent: 25 }, // Em ăn 25%
          { userId: 11, percent: 75 }, // Anh ăn 75%
        ],
        'PERCENT'
      );

      // Xác minh splits được gán tỉ lệ tương ứng
      const splitCalls = mockDb.runAsync.mock.calls.filter((call: any) => call[0].startsWith('INSERT INTO splits'));
      // Lấy 2 split calls cuối cùng
      const currentSplits = splitCalls.slice(-2);
      expect(currentSplits[0][1]).toEqual([10, 10, 0.25, 25]); // Em gánh 25đ
      expect(currentSplits[1][1]).toEqual([10, 11, 0.75, 75]); // Anh gánh 75đ

      // GIẢ LẬP SỐ DƯ RÒNG (NET BALANCES)
      const mockNetData: MemberState[] = [
        {
          userId: 10,
          displayName: 'Em',
          totalContributed: 75,
          totalPaidOutOfPocket: 0,
          totalSpent: 25,
          netBalance: 50, // 75 - 25
        },
        {
          userId: 11,
          displayName: 'Anh',
          totalContributed: 25,
          totalPaidOutOfPocket: 0,
          totalSpent: 75,
          netBalance: -50, // 25 - 75
        },
      ];

      // Xác minh tinh giản nợ: Anh phải chuyển 50đ cho Em
      const txs = splitCalculator.simplifyDebts(mockNetData);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toEqual({
        fromUserId: 11,
        fromDisplayName: 'Anh',
        toUserId: 10,
        toDisplayName: 'Em',
        amount: 50,
      });
    });
  });
});
