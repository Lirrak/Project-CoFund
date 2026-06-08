import * as SQLite from 'expo-sqlite';

// --- TypeScript Interfaces ---

export interface LocalProfile {
  id: number;
  display_name: string;
  avatar_color: string;
}

export interface LocalGroup {
  id: number;
  name: string;
  created_at: string;
  balance?: number; // Số dư quỹ đi kèm khi lấy danh sách nhóm
}

export interface LocalGroupMember extends LocalProfile {
  role: string;
}

export interface LocalFund {
  id: number;
  group_id: number;
  name: string;
  balance: number;
}

export interface LocalContribution {
  id: number;
  fund_id: number;
  user_id: number;
  amount: number;
  created_at: string;
  display_name?: string; // Tên hiển thị của người đóng góp đi kèm
  avatar_color?: string; // Màu avatar đi kèm
}

export interface LocalTrip {
  id: number;
  group_id: number;
  name: string;
  is_active: number; // 1 = true, 0 = false
}

export interface LocalExpense {
  id: number;
  trip_id: number;
  paid_by: number;
  total_amount: number;
  description: string | null;
  bill_image_uri: string | null;
  created_at: string;
}

export interface LocalSplit {
  id: number;
  expense_id: number;
  user_id: number;
  ratio: number;
  calculated_amount: number;
}

const DB_NAME = 'cofund_local.db';

export class LocalDB {
  private static instance: LocalDB | null = null;
  private dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

  private constructor() {
    // Private constructor to enforce Singleton pattern
  }

  /**
   * Lấy instance duy nhất của LocalDB (Singleton pattern)
   */
  public static getInstance(): LocalDB {
    if (!LocalDB.instance) {
      LocalDB.instance = new LocalDB();
    }
    return LocalDB.instance;
  }

  /**
   * Mở database không đồng bộ và lưu trữ promise để tránh mở nhiều kết nối
   */
  private getDb(): Promise<SQLite.SQLiteDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = SQLite.openDatabaseAsync(DB_NAME);
    }
    return this.dbPromise;
  }

  /**
   * Khởi tạo cơ sở dữ liệu: tạo tất cả các bảng cần thiết nếu chưa tồn tại.
   * Xử lý ngoại lệ chu đáo để tránh crash ứng dụng.
   */
  public async initializeDatabase(): Promise<boolean> {
    try {
      const db = await this.getDb();
      
      // Bật Foreign Key support trong SQLite
      await db.execAsync('PRAGMA foreign_keys = ON;');

      // Tạo các bảng tuần tự
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL,
          avatar_color TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS group_members (
          group_id INTEGER,
          user_id INTEGER,
          role TEXT DEFAULT 'member',
          PRIMARY KEY(group_id, user_id),
          FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS funds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER UNIQUE,
          name TEXT DEFAULT 'Quỹ chung',
          balance REAL DEFAULT 0.0,
          FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS contributions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fund_id INTEGER,
          user_id INTEGER,
          amount REAL NOT NULL,
          created_at TEXT DEFAULT (datetime('now', 'localtime')),
          FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS trips (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER,
          name TEXT NOT NULL,
          is_active INTEGER DEFAULT 1,
          FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER,
          paid_by INTEGER,
          total_amount REAL NOT NULL,
          description TEXT,
          bill_image_uri TEXT,
          created_at TEXT DEFAULT (datetime('now', 'localtime')),
          FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
          FOREIGN KEY (paid_by) REFERENCES profiles(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS splits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          expense_id INTEGER,
          user_id INTEGER,
          ratio REAL NOT NULL,
          calculated_amount REAL NOT NULL,
          FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT
        );
      `);
      
      console.log('Database initialized successfully.');
      return true;
    } catch (error) {
      console.error('Failed to initialize database:', error);
      return false;
    }
  }

  /**
   * Tạo một nhóm mới và tự động tạo quỹ chung tương ứng trong cùng một transaction.
   * @param name Tên nhóm mới
   * @returns ID của nhóm mới tạo, hoặc null nếu xảy ra lỗi
   */
  public async createGroup(name: string): Promise<number | null> {
    try {
      const db = await this.getDb();
      let groupId: number | null = null;

      await db.withTransactionAsync(async () => {
        // 1. Chèn nhóm mới
        const groupResult = await db.runAsync(
          'INSERT INTO groups (name) VALUES (?);',
          [name]
        );
        groupId = groupResult.lastInsertRowId;

        // 2. Tự động chèn bản ghi quỹ (funds) tương ứng cho nhóm đó
        await db.runAsync(
          'INSERT INTO funds (group_id, name, balance) VALUES (?, ?, ?);',
          [groupId, 'Quỹ chung', 0.0]
        );
      });

      return groupId;
    } catch (error) {
      console.error(`Error in createGroup for "${name}":`, error);
      return null;
    }
  }

  /**
   * Lấy danh sách tất cả các nhóm kèm theo số dư quỹ của từng nhóm.
   * @returns Danh sách nhóm, hoặc mảng rỗng nếu xảy ra lỗi
   */
  public async getGroups(): Promise<LocalGroup[]> {
    try {
      const db = await this.getDb();
      const rows = await db.getAllAsync<LocalGroup>(`
        SELECT g.id, g.name, g.created_at, COALESCE(f.balance, 0.0) as balance
        FROM groups g
        LEFT JOIN funds f ON g.id = f.group_id
        ORDER BY g.id DESC;
      `);
      return rows;
    } catch (error) {
      console.error('Error in getGroups:', error);
      return [];
    }
  }

  /**
   * Lấy thông tin chi tiết một nhóm theo ID, kèm theo số dư quỹ của nhóm đó.
   * @param id ID của nhóm cần tìm
   * @returns Thông tin nhóm, hoặc null nếu không tìm thấy hoặc xảy ra lỗi
   */
  public async getGroupById(id: number): Promise<LocalGroup | null> {
    try {
      const db = await this.getDb();
      const row = await db.getFirstAsync<LocalGroup>(`
        SELECT g.id, g.name, g.created_at, COALESCE(f.balance, 0.0) as balance
        FROM groups g
        LEFT JOIN funds f ON g.id = f.group_id
        WHERE g.id = ?;
      `, [id]);
      return row;
    } catch (error) {
      console.error(`Error in getGroupById for ID ${id}:`, error);
      return null;
    }
  }

  /**
   * Lấy danh sách thành viên thuộc một nhóm xác định.
   * @param groupId ID của nhóm
   * @returns Danh sách các thành viên (kèm vai trò), hoặc mảng rỗng nếu lỗi
   */
  public async getGroupMembers(groupId: number): Promise<LocalGroupMember[]> {
    try {
      const db = await this.getDb();
      const rows = await db.getAllAsync<LocalGroupMember>(`
        SELECT p.id, p.display_name, p.avatar_color, gm.role
        FROM profiles p
        INNER JOIN group_members gm ON p.id = gm.user_id
        WHERE gm.group_id = ?
        ORDER BY p.display_name ASC;
      `, [groupId]);
      return rows;
    } catch (error) {
      console.error(`Error in getGroupMembers for Group ID ${groupId}:`, error);
      return [];
    }
  }

  /**
   * Thêm thành viên mới: Chèn vào bảng profiles và liên kết vào group_members trong một transaction.
   * @param groupId ID của nhóm muốn thêm thành viên
   * @param name Tên của thành viên mới
   * @param avatarColor Mã màu avatar của thành viên mới
   * @returns ID của profile thành viên mới, hoặc null nếu xảy ra lỗi
   */
  public async addMemberToGroup(
    groupId: number,
    name: string,
    avatarColor: string
  ): Promise<number | null> {
    try {
      const db = await this.getDb();
      let profileId: number | null = null;

      await db.withTransactionAsync(async () => {
        // 1. Chèn thành viên mới vào bảng profiles
        const profileResult = await db.runAsync(
          'INSERT INTO profiles (display_name, avatar_color) VALUES (?, ?);',
          [name, avatarColor]
        );
        profileId = profileResult.lastInsertRowId;

        // 2. Liên kết thành viên mới vào group_members
        await db.runAsync(
          'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?);',
          [groupId, profileId, 'member']
        );
      });

      return profileId;
    } catch (error) {
      console.error(`Error in addMemberToGroup for Group ID ${groupId}:`, error);
      return null;
    }
  }

  /**
   * Đóng góp quỹ: Chèn một bản ghi đóng góp mới và cộng dồn số tiền vào số dư quỹ trong một transaction.
   * @param fundId ID của quỹ
   * @param userId ID của người đóng góp (profile ID)
   * @param amount Số tiền đóng góp
   * @returns ID của đóng góp mới tạo, hoặc null nếu xảy ra lỗi
   */
  public async addContribution(
    fundId: number,
    userId: number,
    amount: number
  ): Promise<number | null> {
    try {
      if (amount <= 0) {
        throw new Error('Contribution amount must be greater than zero');
      }

      const db = await this.getDb();
      let contributionId: number | null = null;

      await db.withTransactionAsync(async () => {
        // 1. Chèn bản ghi nạp quỹ (contributions)
        const contributionResult = await db.runAsync(
          'INSERT INTO contributions (fund_id, user_id, amount) VALUES (?, ?, ?);',
          [fundId, userId, amount]
        );
        contributionId = contributionResult.lastInsertRowId;

        // 2. Cộng dồn số tiền đóng góp vào số dư của quỹ tương ứng
        await db.runAsync(
          'UPDATE funds SET balance = balance + ? WHERE id = ?;',
          [amount, fundId]
        );
      });

      return contributionId;
    } catch (error) {
      console.error(`Error in addContribution to Fund ID ${fundId} by User ID ${userId}:`, error);
      return null;
    }
  }

  /**
   * Lấy lịch sử đóng góp quỹ của một quỹ xác định, kèm theo thông tin hiển thị của thành viên.
   * @param fundId ID của quỹ
   * @returns Danh sách các lần đóng góp, hoặc mảng rỗng nếu xảy ra lỗi
   */
  public async getContributions(fundId: number): Promise<LocalContribution[]> {
    try {
      const db = await this.getDb();
      const rows = await db.getAllAsync<LocalContribution>(`
        SELECT 
          c.id, 
          c.fund_id, 
          c.user_id, 
          c.amount, 
          c.created_at,
          p.display_name,
          p.avatar_color
        FROM contributions c
        INNER JOIN profiles p ON c.user_id = p.id
        WHERE c.fund_id = ?
        ORDER BY c.id DESC;
      `, [fundId]);
      return rows;
    } catch (error) {
      console.error(`Error in getContributions for Fund ID ${fundId}:`, error);
      return [];
    }
  }

  /**
   * Lấy thông quan quỹ của một nhóm theo ID nhóm.
   * @param groupId ID của nhóm
   * @returns Thông tin quỹ, hoặc null nếu không tìm thấy hoặc lỗi
   */
  public async getFundByGroupId(groupId: number): Promise<LocalFund | null> {
    try {
      const db = await this.getDb();
      const row = await db.getFirstAsync<LocalFund>(`
        SELECT id, group_id, name, balance
        FROM funds
        WHERE group_id = ?;
      `, [groupId]);
      return row;
    } catch (error) {
      console.error(`Error in getFundByGroupId for Group ID ${groupId}:`, error);
      return null;
    }
  }

  /**
   * Chèn chuyến đi mới vào bảng trips.
   * @param groupId ID của nhóm
   * @param name Tên chuyến đi
   * @returns ID của chuyến đi mới, hoặc null nếu lỗi
   */
  public async createTrip(groupId: number, name: string): Promise<number | null> {
    try {
      const db = await this.getDb();
      const result = await db.runAsync(
        'INSERT INTO trips (group_id, name, is_active) VALUES (?, ?, 1);',
        [groupId, name]
      );
      return result.lastInsertRowId;
    } catch (error) {
      console.error(`Error in createTrip for Group ID ${groupId} and name "${name}":`, error);
      return null;
    }
  }

  /**
   * Lấy danh sách chuyến đi của nhóm.
   * @param groupId ID của nhóm
   * @returns Danh sách chuyến đi, hoặc mảng rỗng nếu lỗi
   */
  public async getTripsByGroupId(groupId: number): Promise<LocalTrip[]> {
    try {
      const db = await this.getDb();
      const rows = await db.getAllAsync<LocalTrip>(`
        SELECT id, group_id, name, is_active
        FROM trips
        WHERE group_id = ?
        ORDER BY id DESC;
      `, [groupId]);
      return rows;
    } catch (error) {
      console.error(`Error in getTripsByGroupId for Group ID ${groupId}:`, error);
      return [];
    }
  }

  /**
   * Xóa nhóm (sẽ tự động cascade xóa members, funds, trips, expenses qua Foreign Key).
   * @param groupId ID của nhóm cần xóa
   * @returns true nếu thành công, false nếu lỗi
   */
  public async deleteGroup(groupId: number): Promise<boolean> {
    try {
      const db = await this.getDb();
      await db.runAsync('DELETE FROM groups WHERE id = ?;', [groupId]);
      return true;
    } catch (error) {
      console.error(`Error in deleteGroup for Group ID ${groupId}:`, error);
      return false;
    }
  }

  /**
   * Xóa liên kết thành viên trong group_members.
   * @param groupId ID của nhóm
   * @param userId ID của người dùng
   * @returns true nếu thành công, false nếu lỗi
   */
  public async deleteMemberFromGroup(groupId: number, userId: number): Promise<boolean> {
    try {
      const db = await this.getDb();
      await db.runAsync(
        'DELETE FROM group_members WHERE group_id = ? AND user_id = ?;',
        [groupId, userId]
      );
      return true;
    } catch (error) {
      console.error(`Error in deleteMemberFromGroup for Group ID ${groupId}, User ID ${userId}:`, error);
      return false;
    }
  }

  /**
   * Xóa lượt đóng quỹ. Phải thực thi trong một transaction để TRỪ đi số tiền này trong bảng funds.balance tương ứng.
   * @param contributionId ID của đóng góp cần xóa
   * @param fundId ID của quỹ tương ứng
   * @param amount Số tiền cần trừ đi
   * @returns true nếu thành công, false nếu lỗi
   */
  public async deleteContribution(
    contributionId: number,
    fundId: number,
    amount: number
  ): Promise<boolean> {
    try {
      const db = await this.getDb();
      await db.withTransactionAsync(async () => {
        // 1. Xóa bản ghi đóng góp
        await db.runAsync('DELETE FROM contributions WHERE id = ?;', [contributionId]);

        // 2. Trừ đi số tiền đóng góp khỏi số dư của quỹ tương ứng
        await db.runAsync(
          'UPDATE funds SET balance = balance - ? WHERE id = ?;',
          [amount, fundId]
        );
      });
      return true;
    } catch (error) {
      console.error(`Error in deleteContribution for Contribution ID ${contributionId}:`, error);
      return false;
    }
  }

  /**
   * Thực thi truy vấn lấy tất cả các dòng kết quả (Generic).
   */
  public async getAllAsync<T>(query: string, params: any[] = []): Promise<T[]> {
    try {
      const db = await this.getDb();
      return await db.getAllAsync<T>(query, params);
    } catch (error) {
      console.error(`Error in getAllAsync for query "${query}":`, error);
      throw error;
    }
  }

  /**
   * Thực thi truy vấn lấy dòng kết quả đầu tiên (Generic).
   */
  public async getFirstAsync<T>(query: string, params: any[] = []): Promise<T | null> {
    try {
      const db = await this.getDb();
      return await db.getFirstAsync<T>(query, params);
    } catch (error) {
      console.error(`Error in getFirstAsync for query "${query}":`, error);
      throw error;
    }
  }

  /**
   * Thực thi câu lệnh ghi/chỉnh sửa dữ liệu (Generic).
   */
  public async runAsync(query: string, params: any[] = []): Promise<SQLite.SQLiteRunResult> {
    try {
      const db = await this.getDb();
      return await db.runAsync(query, params);
    } catch (error) {
      console.error(`Error in runAsync for query "${query}":`, error);
      throw error;
    }
  }

  /**
   * Thực thi trong một transaction (Generic).
   */
  public async withTransactionAsync(callback: () => Promise<void>): Promise<void> {
    try {
      const db = await this.getDb();
      await db.withTransactionAsync(callback);
    } catch (error) {
      console.error('Error in withTransactionAsync:', error);
      throw error;
    }
  }
}
