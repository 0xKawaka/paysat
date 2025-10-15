import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { APP_NAME } from "../config/app";
import { useStarknetConnector } from "../context/StarknetConnector";

type StoredAccount = {
  key: string;
  network: string;
  accountClassName: string;
  address: string;
};

type WalletAccessPanelProps = {
  appName?: string;
};

const shortenAddress = (address: string) => {
  if (!address) {
    return "";
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

export const WalletAccessPanel: React.FC<WalletAccessPanelProps> = ({
  appName = APP_NAME,
}) => {
  const {
    STARKNET_ENABLED,
    getAvailableKeys,
    connectStorageAccount,
    generatePrivateKey,
    generateAccountAddress,
    storeKeyAndConnect,
  } = useStarknetConnector();

  const [storedAccounts, setStoredAccounts] = useState<StoredAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [pendingAccountKey, setPendingAccountKey] = useState<string | null>(
    null,
  );
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  const parseAccountKey = useCallback((key: string): StoredAccount | null => {
    const parts = key.split(".");
    if (parts.length < 4) {
      return null;
    }

    const [network, , accountClassName, address] = parts;
    return {
      key,
      network,
      accountClassName,
      address,
    };
  }, []);

  const refreshStoredAccounts = useCallback(async () => {
    if (!STARKNET_ENABLED) {
      setStoredAccounts([]);
      return;
    }

    setLoadingAccounts(true);
    setAccountError(null);

    try {
      const keys = await getAvailableKeys(appName);
      const parsed = keys
        .map(parseAccountKey)
        .filter((account): account is StoredAccount => Boolean(account));
      setStoredAccounts(parsed);
    } catch (error) {
      console.error("Failed to load saved accounts", error);
      setAccountError("Unable to load saved accounts. Please try again.");
    } finally {
      setLoadingAccounts(false);
    }
  }, [STARKNET_ENABLED, getAvailableKeys, parseAccountKey, appName]);

  useEffect(() => {
    refreshStoredAccounts();
  }, [refreshStoredAccounts]);

  const handleConnectStoredAccount = useCallback(
    
    async (key: string) => {
      setPendingAccountKey(key);
      setAccountError(null);
      try {
        await connectStorageAccount(key);
      } catch (error) {
        console.error("Failed to connect account", error);
        setAccountError("Could not connect to the selected account.");
      } finally {
        setPendingAccountKey(null);
      }
    },
    [connectStorageAccount],
  );

  const handleCreateAccount = useCallback(async () => {
    if (!STARKNET_ENABLED) {
      return;
    }

    setIsCreatingAccount(true);
    setAccountError(null);
    try {
      const privateKey = generatePrivateKey();
      if (!privateKey) {
        throw new Error("Failed to generate account key");
      }
      const accountAddress = generateAccountAddress(privateKey);
      await storeKeyAndConnect(privateKey, appName);
      if (__DEV__) {
        console.log("Created account", accountAddress);
      }
      await refreshStoredAccounts();
    } catch (error) {
      console.error("Failed to create account", error);
      setAccountError("Unable to create a new account. Please try again.");
    } finally {
      setIsCreatingAccount(false);
    }
  }, [
    STARKNET_ENABLED,
    generatePrivateKey,
    generateAccountAddress,
    storeKeyAndConnect,
    appName,
    refreshStoredAccounts,
  ]);

  if (!STARKNET_ENABLED) {
    return (
      <View style={panelStyles.disabledContainer}>
        <Text style={panelStyles.title}>Account login unavailable</Text>
        <Text style={panelStyles.description}>
          Starknet connectivity is disabled for this build. Please enable
          Starknet support or switch to a build with account features enabled.
        </Text>
      </View>
    );
  }

  return (
    <View style={panelStyles.panelContainer}>
      <Text style={panelStyles.title}>Connect your account</Text>

      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionTitle}>Saved accounts</Text>
        {loadingAccounts ? (
          <ActivityIndicator color="#2563eb" />
        ) : storedAccounts.length === 0 ? (
          <Text style={panelStyles.mutedText}>No accounts saved yet.</Text>
        ) : (
          storedAccounts.map((savedAccount) => (
            <Pressable
              key={savedAccount.key}
              style={panelStyles.walletButton}
              onPress={() => handleConnectStoredAccount(savedAccount.key)}
              disabled={pendingAccountKey !== null}
            >
              <View style={panelStyles.walletMeta}>
                <Text style={panelStyles.walletAddress}>
                  {shortenAddress(savedAccount.address)}
                </Text>
                <Text style={panelStyles.walletDetails}>
                  {savedAccount.network} · {savedAccount.accountClassName}
                </Text>
              </View>
              {pendingAccountKey === savedAccount.key ? (
                <ActivityIndicator size="small" color="#2563eb" />
              ) : (
                <Text style={panelStyles.walletAction}>Connect</Text>
              )}
            </Pressable>
          ))
        )}
        {accountError ? (
          <Text style={panelStyles.errorText}>{accountError}</Text>
        ) : null}
      </View>

      <Pressable
        style={[panelStyles.secondaryButton, isCreatingAccount && panelStyles.disabled]}
        onPress={handleCreateAccount}
        disabled={isCreatingAccount}
      >
        {isCreatingAccount ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={panelStyles.secondaryButtonText}>
            Create a new account
          </Text>
        )}
      </Pressable>
    </View>
  );
};

const LoginPage: React.FC = () => {
  return (
    <KeyboardAvoidingView
      style={loginStyles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={loginStyles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <WalletAccessPanel />
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

export default LoginPage;

const loginStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  scrollContent: {
    paddingBottom: 48,
    gap: 24,
  },
});

const panelStyles = StyleSheet.create({
  panelContainer: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 20,
    gap: 24,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#1a202c",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  disabledContainer: {
    flex: 1,
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#1a202c",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#1a202c",
    marginBottom: 8,
  },
  description: {
    color: "#4a5568",
    fontSize: 14,
    lineHeight: 20,
  },
  section: {
    backgroundColor: "#f8fafc",
    borderRadius: 14,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a202c",
  },
  mutedText: {
    color: "#64748b",
    fontSize: 14,
  },
  walletButton: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#1a202c",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 1,
  },
  walletMeta: {
    gap: 4,
  },
  walletAddress: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a202c",
  },
  walletDetails: {
    color: "#64748b",
    fontSize: 12,
  },
  walletAction: {
    color: "#2563eb",
    fontWeight: "600",
  },
  secondaryButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: "#2563eb",
    shadowColor: "#1a202c",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  secondaryButtonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 16,
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
  },
  disabled: {
    opacity: 0.6,
  },
});
