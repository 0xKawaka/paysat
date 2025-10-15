import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { BTC_TOKEN_ADDRESS, BTC_TOKEN_DECIMALS, BTC_TOKEN_SYMBOL } from "../config/constants";
import { useTokenBalance } from "../hooks/useTokenBalance";

export type UserTokenBalanceCardProps = {
  tokenAddress?: string;
  decimals?: number;
  tokenSymbol?: string;
  watchIntervalMs?: number;
};

export const UserTokenBalanceCard: React.FC<UserTokenBalanceCardProps> = ({
  tokenAddress = BTC_TOKEN_ADDRESS,
  decimals = BTC_TOKEN_DECIMALS,
  tokenSymbol = BTC_TOKEN_SYMBOL,
  watchIntervalMs,
}) => {
  const { balance, formattedBalance, isLoading } = useTokenBalance(
    tokenAddress,
    {
      decimals,
      watch: true,
      watchIntervalMs,
    },
  );

  const displayBalance =
    formattedBalance ?? (balance !== null ? balance.toString() : "—");
  const showLoadingIndicator = isLoading && balance === null;

  return (
    <View style={styles.card}>
      <View style={styles.balanceRow}>
        <Text style={styles.balanceValue}>{displayBalance}</Text>
        <Text style={styles.symbol}>{tokenSymbol}</Text>
        {showLoadingIndicator ? (
          <ActivityIndicator size="small" color="#2563eb" />
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    width: "100%",
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  balanceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  balanceValue: {
    color: "#1a202c",
    fontSize: 24,
    fontWeight: "700",
  },
  symbol: {
    color: "#64748b",
    fontSize: 24,
    fontWeight: "700",
    textTransform: "uppercase",
  },
});
