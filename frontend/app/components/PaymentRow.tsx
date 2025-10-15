import React from "react";
import { StyleSheet, Text, View } from "react-native";

import type { HistoryRecord } from "../services/payments";
import {
  formatSatsValue,
  formatPaymentUpdatedAt,
  getHistoryAmount,
  getHistoryDisplayTimestamp,
  getHistoryIdentifier,
  getHistoryStatus,
} from "../utils/paymentsFormatting";

type PaymentRowProps = {
  record: HistoryRecord;
};

export const PaymentRow: React.FC<PaymentRowProps> = ({ record }) => {
  const amount = getHistoryAmount(record);
  const statusInfo = getHistoryStatus(record);
  const displayTimestamp = getHistoryDisplayTimestamp(record);
  const updatedAt = formatPaymentUpdatedAt(displayTimestamp ?? undefined);
  const identifier = getHistoryIdentifier(record);
  const prefix = record.direction === "received" ? "+ " : record.direction === "sent" ? "- " : undefined;

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text
          style={[
            styles.statusPill,
            { backgroundColor: `${statusInfo.color}22`, color: statusInfo.color },
          ]}
        >
          {statusInfo.label}
        </Text>
        {updatedAt ? <Text style={styles.metaText}>{updatedAt}</Text> : null}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.amountText}>{formatSatsValue(amount, { prefix })}</Text>
        <Text style={styles.hashText} numberOfLines={1}>
          {identifier}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    gap: 8,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  metaText: {
    fontSize: 12,
    color: "#94a3b8",
  },
  rowBody: {
    gap: 4,
  },
  amountText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1f2937",
  },
  hashText: {
    fontSize: 12,
    color: "#64748b",
  },
});
