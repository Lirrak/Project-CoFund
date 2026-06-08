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
  splits: Array<{
    displayName: string;
    ratio: number;
    calculatedAmount: number;
  }>;
}

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
        `SELECT e.id, e.total_amount, e.description, e.created_at, p.display_name as paidByName
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
        '', // bỏ trống ảnh hóa đơn
        splitsInput,
        splitType
      );

      if (expenseId) {
        Alert.alert('Thành công', 'Đã ghi nhận chi tiêu và tự động hạch toán số dư ròng thành công!');
        setAmount('');
        setDescription('');
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
                  <Text style={styles.expenseDate}>{exp.created_at}</Text>
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
