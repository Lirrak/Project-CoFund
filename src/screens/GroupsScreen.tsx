import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { LocalDB, LocalGroup } from '../services/sqlite';

interface GroupsScreenProps {
  onNavigateToGroup: (groupId: number) => void;
  navigationKey?: number;
}

export function GroupsScreen({ onNavigateToGroup, navigationKey }: GroupsScreenProps) {
  const [groups, setGroups] = useState<LocalGroup[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [createModalVisible, setCreateModalVisible] = useState<boolean>(false);
  const [newGroupName, setNewGroupName] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);

  const fetchGroups = async () => {
    try {
      const db = LocalDB.getInstance();
      const groupList = await db.getGroups();
      setGroups(groupList);
    } catch (error) {
      console.error('Error fetching groups:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
  }, [navigationKey]);

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) {
      return;
    }
    setIsCreating(true);
    try {
      const db = LocalDB.getInstance();
      const newGroupId = await db.createGroup(newGroupName.trim());
      if (newGroupId) {
        setNewGroupName('');
        setCreateModalVisible(false);
        // Làm mới ngay danh sách để UI phản hồi tức thời
        await fetchGroups();
      }
    } catch (error) {
      console.error('Error creating group:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const totalBalance = groups.reduce((acc, curr) => acc + (curr.balance || 0), 0);

  const formatCurrency = (amount: number) => {
    return amount.toLocaleString('vi-VN') + ' đ';
  };

  const getRandomPastelColor = (name: string) => {
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
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % PASTEL_COLORS.length;
    return PASTEL_COLORS[index];
  };

  const renderGroupItem = ({ item }: { item: LocalGroup }) => {
    const avatarColor = getRandomPastelColor(item.name);
    const initial = item.name.charAt(0).toUpperCase();

    return (
      <TouchableOpacity
        style={styles.groupCard}
        activeOpacity={0.7}
        onPress={() => onNavigateToGroup(item.id)}
      >
        <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.textContainer}>
          <View style={styles.groupInfo}>
            <Text style={styles.groupName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.groupDate}>
              Tạo: {item.created_at}
            </Text>
          </View>
        </View>
        <View style={styles.groupBalanceContainer}>
          <Text style={styles.balanceLabel}>Số dư quỹ</Text>
          <Text style={styles.balanceValue}>{formatCurrency(item.balance || 0)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Dashboard */}
      <View style={styles.dashboard}>
        <Text style={styles.logoText}>CoFund 🚀</Text>
        <Text style={styles.dashboardSubtitle}>Hệ thống quản lý tài chính nhóm Offline</Text>
        
        <View style={styles.statsContainer}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Tổng số dư quỹ</Text>
            <Text style={styles.statValue}>{formatCurrency(totalBalance)}</Text>
          </View>
          <View style={[styles.statBox, styles.statBoxRight]}>
            <Text style={styles.statLabel}>Tổng số nhóm</Text>
            <Text style={styles.statValue}>{groups.length}</Text>
          </View>
        </View>
      </View>

      {/* Group List */}
      <View style={styles.listContainer}>
        <View style={styles.listHeader}>
          <Text style={styles.listTitle}>Danh sách nhóm</Text>
          <TouchableOpacity
            style={styles.addButton}
            activeOpacity={0.8}
            onPress={() => setCreateModalVisible(true)}
          >
            <Text style={styles.addButtonText}>+ Tạo nhóm</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        ) : groups.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>Chưa có nhóm nào được tạo.</Text>
            <Text style={styles.emptySubtext}>Hãy bấm nút "+ Tạo nhóm" để bắt đầu nhé!</Text>
          </View>
        ) : (
          <FlatList
            data={groups}
            renderItem={renderGroupItem}
            keyExtractor={(item) => item.id.toString()}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>

      {/* Create Group Modal */}
      <Modal
        visible={createModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setCreateModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Tạo nhóm quỹ mới</Text>
            <Text style={styles.modalLabel}>Tên nhóm:</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Ví dụ: Du lịch hè, Quỹ chung..."
              placeholderTextColor="#999"
              value={newGroupName}
              onChangeText={setNewGroupName}
              autoFocus
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton]}
                onPress={() => {
                  setNewGroupName('');
                  setCreateModalVisible(false);
                }}
              >
                <Text style={styles.cancelButtonText}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.confirmButton]}
                onPress={handleCreateGroup}
                disabled={isCreating || !newGroupName.trim()}
              >
                {isCreating ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.confirmButtonText}>Tạo</Text>
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
  },
  dashboard: {
    backgroundColor: '#1E3A8A',
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 32,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
  },
  logoText: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  dashboardSubtitle: {
    fontSize: 14,
    color: '#93C5FD',
    marginTop: 4,
  },
  statsContainer: {
    flexDirection: 'row',
    marginTop: 24,
    justifyContent: 'space-between',
  },
  statBox: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 16,
    padding: 16,
    marginRight: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  statBoxRight: {
    marginRight: 0,
    marginLeft: 8,
  },
  statLabel: {
    fontSize: 12,
    color: '#93C5FD',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  statValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginTop: 6,
  },
  listContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  listHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  listTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  addButton: {
    backgroundColor: '#10B981',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  listContent: {
    paddingBottom: 24,
  },
  groupCard: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  avatarText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1F2937',
  },
  textContainer: {
    flex: 1,
  },
  groupInfo: {
    justifyContent: 'center',
  },
  groupName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 4,
  },
  groupDate: {
    fontSize: 12,
    color: '#6B7280',
  },
  groupBalanceContainer: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 10,
  },
  balanceLabel: {
    fontSize: 11,
    color: '#6B7280',
    marginBottom: 2,
  },
  balanceValue: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#10B981',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 40,
    paddingHorizontal: 20,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4B5563',
    marginBottom: 4,
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
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
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1F2937',
    marginBottom: 16,
    textAlign: 'center',
  },
  modalLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4B5563',
    marginBottom: 8,
  },
  textInput: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#1F2937',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: {
    backgroundColor: '#EF4444',
    marginRight: 8,
  },
  cancelButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  confirmButton: {
    backgroundColor: '#1E3A8A',
    marginLeft: 8,
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
