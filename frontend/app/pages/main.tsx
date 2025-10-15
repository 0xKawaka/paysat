import React, { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { UserTokenBalanceCard } from "../components/UserTokenBalanceCard";
import { InvoiceRequestCard } from "../components/InvoiceRequestCard";
import { RecentPaymentsCard } from "../components/RecentPaymentsCard";
import { useStarknetConnector } from "../context/StarknetConnector";
import { WalletAccessPanel } from "./login";
import PayPage from "./pay";
import type { HistoryRecord } from "../services/payments";
import { fetchPaymentHistoryByAddress } from "../services/payments";

const shortenAddress = (address: string) => {
  if (!address) {
    return "";
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

type MainPageProps = {
  activeMode?: "home" | "invoice" | "pay";
  onModeChange?: (mode: "home" | "invoice" | "pay") => void;
};

export default function MainPage({ activeMode = "home", onModeChange }: MainPageProps = {}) {
  const { account, disconnectAccount } = useStarknetConnector();
  const [activeAction, setActiveAction] = useState<string | null>(() => {
    if (activeMode === "invoice") return "invoice";
    if (activeMode === "pay") return "pay";
    return null;
  });
  const [recentHistory, setRecentHistory] = useState<HistoryRecord[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Action buttons are provided by the bottom navigation bar; no in-page actions here.

  useEffect(() => {
    if (activeMode === "invoice" && activeAction !== "invoice") {
      setActiveAction("invoice");
    } else if (activeMode === "pay" && activeAction !== "pay") {
      setActiveAction("pay");
    } else if (activeMode === "home" && activeAction !== null) {
      setActiveAction(null);
    }
  }, [activeMode, activeAction]);

  useEffect(() => {
    let active = true;

    if (!account?.address) {
      setRecentHistory([]);
      setPaymentsError(null);
      setPaymentsLoading(false);
      return () => {
        active = false;
      };
    }

    const load = async () => {
      setPaymentsLoading(true);
      setPaymentsError(null);
      try {
        const history = await fetchPaymentHistoryByAddress(account.address);
        if (active) {
          setRecentHistory(history.slice(0, 3));
        }
      } catch (err) {
        if (active) {
          const message = err instanceof Error ? err.message : String(err);
          setPaymentsError(message || "Unable to fetch payments.");
          setRecentHistory([]);
        }
      } finally {
        if (active) {
          setPaymentsLoading(false);
        }
      }
    };

    load();

    return () => {
      active = false;
    };
  }, [account?.address, reloadKey]);

  const handleRetryFetchHistory = useCallback(() => {
    if (!account?.address) return;
    setReloadKey((key) => key + 1);
  }, [account?.address]);

  // Navigation to actions is handled via BottomNavBar in index.tsx

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

  if (activeAction) {
    return (
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.actionScreenContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {activeAction === "invoice" ? (
            <InvoiceRequestCard accountAddress={account.address} />
          ) : null}
          {activeAction === "pay" ? <PayPage /> : null}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.connectedContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerCard}>
          <View style={styles.headerTopRow}>
            <View style={styles.accountMeta}>
              <Text style={styles.accountAddress}>
                {shortenAddress(account.address)}
              </Text>
            </View>
            <Pressable
              style={styles.disconnectButton}
              onPress={disconnectAccount}
            >
              <Text style={styles.disconnectButtonText}>Disconnect</Text>
            </Pressable>
          </View>

          <View style={styles.balanceSection}>
            <UserTokenBalanceCard />
          </View>
        </View>

        <RecentPaymentsCard
          records={recentHistory}
          isLoading={paymentsLoading}
          error={paymentsError}
          onRetry={account?.address ? handleRetryFetchHistory : undefined}
        />

        {/* In-page action buttons removed to avoid duplication with bottom bar */}

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
  connectedContent: {
    flexGrow: 1,
    gap: 24,
    paddingBottom: 48,
  },
  headerCard: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 16,
    paddingVertical: 20,
    paddingHorizontal: 20,
    gap: 20,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#1a202c",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  headerTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
  },
  accountMeta: {
    flex: 1,
    gap: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#4a5568",
  },
  balanceSection: {
    gap: 12,
  },
  accountAddress: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a202c",
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd5e0",
  },
  disconnectButton: {
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  disconnectButtonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 14,
  },
  actionMenu: {
    width: "100%",
    flexDirection: "row",
    gap: 16,
  },
  actionItem: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 12,
    shadowColor: "#1a202c",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  actionItemActive: {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  actionLabel: {
    color: "#475569",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "left",
  },
  actionLabelActive: {
    color: "#ffffff",
  },
  actionScreenContent: {
    flexGrow: 1,
    gap: 24,
    paddingBottom: 48,
  },
});
