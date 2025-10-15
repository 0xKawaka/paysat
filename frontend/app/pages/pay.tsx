import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import {
  BTC_TOKEN_ADDRESS,
  BTC_TOKEN_DECIMALS,
  ESCROW_CONTRACT_ADDRESS,
} from "../config/constants";
import { useStarknetConnector } from "../context/StarknetConnector";
import { useTokenBalance } from "../hooks/useTokenBalance";
import { formatUnits } from "../utils/token/format";
import {
  lockLightningPayment,
  parseLightningInvoice,
  type ParsedInvoice,
} from "../services/lightningPayment";

type SubmissionStage = "idle" | "locking" | "waiting" | "paying" | "complete";

const formatInvoiceAmount = (amountSats: bigint) => ({
  btc: formatUnits(amountSats, 8),
  sats: amountSats.toString(),
});

export default function PayPage() {
  const { account, provider } = useStarknetConnector();
  const [invoiceInput, setInvoiceInput] = useState("");
  const [parsedInvoice, setParsedInvoice] = useState<ParsedInvoice | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [stage, setStage] = useState<SubmissionStage>("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [payResponse, setPayResponse] = useState<any | null>(null);
  const [paidAmountSats, setPaidAmountSats] = useState<bigint | null>(null);

  const { balance, refresh: refreshBalance } = useTokenBalance(
    BTC_TOKEN_ADDRESS,
    {
      decimals: BTC_TOKEN_DECIMALS,
      watch: true,
    }
  );

  const balanceValue = balance ?? 0n;

  const invoiceSummary = useMemo(() => {
    if (!parsedInvoice) return null;
    return formatInvoiceAmount(parsedInvoice.amountSats);
  }, [parsedInvoice]);

  const timeLeftSeconds = useMemo(() => {
    if (!parsedInvoice?.expiresAt) return Infinity;
    return parsedInvoice.expiresAt - Math.floor(Date.now() / 1000);
  }, [parsedInvoice]);

  const expiresSoon = useMemo(() => {
    return timeLeftSeconds <= 3600; // 1 hour
  }, [timeLeftSeconds]);

  const hasSufficientBalance = useMemo(() => {
    if (!parsedInvoice) return false;
    return balanceValue >= parsedInvoice.amountSats;
  }, [balanceValue, parsedInvoice]);

  const missingEscrowAddress = !ESCROW_CONTRACT_ADDRESS;

  const statusMessage = useMemo(() => {
    switch (stage) {
      case "locking":
        return "Submitting lock transaction";
      case "waiting":
        return "Waiting for Starknet confirmation";
      case "paying":
        return "Triggering Lightning payment";
      case "complete":
        return "Payment completed";
      default:
        return null;
    }
  }, [stage]);

  const handleInvoiceChange = (value: string) => {
    setInvoiceInput(value);
    setParsedInvoice(null);
    setParseError(null);
    setSubmitError(null);
    setStage("idle");
    setTxHash(null);
    setPayResponse(null);

    if (!value.trim()) {
      return;
    }

    try {
      const parsed = parseLightningInvoice(value);
      setParsedInvoice(parsed);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to decode invoice";
      setParseError(message);
    }
  };

  const handleSubmit = async () => {
    if (!parsedInvoice) {
      setSubmitError("Decode a valid Lightning invoice first");
      return;
    }

    if (!account || !provider) {
      setSubmitError("Connect a Starknet account before paying");
      return;
    }

    if (missingEscrowAddress) {
      setSubmitError("Escrow contract address is not configured");
      return;
    }

    if (!hasSufficientBalance) {
      setSubmitError("Insufficient BTC balance for this invoice");
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setStage("locking");
    setTxHash(null);
    setPayResponse(null);
    setPaidAmountSats(null);

    try {
      const { transactionHash } = await lockLightningPayment({
        account,
        provider,
        parsedInvoice,
        escrowContractAddress: ESCROW_CONTRACT_ADDRESS,
        maxFee: 100_000_000_000_000n,
        onTransactionSent: (hash) => {
          setTxHash(hash);
          setStage("waiting");
        },
      });

      setStage("paying");
      const response = await fetch(process.env.EXPO_PUBLIC_APP_API_URL + "/pay", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transaction_hash: transactionHash,
          bolt11: parsedInvoice.raw,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          payload?.message || payload?.error || "Lightning payment failed";
        throw new Error(message);
      }

      setPayResponse(payload);
      setPaidAmountSats(parsedInvoice.amountSats);
      setStage("complete");
      await refreshBalance();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Payment failed unexpectedly";
      setSubmitError(message);
      setStage("idle");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {stage === "idle" && !parsedInvoice ? (
        <View style={styles.heroCard}>
          <Text style={styles.heroTitle}>Pay Lightning Invoice</Text>
          <TextInput
            style={styles.input}
            multiline
            placeholder="Paste BOLT11 invoice"
            placeholderTextColor="#94a3b8"
            value={invoiceInput}
            onChangeText={handleInvoiceChange}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {parseError ? (
            <Text style={styles.errorText}>{parseError}</Text>
          ) : null}
        </View>
      ) : null}

      {stage === "idle" && parsedInvoice ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment Amount</Text>
          <View style={styles.amountContainer}>
            <Text style={styles.amountBtc}>{invoiceSummary?.btc} BTC</Text>
            <Text style={styles.amountSats}>{invoiceSummary?.sats} sats</Text>
          </View>
          {parsedInvoice.description ? (
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Memo</Text>
              <Text style={styles.summaryValue}>{parsedInvoice.description}</Text>
            </View>
          ) : null}
          {parsedInvoice.payee ? (
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Payee</Text>
              <Text style={styles.summaryMono}>
                {`${parsedInvoice.payee.slice(0, 8)}…${parsedInvoice.payee.slice(-8)}`}
              </Text>
            </View>
          ) : null}

          {submitError ? (
            <Text style={styles.errorText}>{submitError}</Text>
          ) : null}
          {!hasSufficientBalance ? (
            <Text style={styles.errorText}>
              Insufficient balance to pay this invoice.
            </Text>
          ) : null}
          {expiresSoon ? (
            <Text style={styles.errorText}>
              {timeLeftSeconds <= 0
                ? "This invoice has expired."
                : "This invoice has less than 1 hour remaining."}
            </Text>
          ) : null}
          {missingEscrowAddress ? (
            <Text style={styles.errorText}>
              Escrow contract address is not configured in the app settings.
            </Text>
          ) : null}
          <Pressable
            style={[
              styles.primaryButton,
              (isSubmitting ||
                !parsedInvoice ||
                parseError !== null ||
                !hasSufficientBalance ||
                expiresSoon ||
                missingEscrowAddress) && styles.primaryButtonDisabled,
            ]}
            onPress={handleSubmit}
            disabled={
              isSubmitting ||
              !parsedInvoice ||
              parseError !== null ||
              !hasSufficientBalance ||
              expiresSoon ||
              missingEscrowAddress
            }
          >
            {isSubmitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.primaryButtonText}>Pay</Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {stage !== "idle" && stage !== "complete" ? (
        <View style={styles.loaderCard}>
          <ActivityIndicator size="large" color="#2563eb" />
          <Text style={styles.loaderTitle}>Processing Payment</Text>
          <Text style={styles.loaderSubtitle}>{statusMessage}</Text>
          <View style={styles.steps}>
            {renderStep("Lock funds on Starknet", stage, "locking")}
            {renderStep("Wait for Starknet confirmation", stage, "waiting")}
            {renderStep("Pay invoice via Lightning", stage, "paying")}
          </View>
        </View>
      ) : null}

      {stage === "complete" ? (
        <View style={styles.successCard}>
          <Ionicons name="checkmark-circle" size={64} color="#16a34a" />
          <Text style={styles.successTitle}>Payment Success</Text>
          <Text style={styles.successAmount}>
            {paidAmountSats
              ? `${formatUnits(paidAmountSats, 8)} BTC · ${paidAmountSats.toString()} sats`
              : parsedInvoice
              ? `${formatUnits(parsedInvoice.amountSats, 8)} BTC · ${parsedInvoice.amountSats.toString()} sats`
              : ""}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    gap: 24,
    paddingBottom: 48,
  },
  heroCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginHorizontal: 2,
    gap: 12,
    minHeight: 260,
  },
  heroTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#0f172a",
  },
  heroSubtitle: {
    fontSize: 14,
    color: "#64748b",
  },
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginHorizontal: 2,
    gap: 12,
    minHeight: 260,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1f2937",
  },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 12,
    padding: 12,
    color: "#0f172a",
    backgroundColor: "#f8fafc",
    textAlignVertical: "top",
  },
  errorText: {
    color: "#dc2626",
    fontSize: 14,
  },
  amountContainer: {
    marginTop: 4,
    marginBottom: 8,
    gap: 2,
  },
  amountBtc: {
    fontSize: 28,
    fontWeight: "800",
    color: "#0f172a",
  },
  amountSats: {
    fontSize: 13,
    color: "#475569",
  },
  summaryItem: {
    flexDirection: "column",
    gap: 4,
  },
  summaryLabel: {
    fontSize: 14,
    color: "#64748b",
  },
  summaryValue: {
    fontSize: 15,
    color: "#1f2937",
  },
  summaryMono: {
    fontSize: 13,
    color: "#334155",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  primaryButton: {
    marginHorizontal: 2,
    borderRadius: 12,
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    alignItems: "center",
    paddingHorizontal: 20,
  },
  primaryButtonDisabled: {
    opacity: 0.4,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  loaderCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginHorizontal: 2,
    alignItems: "center",
    gap: 10,
    minHeight: 260,
  },
  loaderTitle: {
    marginTop: 8,
    fontSize: 18,
    fontWeight: "700",
    color: "#0f172a",
  },
  loaderSubtitle: {
    fontSize: 14,
    color: "#64748b",
  },
  steps: {
    width: "100%",
    marginTop: 8,
    gap: 8,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#e2e8f0",
  },
  stepDotActive: {
    backgroundColor: "#2563eb",
  },
  stepDotDone: {
    backgroundColor: "#22c55e",
  },
  stepText: {
    color: "#475569",
  },
  stepTextActive: {
    color: "#0f172a",
    fontWeight: "600",
  },
  successCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginHorizontal: 2,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 260,
  },
  successTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#166534",
    textAlign: "center",
  },
  successAmount: {
    fontSize: 16,
    color: "#14532d",
    textAlign: "center",
  },
});

function renderStep(
  label: string,
  stage: SubmissionStage,
  self: SubmissionStage
) {
  const order: SubmissionStage[] = ["locking", "waiting", "paying", "complete"];
  const idxSelf = order.indexOf(self);
  const idxStage = order.indexOf(stage);
  const isActive = stage === self;
  const isDone = idxStage > idxSelf;

  return (
    <View style={styles.stepRow} key={self}>
      <View
        style={[
          styles.stepDot,
          isActive && styles.stepDotActive,
          isDone && styles.stepDotDone,
        ]}
      />
      <Text style={[styles.stepText, isActive && styles.stepTextActive]}>{label}</Text>
    </View>
  );
}
