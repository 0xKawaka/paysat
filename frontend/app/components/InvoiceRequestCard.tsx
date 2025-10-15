import React, { useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import QRCode from "react-native-qrcode-svg";

export type InvoiceRequestCardProps = {
  accountAddress: string;
};

type InvoiceResponse = {
  label: string;
  bolt11: string;
  expires_at: number;
  desc_visible_to_payer: boolean;
  amount_sats?: string;
};

export const InvoiceRequestCard: React.FC<InvoiceRequestCardProps> = ({
  accountAddress,
}) => {
  const [amountBtc, setAmountBtc] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<InvoiceResponse | null>(null);
  const [createdAmount, setCreatedAmount] = useState<
    { btc: string; sats: string } | null
  >(null);

  const handleCreateInvoice = async () => {
    if (!accountAddress) {
      setError("Connect a Starknet account to create an invoice.");
      return;
    }

    const trimmedAmount = amountBtc.trim();
    if (!/^\d*(\.\d{0,8})?$/.test(trimmedAmount) || trimmedAmount === "") {
      setError("Enter a valid BTC amount (up to 8 decimals).");
      return;
    }

    const satsAmount = (() => {
      const [whole, fraction = ""] = trimmedAmount.split(".");
      const wholePart = BigInt(whole || "0") * 1_0000_0000n;
      const fractionPadded = (fraction + "00000000").slice(0, 8);
      return wholePart + BigInt(fractionPadded);
    })();

    if (satsAmount <= 0n) {
      setError("Amount must be greater than zero.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const satsString = satsAmount.toString();
      const response = await fetch(process.env.EXPO_PUBLIC_APP_API_URL + "/invoice", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          starknet_address: accountAddress,
          amount_sat: satsString,
          ttl_seconds: 86400,
          private_desc: true,
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          (payload && payload.error) || "Failed to create invoice.";
        setError(message);
        setInvoice(null);
        return;
      }

      if (!payload) {
        throw new Error("Unexpected response format.");
      }
      const invoiceWithAmount: InvoiceResponse = {
        ...(payload as InvoiceResponse),
        amount_sats: satsString,
      };

      const withinSafeRange = satsAmount <= BigInt(Number.MAX_SAFE_INTEGER);
      const satsDisplay = withinSafeRange
        ? Number(satsAmount).toLocaleString()
        : satsString;
      const btcDisplay = (() => {
        if (withinSafeRange) {
          return (Number(satsAmount) / 1e8).toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 8,
          });
        }
        const integerPart = satsAmount / 100_000_000n;
        const fractionalPart = satsAmount % 100_000_000n;
        if (fractionalPart === 0n) {
          return integerPart.toString();
        }
        const fractionalStr = fractionalPart
          .toString()
          .padStart(8, '0')
          .replace(/0+$/, '');
        return `${integerPart.toString()}.${fractionalStr}`;
      })();

      setInvoice(invoiceWithAmount);
      setCreatedAmount({
        btc: btcDisplay,
        sats: satsDisplay,
      });
      setError(null);
      Keyboard.dismiss();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || "Unexpected error creating invoice.");
      setInvoice(null);
      setCreatedAmount(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleShareInvoice = async () => {
    if (!invoice) return;

    try {
      await Share.share({
        title: "Lightning invoice",
        message: invoice.bolt11,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || "Unable to share invoice.");
    }
  };

  return (
    <View style={styles.card}>
      {invoice ? (
        <>
          <Text style={styles.cardTitle}>Lightning invoice</Text>
          {createdAmount ? (
            <Text style={styles.amountSummary}>
              {createdAmount.btc} BTC · {createdAmount.sats} sats
            </Text>
          ) : null}
          <View style={styles.qrSection}>
            <QRCode value={invoice.bolt11} size={200} backgroundColor="#ffffff" />
            <Text style={styles.qrCaption}>Scan to pay</Text>
          </View>
          <Pressable
            style={styles.secondaryButton}
            onPress={handleShareInvoice}
          >
            <Text style={styles.secondaryButtonText}>Share invoice</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.cardTitle}>Create lightning invoice</Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Amount (BTC)</Text>
            <TextInput
              style={styles.input}
              keyboardType="decimal-pad"
              placeholder="0.0001"
              placeholderTextColor="#94a3b8"
              value={amountBtc}
              onChangeText={setAmountBtc}
            />
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Pressable
            style={[styles.button, isSubmitting ? styles.buttonDisabled : null]}
            onPress={handleCreateInvoice}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
            <Text style={styles.buttonText}>Create invoice</Text>
            )}
          </Pressable>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 20,
    gap: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#1a202c",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  cardTitle: {
    color: "#1a202c",
    fontSize: 18,
    fontWeight: "700",
  },
  amountSummary: {
    marginTop: -6,
    color: "#475569",
    fontSize: 14,
    fontWeight: "600",
  },
  fieldGroup: {
    gap: 8,
  },
  label: {
    color: "#4a5568",
    fontSize: 14,
    fontWeight: "600",
  },
  input: {
    backgroundColor: "#f8fafc",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#cbd5e0",
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: "#1a202c",
    fontSize: 16,
  },
  button: {
    marginTop: 8,
    backgroundColor: "#2563eb",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 16,
  },
  errorText: {
    color: "#f87171",
    fontSize: 14,
  },
  qrSection: {
    marginTop: 12,
    alignItems: "center",
    gap: 12,
  },
  qrCaption: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "500",
  },
  secondaryButton: {
    marginTop: 12,
    backgroundColor: "#eef2ff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#cbd5f5",
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: "#2563eb",
    fontWeight: "600",
    fontSize: 15,
  },
  helperText: {
    marginTop: 4,
    color: "#64748b",
    fontSize: 12,
  },
});
