import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  StatusBar,
} from 'react-native';
import {
  LocalDB,
  LocalGroup,
  LocalGroupMember,
  LocalContribution,
  LocalFund,
  LocalTrip,
} from '../services/sqlite';

// Mảng màu pastel có sẵn để gán ngẫu nhiên cho thành viên mới
const PASTEL_COLORS = [
  '#FFD1DC', // Pastel Pink
  '#FFDFD3', // Pastel Peach
  '#E2F0CB', // Pastel Lime Green
  '#B5EAD7', // Pastel Mint Green
  '#C7CEEA', // Pastel Lavender
  '#FFB7B2', // Pastel Coral
  '#F3E5AB', // Vanilla
  '#D0E1FD', // Pastel Blue
];

interface UnifiedTransaction {
  id: string; // unique string e.g. "contrib_[id]" or "expense_[id]"
  type: 'contribution' | 'expense';
  amount: number;
  description: string;
  createdAt: string;
  displayName: string;
  avatarColor: string;
  subtext?: string; // e.g. "Chuyến đi: Nha Trang"
  originalItem: any; // to support deleting contribution if clicked
}

interface GroupDetailsScreenProps {
  groupId?: number;
  route?: {
    params: {
      groupId: number;
    };
  };
  onGoBack: () => void;
  onNavigateToTripExpenses: (tripId: number, tripName: string, groupId: number) => void;
  navigationKey?: number;
}

export function GroupDetailsScreen({
  groupId: directGroupId,
  route,
  onGoBack,
  onNavigateToTripExpenses,
  navigationKey,
}: GroupDetailsScreenProps) {
  // Lấy groupId từ prop hoặc route params
  const groupId = directGroupId ?? route?.params?.groupId;

  if (!groupId) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.errorText}>Không tìm thấy thông tin nhóm!</Text>
        <TouchableOpacity style={styles.backButton} onPress={onGoBack}>
          <Text style={styles.backButtonText}>Quay lại</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const [group, setGroup] = useState<LocalGroup | null>(null);
  const [fund, setFund] = useState<LocalFund | null>(null);
  const [members, setMembers] = useState<LocalGroupMember[]>([]);
  const [contributions, setContributions] = useState<LocalContribution[]>([]);
  const [trips, setTrips] = useState<LocalTrip[]>([]);
  const [transactions, setTransactions] = useState<UnifiedTransaction[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Trạng thái modal Thêm thành viên
  const [memberModalVisible, setMemberModalVisible] = useState<boolean>(false);
  const [newMemberName, setNewMemberName] = useState<string>('');
  const [isAddingMember, setIsAddingMember] = useState<boolean>(false);

  // Trạng thái modal Nạp tiền
  const [contribModalVisible, setContribModalVisible] = useState<boolean>(false);
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);
  const [contribAmount, setContribAmount] = useState<string>('');
  const [isAddingContrib, setIsAddingContrib] = useState<boolean>(false);

  // Trạng thái modal Thêm chuyến đi mới
  const [tripModalVisible, setTripModalVisible] = useState<boolean>(false);
  const [newTripName, setNewTripName] = useState<string>('');
  const [isCreatingTrip, setIsCreatingTrip] = useState<boolean>(false);

  // Tải toàn bộ dữ liệu của nhóm từ SQLite
  const loadAllData = async () => {
    try {
      const db = LocalDB.getInstance();

      // 1. Tải thông tin nhóm
      const groupData = await db.getGroupById(groupId);
      setGroup(groupData);

      // 2. Tải thông tin quỹ chung của nhóm
      const fundData = await db.getFundByGroupId(groupId);
      setFund(fundData);

      // 3. Tải danh sách thành viên thực tế
      const memberList = await db.getGroupMembers(groupId);
      setMembers(memberList);

      // 4. Tải lịch sử đóng quỹ và chi tiêu để ghép thành Lịch sử giao dịch dòng tiền
      let contribList: LocalContribution[] = [];
      if (fundData) {
        contribList = await db.getContributions(fundData.id);
        setContributions(contribList);
      }

      // Tải danh sách hóa đơn chi tiêu của tất cả chuyến đi thuộc nhóm này
      const expenseRows = await db.getAllAsync<any>(
        `SELECT 
          e.id, 
          e.total_amount, 
          e.description, 
          e.created_at, 
          t.name as tripName,
          p.display_name as paidByName,
          p.avatar_color as paidByAvatarColor
         FROM expenses e
         JOIN trips t ON e.trip_id = t.id
         LEFT JOIN profiles p ON e.paid_by = p.id
         WHERE t.group_id = ?;`,
        [groupId]
      );

      const merged: UnifiedTransaction[] = [];

      // Ghép Đóng quỹ (Contributions)
      contribList.forEach(c => {
        merged.push({
          id: `contrib_${c.id}`,
          type: 'contribution',
          amount: c.amount,
          description: 'Nạp tiền vào quỹ chung',
          createdAt: c.created_at,
          displayName: c.display_name || 'Thành viên',
          avatarColor: c.avatar_color || '#3B82F6',
          originalItem: c,
        });
      });

      // Ghép Chi tiêu (Expenses)
      expenseRows.forEach(e => {
        merged.push({
          id: `expense_${e.id}`,
          type: 'expense',
          amount: e.total_amount,
          description: e.description || 'Chi tiêu không tên',
          createdAt: e.created_at,
          displayName: e.paidByName || '🏦 Quỹ chung',
          avatarColor: e.paidByAvatarColor || '#10B981',
          subtext: `Chuyến đi: ${e.tripName}`,
          originalItem: e,
        });
      });

      // Sắp xếp theo ngày giảm dần (Mới nhất lên đầu)
      merged.sort((a, b) => {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      setTransactions(merged);

      // 5. Tải danh sách chuyến đi thực tế từ bảng trips
      const tripList = await db.getTripsByGroupId(groupId);
      setTrips(tripList);
    } catch (error) {
      console.error('Lỗi khi tải thông tin chi tiết nhóm:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAllData();
  }, [groupId, navigationKey]);

  // Thêm thành viên mới
  const handleAddMember = async () => {
    if (!newMemberName.trim()) return;
    setIsAddingMember(true);
    try {
      const db = LocalDB.getInstance();
      const randomColor = PASTEL_COLORS[Math.floor(Math.random() * PASTEL_COLORS.length)];

      const newProfileId = await db.addMemberToGroup(groupId, newMemberName.trim(), randomColor);
      if (newProfileId) {
        setNewMemberName('');
        setMemberModalVisible(false);
        await loadAllData();
      }
    } catch (error) {
      console.error('Lỗi khi thêm thành viên:', error);
    } finally {
      setIsAddingMember(false);
    }
  };

  // Nạp tiền vào quỹ
  const handleAddContribution = async () => {
    if (!fund || !selectedMemberId || !contribAmount) return;
    const amount = parseFloat(contribAmount.replace(/[^0-9]/g, ''));
    if (isNaN(amount) || amount <= 0) return;

    setIsAddingContrib(true);
    try {
      const db = LocalDB.getInstance();
      const successId = await db.addContribution(fund.id, selectedMemberId, amount);
      if (successId) {
        setContribAmount('');
        setSelectedMemberId(null);
        setContribModalVisible(false);
        await loadAllData();
      }
    } catch (error) {
      console.error('Lỗi khi đóng góp quỹ:', error);
    } finally {
      setIsAddingContrib(false);
    }
  };

  // Tạo chuyến đi mới
  const handleCreateTrip = async () => {
    if (!newTripName.trim()) return;
    setIsCreatingTrip(true);
    try {
      const db = LocalDB.getInstance();
      const newTripId = await db.createTrip(groupId, newTripName.trim());
      if (newTripId) {
        setNewTripName('');
        setTripModalVisible(false);
        await loadAllData();
      }
    } catch (error) {
      console.error('Lỗi khi tạo chuyến đi mới:', error);
    } finally {
      setIsCreatingTrip(false);
    }
  };

  // Xóa thành viên khỏi nhóm (Nhấn giữ avatar)
  const handleDeleteMember = (member: LocalGroupMember) => {
    Alert.alert(
      'Xóa thành viên khỏi nhóm',
      `Bạn có chắc chắn muốn xóa "${member.display_name}" khỏi nhóm này không? Lượt đóng góp cũ sẽ không bị xóa nhưng họ sẽ không còn trong danh sách thành viên hiện tại.`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa',
          style: 'destructive',
          onPress: async () => {
            try {
              const db = LocalDB.getInstance();
              const success = await db.deleteMemberFromGroup(groupId, member.id);
              if (success) {
                await loadAllData();
              } else {
                Alert.alert('Lỗi', 'Không thể xóa thành viên này.');
              }
            } catch (error) {
              console.error('Lỗi khi xóa thành viên:', error);
            }
          },
        },
      ]
    );
  };

  // Xóa đóng góp quỹ (Nhấn icon X/Thùng rác)
  const handleDeleteContribution = (item: LocalContribution) => {
    if (!fund) return;
    Alert.alert(
      'Xóa lượt nạp quỹ',
      `Bạn có chắc chắn muốn xóa lượt nạp quỹ trị giá ${formatCurrency(item.amount)} của "${item.display_name}" không? Số dư của quỹ nhóm sẽ tự động được TRỪ đi tương ứng.`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa',
          style: 'destructive',
          onPress: async () => {
            try {
              const db = LocalDB.getInstance();
              const success = await db.deleteContribution(item.id, fund.id, item.amount);
              if (success) {
                await loadAllData();
              } else {
                Alert.alert('Lỗi', 'Không thể xóa lượt đóng quỹ này.');
              }
            } catch (error) {
              console.error('Lỗi khi xóa đóng góp:', error);
            }
          },
        },
      ]
    );
  };

  // Xóa toàn bộ nhóm
  const handleDeleteGroup = () => {
    Alert.alert(
      'CẢNH BÁO: XÓA NHÓM',
      `Bạn có thực sự chắc chắn muốn XÓA VĨNH VIỄN nhóm "${group?.name}"? Hành động này sẽ xóa sạch tất cả thành viên, lịch sử nạp quỹ, chuyến đi và các hóa đơn chi tiêu liên quan. Không thể phục hồi dữ liệu sau khi xóa!`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'XÓA NHÓM',
          style: 'destructive',
          onPress: async () => {
            try {
              const db = LocalDB.getInstance();
              const success = await db.deleteGroup(groupId);
              if (success) {
                onGoBack();
              } else {
                Alert.alert('Lỗi', 'Không thể xóa nhóm này.');
              }
            } catch (error) {
              console.error('Lỗi khi xóa nhóm:', error);
            }
          },
        },
      ]
    );
  };

  // Xóa chuyến đi
  const handleDeleteTrip = (tripId: number, tripName: string) => {
    Alert.alert(
      'Xóa chuyến đi',
      `Bạn có chắc chắn muốn xóa chuyến đi "${tripName}"? Hành động này sẽ xóa vĩnh viễn toàn bộ các hóa đơn chi tiêu và hạch toán phân chia thuộc chuyến đi này.`,
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa',
          style: 'destructive',
          onPress: async () => {
            try {
              const db = LocalDB.getInstance();
              await db.runAsync('DELETE FROM trips WHERE id = ?;', [tripId]);
              Alert.alert('Thành công', `Đã xóa chuyến đi "${tripName}"`);
              await loadAllData();
            } catch (error) {
              console.error('Error deleting trip:', error);
              Alert.alert('Lỗi', 'Không thể xóa chuyến đi này.');
            }
          },
        },
      ]
    );
  };

  const formatCurrency = (amount: number) => {
    return amount.toLocaleString('vi-VN') + ' đ';
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color="#1E3A8A" />
        <Text style={styles.loadingText}>Đang tải dữ liệu nhóm...</Text>
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
        <Text style={styles.headerTitle} numberOfLines={1}>
          {group?.name || 'Chi tiết nhóm'}
        </Text>
        <TouchableOpacity style={styles.deleteGroupBtn} onPress={handleDeleteGroup}>
          <Text style={styles.deleteGroupBtnText}>Xóa Nhóm</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Số dư hiện tại */}
        <View style={styles.balanceCard}>
          <Text style={styles.balanceCardLabel}>Số dư quỹ của nhóm</Text>
          <Text style={styles.balanceCardValue}>
            {formatCurrency(group?.balance || 0)}
          </Text>
          <Text style={styles.balanceCardSub}>
            Quỹ: {fund?.name || 'Quỹ chung'}
          </Text>
        </View>

        {/* Nút hành động nhanh */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => setMemberModalVisible(true)}
          >
            <Text style={styles.actionBtnIcon}>👤</Text>
            <Text style={styles.actionBtnText}>Thêm thành viên</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, styles.actionBtnContrib]}
            onPress={() => {
              if (members.length === 0) {
                Alert.alert('Thông báo', 'Vui lòng thêm thành viên vào nhóm trước khi nạp quỹ!');
                return;
              }
              setContribModalVisible(true);
            }}
          >
            <Text style={styles.actionBtnIcon}>💰</Text>
            <Text style={styles.actionBtnText}>Nạp tiền quỹ</Text>
          </TouchableOpacity>
        </View>

        {/* DANH SÁCH CHUYẾN ĐI (TRIPS) */}
        <View style={styles.sectionContainer}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Chuyến đi ({trips.length})</Text>
            <TouchableOpacity
              style={styles.sectionAddBtn}
              onPress={() => setTripModalVisible(true)}
            >
              <Text style={styles.sectionAddBtnText}>+ Chuyến mới</Text>
            </TouchableOpacity>
          </View>
          {trips.length === 0 ? (
            <Text style={styles.emptyText}>Chưa có chuyến đi nào được tạo. Hãy tạo chuyến đi mới để quản lý chi tiêu nhóm nhé!</Text>
          ) : (
            trips.map((trip) => (
              <TouchableOpacity
                key={trip.id}
                style={styles.tripItemCard}
                activeOpacity={0.7}
                onPress={() => onNavigateToTripExpenses(trip.id, trip.name, groupId)}
              >
                <View style={styles.tripItemLeft}>
                  <Text style={styles.tripIcon}>🏕️</Text>
                  <View style={styles.tripDetails}>
                    <Text style={styles.tripName} numberOfLines={1}>
                      {trip.name}
                    </Text>
                    <View style={styles.activeBadgeContainer}>
                      <View style={styles.activeDot} />
                      <Text style={styles.activeText}>Đang hoạt động</Text>
                    </View>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <TouchableOpacity
                    style={styles.deleteTripBtn}
                    onPress={(e) => {
                      e.stopPropagation(); // Ngăn chặn sự kiện onPress của thẻ cha nhảy sang màn hình chi tiêu
                      handleDeleteTrip(trip.id, trip.name);
                    }}
                  >
                    <Text style={styles.deleteTripText}>🗑️</Text>
                  </TouchableOpacity>
                  <Text style={styles.arrowIcon}>→</Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* Danh sách thành viên */}
        <View style={styles.sectionContainer}>
          <Text style={styles.sectionTitle}>Thành viên ({members.length})</Text>
          <Text style={styles.memberTipText}>(Nhấn giữ avatar thành viên để xóa họ khỏi nhóm)</Text>
          {members.length === 0 ? (
            <Text style={styles.emptyText}>Chưa có thành viên nào.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.membersRow}>
              {members.map((member) => (
                <TouchableOpacity
                  key={member.id}
                  style={styles.memberAvatarContainer}
                  onLongPress={() => handleDeleteMember(member)}
                  delayLongPress={500}
                >
                  <View style={[styles.memberAvatar, { backgroundColor: member.avatar_color }]}>
                    <Text style={styles.memberAvatarText}>
                      {member.display_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.memberName} numberOfLines={1}>
                    {member.display_name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* Lịch sử Giao dịch Dòng tiền */}
        <View style={styles.sectionContainer}>
          <Text style={styles.sectionTitle}>📊 Lịch sử giao dịch nhóm (Dòng tiền)</Text>
          {transactions.length === 0 ? (
            <View style={styles.emptyHistory}>
              <Text style={styles.emptyText}>Chưa có giao dịch đóng quỹ hoặc chi tiêu nào.</Text>
            </View>
          ) : (
            transactions.map((item) => {
              const isContrib = item.type === 'contribution';
              return (
                <View key={item.id} style={styles.contribItem}>
                  <View style={[styles.contribAvatar, { backgroundColor: item.avatarColor }]}>
                    <Text style={styles.contribAvatarText}>
                      {isContrib ? item.displayName.charAt(0).toUpperCase() : '💸'}
                    </Text>
                  </View>
                  <View style={styles.contribDetails}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={styles.contribName}>{item.displayName}</Text>
                      {!isContrib && (
                        <View style={styles.expenseBadge}>
                          <Text style={styles.expenseBadgeText}>Chi tiêu</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.txDescription} numberOfLines={1}>
                      {isContrib ? item.description : `Chi: ${item.description}`}
                    </Text>
                    {item.subtext ? (
                      <Text style={styles.txSubtext}>{item.subtext}</Text>
                    ) : null}
                    <Text style={styles.contribDate}>{item.createdAt}</Text>
                  </View>
                  <View style={styles.contribAmountContainer}>
                    <Text style={[styles.contribAmount, isContrib ? styles.positiveTxAmount : styles.negativeTxAmount]}>
                      {isContrib ? '+' : '-'}{formatCurrency(item.amount)}
                    </Text>
                    {isContrib ? (
                      <TouchableOpacity
                        style={styles.deleteContribBtn}
                        onPress={() => handleDeleteContribution(item.originalItem)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Text style={styles.deleteContribText}>🗑️</Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={{ width: 24 }} />
                    )}
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* Modal Thêm Thành Viên */}
      <Modal
        visible={memberModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setMemberModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Thêm thành viên mới</Text>
            <Text style={styles.modalLabel}>Tên hiển thị:</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Nhập tên thành viên..."
              placeholderTextColor="#999"
              value={newMemberName}
              onChangeText={setNewMemberName}
              autoFocus
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton]}
                onPress={() => {
                  setNewMemberName('');
                  setMemberModalVisible(false);
                }}
              >
                <Text style={styles.modalButtonText}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.confirmButton]}
                onPress={handleAddMember}
                disabled={isAddingMember || !newMemberName.trim()}
              >
                {isAddingMember ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalButtonText}>Thêm</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Modal Nạp Tiền Quỹ */}
      <Modal
        visible={contribModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => {
          setSelectedMemberId(null);
          setContribAmount('');
          setContribModalVisible(false);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Nạp tiền vào quỹ</Text>

            {/* Chọn thành viên đóng góp */}
            <Text style={styles.modalLabel}>Thành viên đóng góp:</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.memberPickerRow}
            >
              {members.map((member) => {
                const isSelected = selectedMemberId === member.id;
                return (
                  <TouchableOpacity
                    key={member.id}
                    style={[
                      styles.pickerMemberCard,
                      isSelected && styles.pickerMemberCardSelected,
                    ]}
                    onPress={() => setSelectedMemberId(member.id)}
                  >
                    <View style={[styles.memberAvatar, { backgroundColor: member.avatar_color, width: 40, height: 40, borderRadius: 20 }]}>
                      <Text style={styles.memberAvatarText}>
                        {member.display_name.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.pickerMemberName,
                        isSelected && styles.pickerMemberNameSelected,
                      ]}
                      numberOfLines={1}
                    >
                      {member.display_name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Nhập số tiền */}
            <Text style={styles.modalLabel}>Số tiền (VNĐ):</Text>
            <TextInput
              style={styles.textInput}
              keyboardType="numeric"
              placeholder="Ví dụ: 100.000"
              placeholderTextColor="#999"
              value={contribAmount}
              onChangeText={(text) => {
                const cleanNumber = text.replace(/[^0-9]/g, '');
                if (cleanNumber) {
                  setContribAmount(Number(cleanNumber).toLocaleString('vi-VN'));
                } else {
                  setContribAmount('');
                }
              }}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton]}
                onPress={() => {
                  setSelectedMemberId(null);
                  setContribAmount('');
                  setContribModalVisible(false);
                }}
              >
                <Text style={styles.modalButtonText}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.confirmButton]}
                onPress={handleAddContribution}
                disabled={isAddingContrib || !selectedMemberId || !contribAmount}
              >
                {isAddingContrib ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalButtonText}>Nạp Quỹ</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Modal Tạo Chuyến Đi Mới */}
      <Modal
        visible={tripModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => {
          setNewTripName('');
          setTripModalVisible(false);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Tạo chuyến đi mới</Text>
            <Text style={styles.modalLabel}>Tên chuyến đi / Mục đích chi tiêu:</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Ví dụ: Du lịch Đà Lạt 🏕️, Đi nhậu cuối tuần 🍻"
              placeholderTextColor="#999"
              value={newTripName}
              onChangeText={setNewTripName}
              autoFocus
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton]}
                onPress={() => {
                  setNewTripName('');
                  setTripModalVisible(false);
                }}
              >
                <Text style={styles.modalButtonText}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.confirmButton]}
                onPress={handleCreateTrip}
                disabled={isCreatingTrip || !newTripName.trim()}
              >
                {isCreatingTrip ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.modalButtonText}>Tạo Chuyến</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F9FA',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 24 : 0,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F8F9FA',
    padding: 20,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#4B5563',
    fontWeight: '500',
  },
  errorText: {
    fontSize: 16,
    color: '#EF4444',
    marginBottom: 20,
    fontWeight: 'bold',
  },
  backButton: {
    backgroundColor: '#1E3A8A',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  backButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1E3A8A',
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  backIcon: {
    padding: 4,
  },
  backIconText: {
    fontSize: 26,
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFFFFF',
    maxWidth: '55%',
  },
  deleteGroupBtn: {
    backgroundColor: '#EF4444',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  deleteGroupBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  deleteTripBtn: {
    backgroundColor: '#FEE2E2',
    padding: 6,
    borderRadius: 8,
    marginRight: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteTripText: {
    fontSize: 14,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  balanceCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  balanceCardLabel: {
    fontSize: 13,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  balanceCardValue: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#10B981',
    marginVertical: 10,
  },
  balanceCardSub: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#3B82F6',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  actionBtnContrib: {
    backgroundColor: '#10B981',
    marginRight: 0,
    marginLeft: 8,
  },
  actionBtnIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  actionBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 13,
  },
  sectionContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  sectionAddBtn: {
    backgroundColor: '#1E3A8A',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  sectionAddBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
  },
  memberTipText: {
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 12,
    fontStyle: 'italic',
  },
  tripItemCard: {
    flexDirection: 'row',
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  tripItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  tripIcon: {
    fontSize: 24,
    marginRight: 12,
  },
  tripDetails: {
    flex: 1,
  },
  tripName: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 4,
  },
  activeBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
    marginRight: 6,
  },
  activeText: {
    fontSize: 11,
    color: '#10B981',
    fontWeight: '500',
  },
  arrowIcon: {
    fontSize: 18,
    color: '#9CA3AF',
    fontWeight: 'bold',
    paddingLeft: 8,
  },
  membersRow: {
    flexDirection: 'row',
    paddingVertical: 4,
  },
  memberAvatarContainer: {
    alignItems: 'center',
    marginRight: 16,
    width: 60,
  },
  memberAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 1,
  },
  memberAvatarText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  memberName: {
    fontSize: 11,
    color: '#4B5563',
    marginTop: 6,
    textAlign: 'center',
    width: '100%',
    fontWeight: '500',
  },
  emptyText: {
    fontSize: 13,
    color: '#9CA3AF',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 18,
  },
  emptyHistory: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  contribItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  contribAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  contribAvatarText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  contribDetails: {
    flex: 1,
  },
  contribName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  contribDate: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 2,
  },
  contribAmountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  contribAmount: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#10B981',
    marginRight: 10,
  },
  deleteContribBtn: {
    padding: 6,
    backgroundColor: '#FEE2E2',
    borderRadius: 8,
  },
  deleteContribText: {
    fontSize: 12,
  },
  expenseBadge: {
    backgroundColor: '#EFF6FF',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 6,
    borderWidth: 0.5,
    borderColor: '#BFDBFE',
  },
  expenseBadgeText: {
    fontSize: 9,
    color: '#1E40AF',
    fontWeight: 'bold',
  },
  txDescription: {
    fontSize: 12,
    color: '#4B5563',
    marginTop: 2,
  },
  txSubtext: {
    fontSize: 11,
    color: '#3B82F6',
    fontWeight: '500',
    marginTop: 1,
  },
  positiveTxAmount: {
    color: '#10B981',
  },
  negativeTxAmount: {
    color: '#EF4444',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 16,
    textAlign: 'center',
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#4B5563',
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: '#1F2937',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  memberPickerRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    marginBottom: 16,
  },
  pickerMemberCard: {
    alignItems: 'center',
    padding: 8,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
    marginRight: 12,
    width: 72,
    backgroundColor: '#F9FAFB',
  },
  pickerMemberCardSelected: {
    borderColor: '#1E3A8A',
    backgroundColor: '#EFF6FF',
  },
  pickerMemberName: {
    fontSize: 10,
    color: '#4B5563',
    marginTop: 6,
    textAlign: 'center',
    width: '100%',
  },
  pickerMemberNameSelected: {
    color: '#1E3A8A',
    fontWeight: 'bold',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 'bold',
  },
  cancelButton: {
    backgroundColor: '#EF4444',
    marginRight: 8,
  },
  confirmButton: {
    backgroundColor: '#1E3A8A',
    marginLeft: 8,
  },
});
