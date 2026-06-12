import { Paths, Directory, File } from 'expo-file-system';

const billsDir = new Directory(Paths.document, 'bills');

/**
 * Đảm bảo thư mục lưu trữ hóa đơn tồn tại trong hệ thống tệp tin cục bộ.
 */
export async function ensureDirectoryExists(): Promise<void> {
  try {
    if (!billsDir.exists) {
      billsDir.create({ intermediates: true, idempotent: true });
    }
  } catch (error) {
    console.error('Error ensuring directory exists:', error);
    throw new Error('Không thể tạo thư mục lưu trữ hóa đơn cục bộ.');
  }
}

/**
 * Tạo một chuỗi UUID v4 ngẫu nhiên độc nhất bằng TypeScript thuần túy.
 * Giải pháp này an toàn, nhẹ và không yêu cầu thêm bất kỳ thư viện bên ngoài nào.
 */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Sao chép tệp ảnh chụp tạm thời từ camera hoặc thư viện vào thư mục lưu trữ chính thức của app.
 * Đồng thời đổi tên tệp tin theo định dạng `bill_[UUID].jpg`.
 * 
 * @param tempUri Đường dẫn tệp tin tạm thời (ví dụ: từ expo-image-picker)
 * @returns Đường dẫn tuyệt đối của tệp tin mới đã lưu trữ cục bộ thành công
 */
export async function saveBillImageLocally(tempUri: string): Promise<string> {
  if (!tempUri) {
    throw new Error('Đường dẫn ảnh tạm thời không hợp lệ.');
  }

  try {
    // Đảm bảo thư mục đích tồn tại
    await ensureDirectoryExists();

    const uuid = generateUUID();
    const fileName = `bill_${uuid}.jpg`;
    
    const sourceFile = new File(tempUri);
    const destinationFile = new File(billsDir, fileName);

    // Sao chép tệp tin
    sourceFile.copy(destinationFile);

    console.log(`Saved bill image locally: ${destinationFile.uri}`);
    return destinationFile.uri;
  } catch (error) {
    console.error('Failed to save bill image locally:', error);
    throw new Error('Lỗi trong quá trình lưu trữ ảnh hóa đơn cục bộ.');
  }
}
