import { createClient } from '@supabase/supabase-js';

// Các cấu hình Supabase Cloud. Người dùng có thể thay đổi bằng các biến môi trường EXPO_PUBLIC_*.
// Cung cấp sẵn các giá trị mặc định/placeholder hợp lệ để ứng dụng có thể chạy mượt mà.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://your-supabase-url.supabase.co';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'your-anon-key';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false, // Thích hợp cho môi trường mobile/React Native offline-first
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});
