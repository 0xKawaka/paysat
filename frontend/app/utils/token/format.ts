const UINT_128 = 2n ** 128n;

export const parseUint256 = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return 0n;
    return BigInt(trimmed);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 0n;
    }
    if (value.length === 1) {
      return parseUint256(value[0]);
    }
    const low = parseUint256(value[0]);
    const high = parseUint256(value[1]);
    return high * UINT_128 + low;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    if ("low" in record && "high" in record) {
      const low = parseUint256(record.low);
      const high = parseUint256(record.high);
      return high * UINT_128 + low;
    }

    const candidateKeys = ["balance", "amount", "value", "result"] as const;
    for (const key of candidateKeys) {
      if (key in record) {
        return parseUint256(record[key]);
      }
    }
  }

  throw new Error("Unsupported uint256 format");
};

export const formatUnits = (value: bigint, decimals: number): string => {
  if (decimals <= 0) {
    return value.toString();
  }

  const base = 10n ** BigInt(decimals);
  const integerPart = value / base;
  const fractionPart = value % base;

  if (fractionPart === 0n) {
    return integerPart.toString();
  }

  const fraction = fractionPart
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return `${integerPart.toString()}.${fraction}`;
};
