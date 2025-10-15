import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { HistoryRecord } from "../services/payments";
import { PaymentRow } from "./PaymentRow";
import {
  getHistoryDisplayTimestamp,
  getHistoryIdentifier,
} from "../utils/paymentsFormatting";

type RecentPaymentsCardProps = {
  records: HistoryRecord[];
  isLoading: boolean;
  error: string | null;
  onRetry?: () => void;
};

export const RecentPaymentsCard: React.FC<RecentPaymentsCardProps> = ({
  records,
  isLoading,
  error,
  onRetry,
}) => {
  const showPlaceholder = !isLoading && records.length === 0 && !error;
  const orderedRecords = React.useMemo(() => {
    return [...records].sort((a, b) => {
      const aTs = getHistoryDisplayTimestamp(a) ?? 0;
      const bTs = getHistoryDisplayTimestamp(b) ?? 0;
      return bTs - aTs;
    });
  }, [records]);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>Recent payments</Text>
        {isLoading ? <ActivityIndicator size="small" color="#2563eb" /> : null}
      </View>

      {error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
          {onRetry ? (
            <Pressable style={styles.retryButton} onPress={onRetry}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {showPlaceholder ? (
        <Text style={styles.placeholderText}>
          No payments or invoices yet. Activity will appear here once you send
          or receive sats.
        </Text>
      ) : null}

      {!showPlaceholder && !error ? (
        <View style={styles.list}>
          {orderedRecords.map((record, index) => {
            const identifier = getHistoryIdentifier(record);
            const key = identifier || record.id || `history-${index}`;
            return <PaymentRow key={key} record={record} />;
          })}
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 16,
    paddingVertical: 20,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 16,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1f2937",
  },
  errorContainer: {
    backgroundColor: "#fee2e2",
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  errorText: {
    color: "#991b1b",
    fontSize: 14,
  },
  retryButton: {
    alignSelf: "flex-start",
    backgroundColor: "#991b1b",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  retryButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  placeholderText: {
    color: "#64748b",
    fontSize: 14,
    lineHeight: 20,
  },
  list: {
    gap: 12,
  },
});
