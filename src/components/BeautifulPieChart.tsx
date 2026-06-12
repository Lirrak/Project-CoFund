import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import Svg, { Path, Circle, G } from 'react-native-svg';

export interface PieChartItem {
  id: number | string;
  label: string;
  value: number;
  color: string;
}

interface BeautifulPieChartProps {
  data: PieChartItem[];
  title?: string;
  centerLabel?: string;
}

/**
 * Component vẽ biểu đồ Doughnut (hình bánh donut tròn) hiện đại, sắc nét bằng SVG và Math thuần túy.
 * Hỗ trợ tính toán tỉ lệ tự động, vẽ các cung tròn mượt mà và hiển thị tâm biểu đồ bắt mắt.
 */
export function BeautifulPieChart({ data, title, centerLabel }: BeautifulPieChartProps) {
  const filteredData = data.filter((item) => item.value > 0);
  const total = filteredData.reduce((sum, item) => sum + item.value, 0);

  if (total === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Chưa có dữ liệu đóng góp/chi tiêu để vẽ biểu đồ.</Text>
      </View>
    );
  }

  const size = 180;
  const radius = 70;
  const center = size / 2;
  let startAngle = -90; // Bắt đầu vẽ từ đỉnh trên cùng (-90 độ)

  return (
    <View style={styles.container}>
      {title && <Text style={styles.chartTitle}>{title}</Text>}

      <View style={styles.chartWrapper}>
        <View style={styles.svgContainer}>
          <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <G transform={`translate(0, 0)`}>
              {filteredData.map((item, index) => {
                const percentage = (item.value / total) * 100;
                const angle = (item.value / total) * 360;
                const endAngle = startAngle + angle;

                // Chuyển đổi góc độ sang radian
                const radStart = (startAngle * Math.PI) / 180;
                const radEnd = (endAngle * Math.PI) / 180;

                // Tọa độ điểm bắt đầu và điểm kết thúc của cung tròn
                const x1 = center + radius * Math.cos(radStart);
                const y1 = center + radius * Math.sin(radStart);
                const x2 = center + radius * Math.cos(radEnd);
                const y2 = center + radius * Math.sin(radEnd);

                const largeArcFlag = angle > 180 ? 1 : 0;

                // Đường dẫn cung tròn SVG vẽ miếng bánh
                const pathData = [
                  `M ${center} ${center}`,
                  `L ${x1} ${y1}`,
                  `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
                  'Z',
                ].join(' ');

                // Lưu lại góc bắt đầu của miếng tiếp theo
                startAngle = endAngle;

                return <Path key={`${item.id}-${index}`} d={pathData} fill={item.color} />;
              })}

              {/* Vẽ vòng tròn rỗng ở tâm để biến Pie Chart thành Doughnut Chart sang trọng hơn */}
              <Circle cx={center} cy={center} r={42} fill="#FFFFFF" />
            </G>
          </Svg>

          {/* Label nằm chính giữa Doughnut Chart */}
          <View style={styles.centerLabelContainer}>
            <Text style={styles.centerLabelNum}>{centerLabel || filteredData.length}</Text>
            <Text style={styles.centerLabelText}>thành viên</Text>
          </View>
        </View>

        {/* Chú thích chú giải biểu đồ đẹp mắt */}
        <View style={styles.legendWrapper}>
          {filteredData.map((item, index) => {
            const percent = ((item.value / total) * 100).toFixed(1);
            return (
              <View key={`${item.id}-${index}`} style={styles.legendRow}>
                <View style={[styles.legendIndicator, { backgroundColor: item.color }]} />
                <View style={styles.legendTextContainer}>
                  <Text style={styles.legendLabel} numberOfLines={1}>
                    {item.label}
                  </Text>
                  <Text style={styles.legendPercent}>{percent}%</Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    marginVertical: 12,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 3,
  },
  chartTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 16,
    textAlign: 'center',
  },
  chartWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  svgContainer: {
    width: 180,
    height: 180,
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerLabelContainer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  centerLabelNum: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  },
  centerLabelText: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 2,
  },
  legendWrapper: {
    flex: 1,
    paddingLeft: 16,
    justifyContent: 'center',
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
  },
  legendIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
  legendTextContainer: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  legendLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#334155',
    maxWidth: '65%',
  },
  legendPercent: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
  },
  emptyContainer: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
  },
  emptyText: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
  },
});
