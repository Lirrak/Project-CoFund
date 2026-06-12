import { useEffect, useRef } from 'react';
import { supabase } from '../services/supabase';
import { LocalDB } from '../services/sqlite';

export interface RealtimeSyncEvent {
  table: 'contributions' | 'expenses' | 'funds' | 'splits';
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  data: any;
  message?: string;
}

/**
 * Custom Hook đăng ký (subscribe) Realtime WebSockets với Supabase.
 * Tự động lắng nghe các sự kiện INSERT, UPDATE, DELETE trên các bảng: funds, contributions, expenses, splits.
 * Lọc dữ liệu theo `groupId` hiện tại và cập nhật đồng bộ trực tiếp vào cơ sở dữ liệu SQLite cục bộ,
 * sau đó thông báo cho React State để hiển thị giao diện tức thời mà không lo rò rỉ bộ nhớ (memory leaks).
 * 
 * @param groupId ID của nhóm hiện tại cần đồng bộ
 * @param onSync Callback được gọi khi có sự kiện đồng bộ thành công để cập nhật UI & thông báo Toast
 */
export function useRealtimeSync(
  groupId: number,
  onSync?: (event: RealtimeSyncEvent) => void
) {
  // Sử dụng ref để giữ callback mới nhất, tránh trigger việc tạo lại đăng ký realtime khi callback thay đổi
  const onSyncRef = useRef(onSync);
  useEffect(() => {
    onSyncRef.current = onSync;
  }, [onSync]);

  useEffect(() => {
    if (!groupId) return;

    const db = LocalDB.getInstance();
    console.log(`[RealtimeSync] Khởi tạo đăng ký Realtime cho nhóm: ${groupId}`);

    // Đăng ký kênh Realtime của Supabase dựa trên groupId
    const channel = supabase.channel(`group-realtime-sync-${groupId}`);

    // 1. Lắng nghe cập nhật bảng FUNDS (Đã lọc theo group_id ở phía DB Supabase để tăng hiệu năng)
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'funds',
        filter: `group_id=eq.${groupId}`,
      },
      async (payload) => {
        try {
          const { eventType, new: newRecord, old: oldRecord } = payload;
          console.log(`[RealtimeSync] Sự kiện FUNDS: ${eventType}`, payload);

          if (eventType === 'INSERT' || eventType === 'UPDATE') {
            // Upsert vào SQLite cục bộ
            await db.runAsync(
              `INSERT INTO funds (id, group_id, name, balance)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET 
                 group_id = excluded.group_id, 
                 name = excluded.name, 
                 balance = excluded.balance;`,
              [newRecord.id, newRecord.group_id, newRecord.name, newRecord.balance]
            );

            const formatAmount = newRecord.balance.toLocaleString('vi-VN') + ' đ';
            onSyncRef.current?.({
              table: 'funds',
              type: eventType,
              data: newRecord,
              message: `Số dư quỹ nhóm được cập nhật thành: ${formatAmount}`,
            });
          } else if (eventType === 'DELETE' && oldRecord) {
            await db.runAsync('DELETE FROM funds WHERE id = ?;', [oldRecord.id]);
            onSyncRef.current?.({
              table: 'funds',
              type: 'DELETE',
              data: oldRecord,
              message: `Quỹ chung của nhóm đã bị xóa khỏi đám mây.`,
            });
          }
        } catch (error) {
          console.error('[RealtimeSync] Lỗi khi đồng bộ bảng funds:', error);
        }
      }
    );

    // 2. Lắng nghe cập nhật bảng CONTRIBUTIONS
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'contributions',
      },
      async (payload) => {
        try {
          const { eventType, new: newRecord, old: oldRecord } = payload;
          console.log(`[RealtimeSync] Sự kiện CONTRIBUTIONS: ${eventType}`);

          if (eventType === 'INSERT' || eventType === 'UPDATE') {
            // Kiểm tra xem đóng góp này có thuộc về quỹ của nhóm hiện tại không
            const fundCheck = await db.getFirstAsync<any>(
              'SELECT 1 FROM funds WHERE id = ? AND group_id = ?;',
              [newRecord.fund_id, groupId]
            );

            if (!fundCheck) {
              console.log(`[RealtimeSync] Đóng góp không thuộc quỹ của nhóm này. Bỏ qua.`);
              return;
            }

            // Lấy tên thành viên đóng góp từ SQLite cục bộ để hiển thị Toast thân thiện
            const profile = await db.getFirstAsync<{ display_name: string }>(
              'SELECT display_name FROM profiles WHERE id = ?;',
              [newRecord.user_id]
            );
            const memberName = profile?.display_name || 'Một thành viên';

            // Upsert vào SQLite cục bộ
            await db.runAsync(
              `INSERT INTO contributions (id, fund_id, user_id, amount, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET 
                 fund_id = excluded.fund_id, 
                 user_id = excluded.user_id, 
                 amount = excluded.amount, 
                 created_at = excluded.created_at;`,
              [newRecord.id, newRecord.fund_id, newRecord.user_id, newRecord.amount, newRecord.created_at]
            );

            const formatAmount = newRecord.amount.toLocaleString('vi-VN') + ' đ';
            onSyncRef.current?.({
              table: 'contributions',
              type: eventType,
              data: newRecord,
              message: `${memberName} vừa đóng góp ${formatAmount} vào quỹ!`,
            });
          } else if (eventType === 'DELETE' && oldRecord) {
            // Kiểm tra đóng góp cục bộ trước khi xóa
            const localContrib = await db.getFirstAsync<any>(
              'SELECT fund_id FROM contributions WHERE id = ?;',
              [oldRecord.id]
            );

            if (localContrib) {
              const fundCheck = await db.getFirstAsync<any>(
                'SELECT 1 FROM funds WHERE id = ? AND group_id = ?;',
                [localContrib.fund_id, groupId]
              );

              if (fundCheck) {
                await db.runAsync('DELETE FROM contributions WHERE id = ?;', [oldRecord.id]);
                onSyncRef.current?.({
                  table: 'contributions',
                  type: 'DELETE',
                  data: oldRecord,
                  message: `Một lượt đóng góp quỹ đã bị xóa khỏi đám mây.`,
                });
              }
            }
          }
        } catch (error) {
          console.error('[RealtimeSync] Lỗi khi đồng bộ bảng contributions:', error);
        }
      }
    );

    // 3. Lắng nghe cập nhật bảng EXPENSES (Hóa đơn chi tiêu)
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'expenses',
      },
      async (payload) => {
        try {
          const { eventType, new: newRecord, old: oldRecord } = payload;
          console.log(`[RealtimeSync] Sự kiện EXPENSES: ${eventType}`);

          if (eventType === 'INSERT' || eventType === 'UPDATE') {
            // Lọc xem chuyến đi tương ứng có thuộc nhóm hiện tại không
            const tripCheck = await db.getFirstAsync<any>(
              'SELECT 1 FROM trips WHERE id = ? AND group_id = ?;',
              [newRecord.trip_id, groupId]
            );

            if (!tripCheck) {
              console.log(`[RealtimeSync] Hóa đơn thuộc chuyến đi không nằm trong nhóm này. Bỏ qua.`);
              return;
            }

            // Lấy tên người chi trả từ SQLite
            let payerName = 'Quỹ chung';
            if (newRecord.paid_by) {
              const profile = await db.getFirstAsync<{ display_name: string }>(
                'SELECT display_name FROM profiles WHERE id = ?;',
                [newRecord.paid_by]
              );
              payerName = profile?.display_name || 'Một thành viên';
            }

            // Upsert hóa đơn vào SQLite cục bộ
            await db.runAsync(
              `INSERT INTO expenses (id, trip_id, paid_by, total_amount, description, bill_image_uri, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET 
                 trip_id = excluded.trip_id, 
                 paid_by = excluded.paid_by, 
                 total_amount = excluded.total_amount, 
                 description = excluded.description, 
                 bill_image_uri = excluded.bill_image_uri, 
                 created_at = excluded.created_at;`,
              [
                newRecord.id,
                newRecord.trip_id,
                newRecord.paid_by,
                newRecord.total_amount,
                newRecord.description,
                newRecord.bill_image_uri,
                newRecord.created_at,
              ]
            );

            const formatAmount = newRecord.total_amount.toLocaleString('vi-VN') + ' đ';
            const desc = newRecord.description || 'Chi tiêu không tên';
            onSyncRef.current?.({
              table: 'expenses',
              type: eventType,
              data: newRecord,
              message: `${payerName} vừa thêm hóa đơn '${desc}' trị giá ${formatAmount}!`,
            });
          } else if (eventType === 'DELETE' && oldRecord) {
            const localExpense = await db.getFirstAsync<any>(
              'SELECT trip_id FROM expenses WHERE id = ?;',
              [oldRecord.id]
            );

            if (localExpense) {
              const tripCheck = await db.getFirstAsync<any>(
                'SELECT 1 FROM trips WHERE id = ? AND group_id = ?;',
                [localExpense.trip_id, groupId]
              );

              if (tripCheck) {
                await db.runAsync('DELETE FROM expenses WHERE id = ?;', [oldRecord.id]);
                onSyncRef.current?.({
                  table: 'expenses',
                  type: 'DELETE',
                  data: oldRecord,
                  message: `Một hóa đơn chi tiêu đã bị xóa khỏi đám mây.`,
                });
              }
            }
          }
        } catch (error) {
          console.error('[RealtimeSync] Lỗi khi đồng bộ bảng expenses:', error);
        }
      }
    );

    // 4. Lắng nghe cập nhật bảng SPLITS (Bảng chi tiết chia phần gánh hóa đơn)
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'splits',
      },
      async (payload) => {
        try {
          const { eventType, new: newRecord, old: oldRecord } = payload;
          console.log(`[RealtimeSync] Sự kiện SPLITS: ${eventType}`);

          if (eventType === 'INSERT' || eventType === 'UPDATE') {
            // Kiểm tra xem split này có thuộc về một hóa đơn của nhóm hiện tại không
            const splitCheck = await db.getFirstAsync<any>(
              `SELECT 1 FROM expenses e 
               JOIN trips t ON e.trip_id = t.id 
               WHERE e.id = ? AND t.group_id = ?;`,
              [newRecord.expense_id, groupId]
            );

            if (!splitCheck) {
              console.log(`[RealtimeSync] Split không thuộc về hóa đơn của nhóm này. Bỏ qua.`);
              return;
            }

            // Upsert vào SQLite cục bộ
            await db.runAsync(
              `INSERT INTO splits (id, expense_id, user_id, ratio, calculated_amount)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET 
                 expense_id = excluded.expense_id, 
                 user_id = excluded.user_id, 
                 ratio = excluded.ratio, 
                 calculated_amount = excluded.calculated_amount;`,
              [newRecord.id, newRecord.expense_id, newRecord.user_id, newRecord.ratio, newRecord.calculated_amount]
            );

            onSyncRef.current?.({
              table: 'splits',
              type: eventType,
              data: newRecord,
            });
          } else if (eventType === 'DELETE' && oldRecord) {
            const localSplit = await db.getFirstAsync<any>(
              'SELECT expense_id FROM splits WHERE id = ?;',
              [oldRecord.id]
            );

            if (localSplit) {
              const splitCheck = await db.getFirstAsync<any>(
                `SELECT 1 FROM expenses e 
                 JOIN trips t ON e.trip_id = t.id 
                 WHERE e.id = ? AND t.group_id = ?;`,
                [localSplit.expense_id, groupId]
              );

              if (splitCheck) {
                await db.runAsync('DELETE FROM splits WHERE id = ?;', [oldRecord.id]);
                onSyncRef.current?.({
                  table: 'splits',
                  type: 'DELETE',
                  data: oldRecord,
                });
              }
            }
          }
        } catch (error) {
          console.error('[RealtimeSync] Lỗi khi đồng bộ bảng splits:', error);
        }
      }
    );

    // Bắt đầu kết nối kênh WebSocket
    channel.subscribe((status) => {
      console.log(`[RealtimeSync] Trạng thái kết nối kênh cho nhóm ${groupId}: ${status}`);
    });

    // Cleanup function: Đảm bảo unsubscribe hoàn toàn WebSocket để tránh rò rỉ bộ nhớ (memory leaks)
    return () => {
      console.log(`[RealtimeSync] Dọn dẹp & ngắt kết nối Realtime cho nhóm: ${groupId}`);
      supabase.removeChannel(channel);
    };
  }, [groupId]);
}
