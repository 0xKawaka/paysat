import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useStarknetConnector } from "../context/StarknetConnector";
import type { HistoryRecord } from "../services/payments";
import { fetchPaymentHistoryByAddress } from "../services/payments";
import { PaymentRow } from "../components/PaymentRow";
import { getHistoryIdentifier } from "../utils/paymentsFormatting";
import { WalletAccessPanel } from "./login";

type PaymentsPageProps = {
  isActive?: boolean;
};

export default function PaymentsPage({ isActive = true }: PaymentsPageProps = {}) {
  const { account } = useStarknetConnector();
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadPayments = useCallback(
    async (opts?: { silent?: boolean }) => {
      const address = account?.address;
      if (!address) {
        if (!isMountedRef.current) return;
        setHistory([]);
        setLoading(false);
        setRefreshing(false);
        setError(null);
        return;
      }

      if (!isMountedRef.current) return;

      if (opts?.silent) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const records = await fetchPaymentHistoryByAddress(address);
        if (!isMountedRef.current) return;
        setHistory(records);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isMountedRef.current) return;
        setError(message || "Unable to load payments.");
        setHistory([]);
      } finally {
        if (!isMountedRef.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [account?.address],
  );

  useEffect(() => {
    if (isActive) {
      loadPayments();
    }
  }, [isActive, loadPayments]);

  const handleRefresh = useCallback(() => {
    loadPayments({ silent: true });
  }, [loadPayments]);

  const content = useMemo(() => {
    if (loading && history.length === 0 && !error) {
      return (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color="#2563eb" />
        </View>
      );
    }

    if (error) {
      return (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>Unable to load payments</Text>
          <Text style={styles.stateSubtitle}>{error}</Text>
          <Text style={styles.stateAction} onPress={handleRefresh}>
            Tap to retry
          </Text>
        </View>
      );
    }

    if (history.length === 0) {
      return (
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>No payments or invoices yet</Text>
          <Text style={styles.stateSubtitle}>
            As you create invoices and process claims, lightning and Starknet
            history will appear here.
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.list}>
        {history.map((entry, index) => {
          const key = getHistoryIdentifier(entry) || entry.id || `history-${index}`;
          return <PaymentRow key={key} record={entry} />;
        })}
      </View>
    );
  }, [error, handleRefresh, loading, history]);

  if (!account) {
    return (
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.authContent}
          showsVerticalScrollIndicator={false}
        >
          <WalletAccessPanel />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#2563eb"
          />
        }
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Payment history</Text>
          <Text style={styles.headerSubtitle}>
            All sent payments and received invoices linked to your connected Starknet account.
          </Text>
        </View>
        {content}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  authContent: {
    gap: 24,
    paddingBottom: 48,
  },
  content: {
    flexGrow: 1,
    gap: 24,
    paddingBottom: 48,
  },
  header: {
    gap: 8,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: "#0f172a",
  },
  headerSubtitle: {
    fontSize: 15,
    color: "#475569",
    lineHeight: 20,
  },
  centeredState: {
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 80,
  },
  stateCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    padding: 24,
    gap: 12,
  },
  stateTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1f2937",
  },
  stateSubtitle: {
    fontSize: 14,
    color: "#64748b",
    lineHeight: 20,
  },
  stateAction: {
    fontSize: 14,
    fontWeight: "600",
    color: "#2563eb",
  },
  list: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    padding: 20,
    gap: 16,
  },
});
