import { LocalDB } from '../services/sqlite';

// --- TypeScript Interfaces ---

export interface MemberState {
  userId: number;
  displayName: string;
  avatarColor: string;
  totalContributed: number;
  totalSpent: number;
  balance: number;
  ratio: number;
}

export interface DebtTransaction {
  fromUserId: number;
  fromDisplayName: string;
  toUserId: number;
  toDisplayName: string;
  amount: number;
}

/**
 * 1. Hàm tính toán số dư thực tế và tỷ lệ đóng góp của từng thành viên trong một nhóm.
 * Đọc từ SQLite, cấn trừ tiền đóng góp và các hóa đơn đã gánh, giải quyết các edge cases.
 * 
 * @param groupId ID của nhóm cần tính toán
 */
export async function calculateMemberActualBalances(groupId: number): Promise<MemberState[]> {
  const db = LocalDB.getInstance();
  
  const query = `
    SELECT 
      p.id AS userId,
      p.display_name AS displayName,
      p.avatar_color AS avatarColor,
      COALESCE(
        (SELECT SUM(c.amount) 
         FROM contributions c 
         JOIN funds f ON c.fund_id = f.id 
         WHERE c.user_id = p.id AND f.group_id = ?), 
        0.0
      ) AS totalContributed,
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

  const rows = await db.getAllAsync<any>(query, [groupId, groupId, groupId]);

  const memberStates: MemberState[] = rows.map(row => {
    const totalContributed = Number(row.totalContributed || 0);
    const totalSpent = Number(row.totalSpent || 0);
    const balance = totalContributed - totalSpent;
    return {
      userId: Number(row.userId),
      displayName: String(row.displayName),
      avatarColor: String(row.avatarColor),
      totalContributed,
      totalSpent,
      balance,
      ratio: 0, // Sẽ tính toán ở dưới
    };
  });

  const totalFundBalance = memberStates.reduce((sum, m) => sum + m.balance, 0);

  memberStates.forEach(m => {
    if (totalFundBalance === 0) {
      m.ratio = memberStates.length > 0 ? 1 / memberStates.length : 0;
    } else {
      m.ratio = m.balance / totalFundBalance;
    }
  });

  return memberStates;
}

/**
 * 2. Hàm ghi nhận chi tiêu và tự động phân chia hóa đơn theo tỷ lệ đóng góp thực tế.
 * Hàm này chạy trong một SQLite Transaction duy nhất để bảo đảm tính nhất quán dữ liệu.
 * Thực hiện làm tròn tiền lẻ theo đơn vị VNĐ sử dụng giải thuật Largest Remainder Method.
 * 
 * @param tripId ID của chuyến đi thuộc nhóm
 * @param paidByUserId ID người trả tiền (người nạp quỹ/thanh toán hóa đơn)
 * @param totalAmount Tổng số tiền của hóa đơn (VNĐ)
 * @param description Mô tả hóa đơn
 * @param billImageUri Đường dẫn ảnh hóa đơn
 * @param selectedMemberIds Danh sách ID các thành viên gánh hóa đơn này
 */
export async function createExpenseWithSplits(
  tripId: number,
  paidByUserId: number,
  totalAmount: number,
  description: string,
  billImageUri: string,
  selectedMemberIds: number[]
): Promise<number | null> {
  const db = LocalDB.getInstance();
  let expenseId: number | null = null;

  try {
    // 1. Lấy thông tin group_id từ tripId
    const trip = await db.getFirstAsync<{ group_id: number }>(
      'SELECT group_id FROM trips WHERE id = ?;',
      [tripId]
    );
    if (!trip) {
      throw new Error(`Trip with ID ${tripId} not found`);
    }
    const groupId = trip.group_id;

    // 2. Chạy toàn bộ tiến trình trong một Transaction duy nhất
    await db.withTransactionAsync(async () => {
      // 2a. Tính toán số dư thực tế của tất cả thành viên trong nhóm trước khi chi
      const memberStates = await calculateMemberActualBalances(groupId);

      // Lọc ra danh sách thành viên được chọn gánh hóa đơn này
      const selectedMembers = memberStates.filter(m =>
        selectedMemberIds.includes(m.userId)
      );

      if (selectedMembers.length === 0) {
        throw new Error('No valid selected members found for splitting');
      }

      // Tổng số dư thực tế của riêng các thành viên được chọn gánh hóa đơn
      const sumSelectedBalances = selectedMembers.reduce(
        (sum, m) => sum + m.balance,
        0
      );

      // Tính tỷ lệ và số tiền phân chia nháp
      const rawSplits = selectedMembers.map(m => {
        let ratio = 0;
        if (sumSelectedBalances === 0) {
          ratio = 1 / selectedMembers.length;
        } else {
          ratio = m.balance / sumSelectedBalances;
        }
        return {
          userId: m.userId,
          ratio,
          rawAmount: totalAmount * ratio,
        };
      });

      // Áp dụng giải thuật Largest Remainder Method để làm tròn VNĐ chính xác 100%
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

      // Sắp xếp các chỉ số theo phần thập phân giảm dần (nếu bằng nhau thì ưu tiên userId tăng dần)
      const sortedIndices = splitsWithAmounts
        .map((item, index) => ({ index, fraction: item.fraction, userId: item.userId }))
        .sort((a, b) => {
          if (Math.abs(b.fraction - a.fraction) > 1e-9) {
            return b.fraction - a.fraction;
          }
          return a.userId - b.userId;
        });

      // Phân bổ phần dư làm tròn (mỗi người 1 VNĐ) cho đến hết remainder
      for (let i = 0; i < remainder; i++) {
        const idx = sortedIndices[i].index;
        splitsWithAmounts[idx].calculatedAmount += 1;
      }

      // 2b. Chèn bản ghi hóa đơn mới vào bảng expenses
      const expenseResult = await db.runAsync(
        'INSERT INTO expenses (trip_id, paid_by, total_amount, description, bill_image_uri) VALUES (?, ?, ?, ?, ?);',
        [tripId, paidByUserId, totalAmount, description, billImageUri]
      );
      expenseId = expenseResult.lastInsertRowId;

      if (!expenseId) {
        throw new Error('Failed to insert expense into SQLite');
      }

      // 2c. Chèn phân chia chi tiết của từng thành viên gánh hóa đơn vào bảng splits
      for (const split of splitsWithAmounts) {
        await db.runAsync(
          'INSERT INTO splits (expense_id, user_id, ratio, calculated_amount) VALUES (?, ?, ?, ?);',
          [expenseId, split.userId, split.ratio, split.calculatedAmount]
        );
      }

      // 2d. Khấu trừ số dư của quỹ chung của nhóm
      await db.runAsync(
        'UPDATE funds SET balance = balance - ? WHERE group_id = ?;',
        [totalAmount, groupId]
      );
    });

    return expenseId;
  } catch (error) {
    console.error('Error executing createExpenseWithSplits transaction:', error);
    throw error;
  }
}

/**
 * 3. Tinh giản nợ tinh tế (Debt Simplification Algorithm - tương tự Splitwise)
 * Dựa trên số dư thực tế cuối cùng để giảm thiểu tối đa số giao dịch thanh toán trực tiếp giữa các thành viên.
 */
export const splitCalculator = {
  /**
   * Tính toán xem ai cần chuyển bao nhiêu tiền cho ai để đưa tất cả số dư về 0 (cân bằng quỹ).
   * 
   * @param members Danh sách MemberState có số dư thực tế của từng người
   * @returns Danh sách các giao dịch trả nợ tối ưu DebtTransaction[]
   */
  simplifyDebts(members: MemberState[]): DebtTransaction[] {
    // Phân tách thành hai nhóm riêng biệt: Người nợ (balance < 0) và Chủ nợ (balance > 0)
    // Áp dụng sai số 0.1 để tránh vấn đề sai số dấu phẩy động
    const debtors = members
      .filter(m => m.balance < -0.1)
      .map(m => ({
        userId: m.userId,
        displayName: m.displayName,
        debt: -m.balance,
      }));

    const creditors = members
      .filter(m => m.balance > 0.1)
      .map(m => ({
        userId: m.userId,
        displayName: m.displayName,
        credit: m.balance,
      }));

    const transactions: DebtTransaction[] = [];

    // Giải thuật tham lam (Greedy Algorithm): Cấn trừ người nợ nhiều nhất với chủ nợ nhiều nhất
    while (debtors.length > 0 && creditors.length > 0) {
      // Luôn giữ cho các danh sách được sắp xếp giảm dần theo số tiền nợ/có
      debtors.sort((a, b) => b.debt - a.debt);
      creditors.sort((a, b) => b.credit - a.credit);

      const debtor = debtors[0];
      const creditor = creditors[0];

      // Số tiền giao dịch tối đa có thể cấn trừ giữa hai người này
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

      // Loại bỏ các thành viên đã cấn trừ hoàn tất
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
