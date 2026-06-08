import React, { useState } from 'react';
import { GroupsScreen } from '../screens/GroupsScreen';
import { GroupDetailsScreen } from '../screens/GroupDetailsScreen';
import { TripExpensesScreen } from '../screens/TripExpensesScreen';

type ScreenState =
  | { name: 'Groups'; key: number }
  | { name: 'GroupDetails'; groupId: number; key: number }
  | { name: 'TripExpenses'; tripId: number; tripName: string; groupId: number; key: number };

export function Navigation() {
  // Quản lý Stack Navigation đơn giản và tối ưu hiệu năng
  const [history, setHistory] = useState<ScreenState[]>([
    { name: 'Groups', key: Date.now() },
  ]);

  const currentScreen = history[history.length - 1] || { name: 'Groups', key: Date.now() };

  // Chuyển sang chi tiết nhóm
  const navigateToGroupDetails = (groupId: number) => {
    setHistory((prev) => [
      ...prev,
      { name: 'GroupDetails', groupId, key: Date.now() },
    ]);
  };

  // Chuyển sang chi tiết chi tiêu chuyến đi
  const navigateToTripExpenses = (tripId: number, tripName: string, groupId: number) => {
    setHistory((prev) => [
      ...prev,
      { name: 'TripExpenses', tripId, tripName, groupId, key: Date.now() },
    ]);
  };

  // Quay lại màn hình trước và tự động kích hoạt refresh màn hình trước đó
  const navigateBack = () => {
    if (history.length > 1) {
      setHistory((prev) => {
        const nextHistory = prev.slice(0, -1);
        const lastIndex = nextHistory.length - 1;
        if (lastIndex >= 0) {
          nextHistory[lastIndex] = {
            ...nextHistory[lastIndex],
            key: Date.now(), // Cập nhật key để trigger useEffect tải lại dữ liệu mới nhất từ SQLite
          };
        }
        return nextHistory;
      });
    }
  };

  if (currentScreen.name === 'TripExpenses') {
    return (
      <TripExpensesScreen
        tripId={currentScreen.tripId}
        tripName={currentScreen.tripName}
        groupId={currentScreen.groupId}
        onGoBack={navigateBack}
      />
    );
  }

  if (currentScreen.name === 'GroupDetails') {
    return (
      <GroupDetailsScreen
        groupId={currentScreen.groupId}
        onGoBack={navigateBack}
        onNavigateToTripExpenses={navigateToTripExpenses}
        navigationKey={currentScreen.key}
      />
    );
  }

  return (
    <GroupsScreen
      onNavigateToGroup={navigateToGroupDetails}
      navigationKey={currentScreen.key}
    />
  );
}
