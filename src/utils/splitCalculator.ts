import { LocalDB } from '../services/sqlite';

// --- TypeScript Interfaces ---

export interface MemberState {
  userId: number;
  displayName: string;
  totalContributed: number;
  totalPaidOutOfPocket: number;
  totalSpent: number; // Represents total splits they bear
  netBalance: number; // Net Balance = (Tổng nạp quỹ) + (Tổng tự ứng) - (Tổng tiền gánh splits)
}

export interface DebtTransaction {
  fromUserId: number;
  fromDisplayName: string;
  toUserId: number;
  toDisplayName: string;
  amount: number;
}

export type SplitType = 'EQUAL' | 'PERCENT';

export interface SplitInput {
  userId: number;
  percent?: number; // Được sử dụng khi chọn phương thức PERCENT
}

/**
 * 1. Hàm tính toán số dư ròng (Net Balance) thực tế của tất cả thành viên trong nhóm.
 * Công thức vàng: Net Balance = (Tổng nạp quỹ) + (Tổng tự ứng) - (Tổng tiền gánh splits).
 * Sử dụng SQL Subqueries tối ưu hóa để lấy dữ liệu tức thì không bị trùng lặp tổng.
 * 
 * @param groupId ID của nhóm cần tính toán
 */
export async function calculateMemberNetBalances(groupId: number): Promise<MemberState[]> {
  const db = LocalDB.getInstance();

  const query = `
    SELECT 
      p.id AS userId,
      p.display_name AS displayName,
      COALESCE(
        (SELECT SUM(c.amount) 
         FROM contributions c 
         JOIN funds f ON c.fund_id = f.id 
         WHERE c.user_id = p.id AND f.group_id = ?), 
        0.0
      ) AS totalContributed,
      COALESCE(
        (SELECT SUM(e.total_amount) 
         FROM expenses e 
         JOIN trips t ON e.trip_id = t.id 
         WHERE e.paid_by = p.id AND t.group_id = ?), 
        0.0
      ) AS totalPaidOutOfPocket,
      COALESCE(
        (SELECT SUM(s.calculated_amount) 
         FROM splits s 
         JOIN expenses e ON s.expense_id = e.id 
         JOIN trips t ON e.trip_id = t.id 
         WHERE s.user_id = p.id AND t.group_id = ?), 
        0.0
      ) AS totalSpent
    FROM profiles p
    JOIN group_members gm ON p.id = gm.user_id
    WHERE gm.group_id = ?
    ORDER BY p.id ASC;
  `;

  const rows = await db.getAllAsync<any>(query, [groupId, groupId, groupId, groupId]);

  return rows.map(row => {
    const totalContributed = Number(row.totalContributed || 0);
    const totalPaidOutOfPocket = Number(row.totalPaidOutOfPocket || 0);
    const totalSpent = Number(row.totalSpent || 0);
    const netBalance = totalContributed + totalPaidOutOfPocket - totalSpent;

    return {
      userId: Number(row.userId),
      displayName: String(row.displayName),
      totalContributed,
      totalPaidOutOfPocket,
      totalSpent,
      netBalance,
    };
  });
}

/**
 * 2. Hàm ghi nhận chi tiêu và phân chia hóa đơn linh hoạt (Chia đều EQUAL hoặc Chia theo PERCENT).
 * Chạy trong một SQLite Transaction duy nhất để bảo đảm tính toàn vẹn dữ liệu.
 * Áp dụng giải thuật Largest Remainder Method làm tròn VNĐ chính xác 100%, không lệch xu nào.
 * 
 * @param tripId ID của chuyến đi thuộc nhóm
 * @param paidByUserId ID người tự ứng tiền túi, hoặc NULL nếu chi trực tiếp bằng quỹ chung
 * @param totalAmount Tổng số tiền của hóa đơn (VNĐ)
 * @param description Mô tả hóa đơn
 * @param billImageUri Đường dẫn ảnh hóa đơn
 * @param splitsInput Danh sách thành viên tham gia gánh hóa đơn kèm cấu hình % (nếu có)
 * @param splitType Phương thức phân chia: 'EQUAL' hoặc 'PERCENT'
 */
export async function createExpenseWithSplits(
  tripId: number,
  paidByUserId: number | null, // null = Chi bằng Quỹ chung
  totalAmount: number,
  description: string,
  billImageUri: string,
  splitsInput: SplitInput[],
  splitType: SplitType
): Promise<number | null> {
  const db = LocalDB.getInstance();
  let expenseId: number | null = null;

  try {
    // Lấy thông tin group_id từ tripId
    const trip = await db.getFirstAsync<{ group_id: number }>(
      'SELECT group_id FROM trips WHERE id = ?;',
      [tripId]
    );
    if (!trip) {
      throw new Error(`Trip with ID ${tripId} not found`);
    }
    const groupId = trip.group_id;

    // Chạy toàn bộ luồng hạch toán trong một SQLite transaction duy nhất
    await db.withTransactionAsync(async () => {
      // Tính tỷ lệ (ratio) nháp cho từng thành viên tham gia
      const rawSplits = splitsInput.map(input => {
        let ratio = 0;
        if (splitType === 'EQUAL') {
          ratio = 1 / splitsInput.length;
        } else if (splitType === 'PERCENT') {
          ratio = (input.percent || 0) / 100;
        }
        return {
          userId: input.userId,
          ratio,
          rawAmount: totalAmount * ratio,
        };
      });

      // Áp dụng giải thuật Largest Remainder Method để làm tròn theo đơn vị VNĐ và khớp 100% totalAmount
      const splitsWithAmounts = rawSplits.map(item => {
        const floorAmount = Math.floor(item.rawAmount);
        const fraction = item.rawAmount - floorAmount;
        return {
          ...item,
          floorAmount,
          fraction,
          calculatedAmount: floorAmount, // Sẽ được cộng thêm phần dư làm tròn sau
        };
      });

      const sumFloors = splitsWithAmounts.reduce((sum, item) => sum + item.floorAmount, 0);
      const remainder = totalAmount - sumFloors;

      // Sắp xếp các chỉ số theo phần thập phân giảm dần (ưu tiên phụ là userId tăng dần)
      const sortedIndices = splitsWithAmounts
        .map((item, index) => ({ index, fraction: item.fraction, userId: item.userId }))
        .sort((a, b) => {
          if (Math.abs(b.fraction - a.fraction) > 1e-9) {
            return b.fraction - a.fraction;
          }
          return a.userId - b.userId;
        });

      // Phân bổ phần dư làm tròn VNĐ
      for (let i = 0; i < remainder; i++) {
        const idx = sortedIndices[i].index;
        splitsWithAmounts[idx].calculatedAmount += 1;
      }

      // Ghi nhận hóa đơn mới vào bảng expenses
      const expenseResult = await db.runAsync(
        'INSERT INTO expenses (trip_id, paid_by, total_amount, description, bill_image_uri) VALUES (?, ?, ?, ?, ?);',
        [tripId, paidByUserId, totalAmount, description, billImageUri]
      );
      expenseId = expenseResult.lastInsertRowId;

      if (!expenseId) {
        throw new Error('Failed to insert expense into SQLite');
      }

      // Ghi nhận chi tiết phân chia gánh hóa đơn vào bảng splits
      for (const split of splitsWithAmounts) {
        await db.runAsync(
          'INSERT INTO splits (expense_id, user_id, ratio, calculated_amount) VALUES (?, ?, ?, ?);',
          [expenseId, split.userId, split.ratio, split.calculatedAmount]
        );
      }

      // Nếu chi bằng Quỹ chung (Paid by Fund) -> Khấu trừ trực tiếp số dư của quỹ nhóm
      if (paidByUserId === null) {
        await db.runAsync(
          'UPDATE funds SET balance = balance - ? WHERE group_id = ?;',
          [totalAmount, groupId]
        );
      }
      // Nếu thành viên tự ứng (Paid out-of-pocket) -> KHÔNG trừ quỹ chung, xem như khoản đóng đóng góp gián tiếp.
    });

    return expenseId;
  } catch (error) {
    console.error('Error executing createExpenseWithSplits in transaction:', error);
    throw error;
  }
}

/**
 * 3. Thuật toán tinh giản nợ thông minh (Debt Simplification Algorithm - Splitwise style)
 * Dựa trên Số dư ròng (Net Balance) cuối cùng của các thành viên để tính toán các giao dịch chuyển tiền trực tiếp tối giản.
 */
export const splitCalculator = {
  /**
   * Tính toán xem ai cần trả bao nhiêu tiền cho ai để cân bằng quỹ về 0 hoàn hảo.
   * 
   * @param members Danh sách thành viên kèm Net Balance của họ
   * @returns Danh sách các giao dịch trả nợ tối ưu DebtTransaction[]
   */
  simplifyDebts(members: { userId: number; displayName: string; netBalance: number }[]): DebtTransaction[] {
    const debtors = members
      .filter(m => m.netBalance < -0.1)
      .map(m => ({
        userId: m.userId,
        displayName: m.displayName,
        debt: -m.netBalance,
      }));

    const creditors = members
      .filter(m => m.netBalance > 0.1)
      .map(m => ({
        userId: m.userId,
        displayName: m.displayName,
        credit: m.netBalance,
      }));

    const transactions: DebtTransaction[] = [];

    // Giải thuật tham lam (Greedy) cấn trừ nợ giữa debtor lớn nhất và creditor lớn nhất
    while (debtors.length > 0 && creditors.length > 0) {
      debtors.sort((a, b) => b.debt - a.debt);
      creditors.sort((a, b) => b.credit - a.credit);

      const debtor = debtors[0];
      const creditor = creditors[0];

      const amount = Math.min(debtor.debt, creditor.credit);
      const roundedAmount = Math.round(amount);

      if (roundedAmount > 0) {
        transactions.push({
          fromUserId: debtor.userId,
          fromDisplayName: debtor.displayName,
          toUserId: creditor.userId,
          toDisplayName: creditor.displayName,
          amount: roundedAmount,
        });
      }

      debtor.debt -= amount;
      creditor.credit -= amount;

      if (debtor.debt < 0.1) {
        debtors.shift();
      }
      if (creditor.credit < 0.1) {
        creditors.shift();
      }
    }

    return transactions;
  }
};
