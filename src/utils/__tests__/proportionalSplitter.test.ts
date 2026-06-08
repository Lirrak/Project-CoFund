import { calculateMemberActualBalances, createExpenseWithSplits, splitCalculator, MemberState } from '../proportionalSplitter';
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

describe('Proportional Splitter & Local Expense Logging Module Tests', () => {
  const mockDb = LocalDB.getInstance() as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('calculateMemberActualBalances tests', () => {
    it('nên tính toán số dư thực tế và tỷ lệ đóng đóng góp chính xác trong trường hợp thông thường', async () => {
      // Giả lập dữ liệu truy vấn từ SQLite
      // p.id, p.display_name, p.avatar_color, totalContributed, totalSpent
      mockDb.getAllAsync.mockResolvedValueOnce([
        {
          userId: 1,
          displayName: 'User A',
          avatarColor: '#FFF',
          totalContributed: 100000,
          totalSpent: 10000,
        },
        {
          userId: 2,
          displayName: 'User B',
          avatarColor: '#000',
          totalContributed: 50000,
          totalSpent: 20000,
        },
        {
          userId: 3,
          displayName: 'User C',
          avatarColor: '#AAA',
          totalContributed: 0,
          totalSpent: 0,
        },
      ]);

      const groupId = 1;
      const result = await calculateMemberActualBalances(groupId);

      // Xác minh truy vấn SQL được chạy đúng tham số
      expect(mockDb.getAllAsync).toHaveBeenCalledTimes(1);
      expect(mockDb.getAllAsync.mock.calls[0][1]).toEqual([groupId, groupId, groupId]);

      // Xác minh số dư thực tế và tỷ lệ đóng góp (Tổng quỹ = 90000 + 30000 + 0 = 120000)
      expect(result).toHaveLength(3);

      expect(result[0]).toEqual({
        userId: 1,
        displayName: 'User A',
        avatarColor: '#FFF',
        totalContributed: 100000,
        totalSpent: 10000,
        balance: 90000,
        ratio: 0.75, // 90000 / 120000
      });

      expect(result[1]).toEqual({
        userId: 2,
        displayName: 'User B',
        avatarColor: '#000',
        totalContributed: 50000,
        totalSpent: 20000,
        balance: 30000,
        ratio: 0.25, // 30000 / 120000
      });

      expect(result[2]).toEqual({
        userId: 3,
        displayName: 'User C',
        avatarColor: '#AAA',
        totalContributed: 0,
        totalSpent: 0,
        balance: 0,
        ratio: 0.0, // 0 / 120000
      });
    });

    it('nên tự động chia đều cho tất cả thành viên trong nhóm khi tổng số dư quỹ bằng 0', async () => {
      mockDb.getAllAsync.mockResolvedValueOnce([
        {
          userId: 1,
          displayName: 'User A',
          avatarColor: '#FFF',
          totalContributed: 20000,
          totalSpent: 20000,
        },
        {
          userId: 2,
          displayName: 'User B',
          avatarColor: '#000',
          totalContributed: 0,
          totalSpent: 0,
        },
      ]);

      const result = await calculateMemberActualBalances(1);

      // Tổng quỹ = 0 + 0 = 0. Tỷ lệ tự động chia đều = 1 / 2 = 0.5
      expect(result[0].balance).toBe(0);
      expect(result[0].ratio).toBe(0.5);

      expect(result[1].balance).toBe(0);
      expect(result[1].ratio).toBe(0.5);
    });

    it('nên xử lý trường hợp quỹ bị âm (Overdraft) và duy trì tỷ lệ đóng góp lũy kế', async () => {
      mockDb.getAllAsync.mockResolvedValueOnce([
        {
          userId: 1,
          displayName: 'User A',
          avatarColor: '#FFF',
          totalContributed: 10000,
          totalSpent: 30000,
        },
        {
          userId: 2,
          displayName: 'User B',
          avatarColor: '#000',
          totalContributed: 20000,
          totalSpent: 40000,
        },
      ]);

      const result = await calculateMemberActualBalances(1);

      // User A balance = 10k - 30k = -20k
      // User B balance = 20k - 40k = -20k
      // Tổng số dư quỹ thực tế = -40k (Overdraft)
      // Tỷ lệ User A = -20k / -40k = 0.5
      // Tỷ lệ User B = -20k / -40k = 0.5
      expect(result[0].balance).toBe(-20000);
      expect(result[0].ratio).toBe(0.5);

      expect(result[1].balance).toBe(-20000);
      expect(result[1].ratio).toBe(0.5);
    });
  });

  describe('createExpenseWithSplits tests', () => {
    it('nên chia tiền lẻ VNĐ bằng Largest Remainder Method không sai sót và cập nhật quỹ trong transaction', async () => {
      // 1. Giả lập lấy thông tin group_id từ tripId
      mockDb.getFirstAsync.mockResolvedValueOnce({ group_id: 123 });

      // 2. Giả lập lấy số dư thực tế của nhóm (3 người, mỗi người có 30k đóng góp)
      mockDb.getAllAsync.mockResolvedValueOnce([
        {
          userId: 10,
          displayName: 'User A',
          avatarColor: '#1',
          totalContributed: 30000,
          totalSpent: 0,
        },
        {
          userId: 11,
          displayName: 'User B',
          avatarColor: '#2',
          totalContributed: 30000,
          totalSpent: 0,
        },
        {
          userId: 12,
          displayName: 'User C',
          avatarColor: '#3',
          totalContributed: 30000,
          totalSpent: 0,
        },
      ]);

      // 3. Giả lập chèn expense thành công (trả về lastInsertRowId = 55)
      mockDb.runAsync.mockResolvedValueOnce({ lastInsertRowId: 55 }); // INSERT expense
      mockDb.runAsync.mockResolvedValue({ lastInsertRowId: 1 }); // INSERT splits & UPDATE fund

      const tripId = 9;
      const paidByUserId = 10;
      const totalAmount = 10000; // 10,000 VNĐ gánh bởi cả 3 người
      const selectedMemberIds = [10, 11, 12];

      const expenseId = await createExpenseWithSplits(
        tripId,
        paidByUserId,
        totalAmount,
        'Hóa đơn ăn trưa dã ngoại',
        'file://bill.png',
        selectedMemberIds
      );

      expect(expenseId).toBe(55);

      // Xác minh transaction đã mở ra
      expect(mockDb.withTransactionAsync).toHaveBeenCalledTimes(1);

      // Xác minh ghi nhận hóa đơn mới
      expect(mockDb.runAsync).toHaveBeenCalledWith(
        'INSERT INTO expenses (trip_id, paid_by, total_amount, description, bill_image_uri) VALUES (?, ?, ?, ?, ?);',
        [tripId, paidByUserId, totalAmount, 'Hóa đơn ăn trưa dã ngoại', 'file://bill.png']
      );

      // Xác minh chia tiền lẻ và phân bổ phần dư VNĐ (Largest Remainder Method)
      // Tổng tiền = 10000 VNĐ chia 3. Tỷ lệ đóng góp bằng nhau (1/3).
      // Số tiền chia thô: A: 3333.3333, B: 3333.3333, C: 3333.3333
      // Số tiền làm tròn sàn: A: 3333, B: 3333, C: 3333 (Tổng = 9999)
      // Phần dư = 10000 - 9999 = 1.
      // Vì phần thập phân bằng nhau, ta sắp xếp theo userId tăng dần, do đó User 10 được cộng thêm 1 VNĐ.
      // Kết quả cuối cùng: User 10: 3334 VNĐ, User 11: 3333 VNĐ, User 12: 3333 VNĐ.
      
      // Kiểm tra xem splits được chèn vào database
      const insertSplitCalls = mockDb.runAsync.mock.calls.filter(
        (call: any) => call[0].startsWith('INSERT INTO splits')
      );
      expect(insertSplitCalls).toHaveLength(3);

      // User A (10) nhận 3334 VNĐ
      expect(insertSplitCalls[0][1]).toEqual([55, 10, 1/3, 3334]);
      // User B (11) nhận 3333 VNĐ
      expect(insertSplitCalls[1][1]).toEqual([55, 11, 1/3, 3333]);
      // User C (12) nhận 3333 VNĐ
      expect(insertSplitCalls[2][1]).toEqual([55, 12, 1/3, 3333]);

      // Xác minh đã trừ số dư quỹ chung
      expect(mockDb.runAsync).toHaveBeenCalledWith(
        'UPDATE funds SET balance = balance - ? WHERE group_id = ?;',
        [totalAmount, 123]
      );
    });

    it('nên xử lý chính xác phép phân chia khi có thành viên âm tiền (Overdraft) tham gia hóa đơn', async () => {
      mockDb.getFirstAsync.mockResolvedValueOnce({ group_id: 123 });

      // Giả lập 2 thành viên được chọn tham gia gánh hóa đơn
      // Tổng số dư được chọn = 30k + (-10k) = 20k
      // Tỷ lệ đóng góp gánh:
      // User A (10): 30k / 20k = 1.5
      // User B (11): -10k / 20k = -0.5
      mockDb.getAllAsync.mockResolvedValueOnce([
        {
          userId: 10,
          displayName: 'User A',
          avatarColor: '#1',
          totalContributed: 30000,
          totalSpent: 0,
        },
        {
          userId: 11,
          displayName: 'User B',
          avatarColor: '#2',
          totalContributed: 0,
          totalSpent: 10000, // chi tiêu nhiều hơn nạp
        },
      ]);

      mockDb.runAsync.mockResolvedValueOnce({ lastInsertRowId: 100 }); // INSERT expense
      mockDb.runAsync.mockResolvedValue({ lastInsertRowId: 1 });

      const tripId = 9;
      const totalAmount = 10001; // Tổng hóa đơn 10001 VNĐ
      const selectedMemberIds = [10, 11];

      await createExpenseWithSplits(
        tripId,
        10,
        totalAmount,
        'Test Overdraft Split',
        '',
        selectedMemberIds
      );

      // Số tiền chia thô:
      // User A (10): 10001 * 1.5 = 15001.5 VNĐ
      // User B (11): 10001 * -0.5 = -5000.5 VNĐ
      // Số tiền làm tròn sàn (Math.floor):
      // User A (10): 15001 VNĐ (Phần dư fraction = 0.5)
      // User B (11): -5001 VNĐ (Phần dư fraction = -5000.5 - (-5001) = 0.5)
      // Tổng sàn = 15001 + (-5001) = 10000 VNĐ.
      // Phần dư làm tròn còn lại = 10001 - 10000 = 1 VNĐ.
      // Sắp xếp theo fraction giảm dần, cả 2 cùng bằng 0.5. Theo userId tăng dần: User 10 ưu tiên trước.
      // Do đó, User 10 được cộng 1 VNĐ: 15001 + 1 = 15002 VNĐ.
      // User 11 nhận -5001 VNĐ.
      // Tổng số tiền thực chia: 15002 + (-5001) = 10001 VNĐ (Khớp hoàn toàn!)

      const insertSplitCalls = mockDb.runAsync.mock.calls.filter(
        (call: any) => call[0].startsWith('INSERT INTO splits')
      );
      expect(insertSplitCalls).toHaveLength(2);

      // User A (10)
      expect(insertSplitCalls[0][1]).toEqual([100, 10, 1.5, 15002]);
      // User B (11)
      expect(insertSplitCalls[1][1]).toEqual([100, 11, -0.5, -5001]);
    });
  });

  describe('splitCalculator.simplifyDebts tests', () => {
    it('nên tính toán chính xác số tiền cần trả nợ tối ưu để cân bằng quỹ trong nhóm', () => {
      // Giả lập trạng thái số dư thực tế của 3 thành viên:
      // User A nợ 10,000 VNĐ
      // User B nợ 20,000 VNĐ
      // User C được nhận lại 30,000 VNĐ
      const members: MemberState[] = [
        {
          userId: 1,
          displayName: 'User A',
          avatarColor: '',
          totalContributed: 0,
          totalSpent: 10000,
          balance: -10000,
          ratio: 0,
        },
        {
          userId: 2,
          displayName: 'User B',
          avatarColor: '',
          totalContributed: 0,
          totalSpent: 20000,
          balance: -20000,
          ratio: 0,
        },
        {
          userId: 3,
          displayName: 'User C',
          avatarColor: '',
          totalContributed: 30000,
          totalSpent: 0,
          balance: 30000,
          ratio: 0,
        },
      ];

      const transactions = splitCalculator.simplifyDebts(members);

      // Kết quả tối ưu nhất:
      // User B (nợ 20k) trả trực tiếp 20k cho User C (chủ nợ 30k)
      // User A (nợ 10k) trả trực tiếp 10k cho User C (chủ nợ 10k còn lại)
      expect(transactions).toHaveLength(2);

      // Sắp xếp giao dịch để so sánh chính xác vì giải thuật lấy tham lam (người nợ nhiều nhất trước)
      // B nợ 20k (nhiều hơn A nợ 10k) -> Giao dịch của B sẽ được thực hiện trước
      expect(transactions[0]).toEqual({
        fromUserId: 2,
        fromDisplayName: 'User B',
        toUserId: 3,
        toDisplayName: 'User C',
        amount: 20000,
      });

      expect(transactions[1]).toEqual({
        fromUserId: 1,
        fromDisplayName: 'User A',
        toUserId: 3,
        toDisplayName: 'User C',
        amount: 10000,
      });
    });

    it('nên giải quyết tinh giản nợ chính xác khi có nhiều chủ nợ và con nợ', () => {
      // Thành viên:
      // User A nợ 15,000 VNĐ (balance = -15000)
      // User B nợ 5,000 VNĐ (balance = -5000)
      // User C dư dôi 12,000 VNĐ (balance = 12000)
      // User D dư dôi 8,000 VNĐ (balance = 8000)
      // Tổng nợ = 20k, Tổng dư dôi = 20k.
      const members: MemberState[] = [
        { userId: 1, displayName: 'User A', avatarColor: '', totalContributed: 0, totalSpent: 15000, balance: -15000, ratio: 0 },
        { userId: 2, displayName: 'User B', avatarColor: '', totalContributed: 0, totalSpent: 5000, balance: -5000, ratio: 0 },
        { userId: 3, displayName: 'User C', avatarColor: '', totalContributed: 12000, totalSpent: 0, balance: 12000, ratio: 0 },
        { userId: 4, displayName: 'User D', avatarColor: '', totalContributed: 8000, totalSpent: 0, balance: 8000, ratio: 0 },
      ];

      const transactions = splitCalculator.simplifyDebts(members);

      // Lượt 1: Con nợ lớn nhất A (15k), Chủ nợ lớn nhất C (12k).
      // A trả 12k cho C. C đã cấn trừ hết (0). A còn nợ 3k.
      // Lượt 2: Con nợ lớn nhất tiếp theo là B (5k) (lớn hơn A còn nợ 3k). Chủ nợ lớn nhất là D (8k).
      // B trả 5k cho D. B đã cấn trừ hết. D còn dư dôi 3k.
      // Lượt 3: Con nợ A (3k), Chủ nợ D (3k).
      // A trả 3k cho D. Hoàn tất!

      expect(transactions).toHaveLength(3);

      expect(transactions[0]).toEqual({
        fromUserId: 1,
        fromDisplayName: 'User A',
        toUserId: 3,
        toDisplayName: 'User C',
        amount: 12000,
      });

      expect(transactions[1]).toEqual({
        fromUserId: 2,
        fromDisplayName: 'User B',
        toUserId: 4,
        toDisplayName: 'User D',
        amount: 5000,
      });

      expect(transactions[2]).toEqual({
        fromUserId: 1,
        fromDisplayName: 'User A',
        toUserId: 4,
        toDisplayName: 'User D',
        amount: 3000,
      });
    });

    it('nên trả về mảng rỗng khi tất cả thành viên đều có số dư bằng 0', () => {
      const members: MemberState[] = [
        { userId: 1, displayName: 'User A', avatarColor: '', totalContributed: 100, totalSpent: 100, balance: 0, ratio: 0 },
        { userId: 2, displayName: 'User B', avatarColor: '', totalContributed: 200, totalSpent: 200, balance: 0, ratio: 0 },
      ];

      const transactions = splitCalculator.simplifyDebts(members);
      expect(transactions).toHaveLength(0);
    });
  });
});
