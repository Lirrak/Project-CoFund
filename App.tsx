import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Navigation } from './src/navigation/Navigation';
import { LocalDB } from './src/services/sqlite';

export default function App() {
  useEffect(() => {
    // Khởi tạo SQLite database khi ứng dụng bắt đầu
    const initDB = async () => {
      const db = LocalDB.getInstance();
      const success = await db.initializeDatabase();
      if (success) {
        console.log('Local SQLite DB initialized successfully on App start.');
      } else {
        console.warn('Failed to initialize local SQLite DB on App start.');
      }
    };
    initDB();
  }, []);

  return (
    <SafeAreaProvider>
      <Navigation />
    </SafeAreaProvider>
  );
}
