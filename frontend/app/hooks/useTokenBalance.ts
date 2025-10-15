import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Contract } from "starknet";

import { useStarknetConnector } from "../context/StarknetConnector";
import { formatUnits, parseUint256 } from "../utils/token/format";

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balance_of",
    state_mutability: "view",
    inputs: [
      {
        name: "account",
        type: "core::starknet::contract_address::ContractAddress",
      },
    ],
    outputs: [
      {
        type: "core::integer::u256",
      },
    ],
  },
] as const;

const normalizeAddress = (value?: string | null): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

type BalanceCacheEntry = {
  balance: bigint | null;
  error: string | null;
  lastUpdatedAt: number | null;
  isLoading: boolean;
};

const balanceCache = new Map<string, BalanceCacheEntry>();

const getCacheKey = (
  tokenAddress: string | null,
  accountAddress: string | null,
): string | null => {
  if (!tokenAddress || !accountAddress) {
    return null;
  }
  return `${tokenAddress.toLowerCase()}::${accountAddress.toLowerCase()}`;
};

export type UseTokenBalanceOptions = {
  accountAddress?: string;
  decimals?: number;
  enabled?: boolean;
  watch?: boolean;
  watchIntervalMs?: number;
};

export type UseTokenBalanceResult = {
  balance: bigint | null;
  formattedBalance: string | null;
  isLoading: boolean;
  error: string | null;
  lastUpdatedAt: number | null;
  refresh: () => Promise<bigint | null>;
};

const DEFAULT_WATCH_INTERVAL = 15_000;

export const useTokenBalance = (
  tokenAddress: string,
  options: UseTokenBalanceOptions = {},
): UseTokenBalanceResult => {
  const {
    accountAddress: overrideAccount,
    decimals,
    enabled = true,
    watch = false,
    watchIntervalMs = DEFAULT_WATCH_INTERVAL,
  } = options;

  const { STARKNET_ENABLED, account, provider } = useStarknetConnector();

  const normalizedTokenAddress = normalizeAddress(tokenAddress);
  const resolvedAccountAddress = normalizeAddress(
    overrideAccount ?? account?.address ?? null,
  );
  const cacheKey = getCacheKey(normalizedTokenAddress, resolvedAccountAddress);

  const cachedStateRef = useRef<BalanceCacheEntry | null>(
    cacheKey ? balanceCache.get(cacheKey) ?? null : null,
  );

  const [balance, setBalance] = useState<bigint | null>(() =>
    cachedStateRef.current?.balance ?? null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(
    cachedStateRef.current?.isLoading ?? false,
  );
  const [error, setError] = useState<string | null>(
    cachedStateRef.current?.error ?? null,
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(
    cachedStateRef.current?.lastUpdatedAt ?? null,
  );
  const latestRequestRef = useRef(0);

  useEffect(() => {
    cachedStateRef.current = cacheKey
      ? balanceCache.get(cacheKey) ?? null
      : null;

    if (!cachedStateRef.current) {
      setBalance(null);
      setError(null);
      setLastUpdatedAt(null);
      setIsLoading(false);
      return;
    }

    const {
      balance: cachedBalance,
      error: cachedError,
      lastUpdatedAt: cachedUpdatedAt,
      isLoading: cachedLoading,
    } = cachedStateRef.current;

    setBalance(cachedBalance);
    setError(cachedError);
    setLastUpdatedAt(cachedUpdatedAt);
    setIsLoading(cachedLoading);
  }, [cacheKey]);

  const writeCache = useCallback(
    (nextEntry: BalanceCacheEntry | null) => {
      if (!cacheKey) {
        return;
      }
      if (nextEntry) {
        balanceCache.set(cacheKey, nextEntry);
        cachedStateRef.current = nextEntry;
      } else {
        balanceCache.delete(cacheKey);
        cachedStateRef.current = null;
      }
    },
    [cacheKey],
  );

  const contract = useMemo(() => {
    if (!provider || !normalizedTokenAddress) {
      return null;
    }

    try {
      return new Contract(BALANCE_OF_ABI as any, normalizedTokenAddress, provider);
    } catch (contractError) {
      if (__DEV__) {
        console.error(
          "Failed to initialise balance_of contract",
          normalizedTokenAddress,
          contractError,
        );
      }
      return null;
    }
  }, [normalizedTokenAddress, provider]);

  const refresh = useCallback(async () => {
    if (!enabled || !STARKNET_ENABLED) {
      setBalance(null);
      setError(null);
      setLastUpdatedAt(null);
      setIsLoading(false);
      writeCache(null);
      return null;
    }

    if (!contract || !resolvedAccountAddress) {
      // Keep the last known balance when we momentarily miss dependencies.
      setIsLoading(false);
      writeCache(
        cachedStateRef.current
          ? { ...cachedStateRef.current, isLoading: false }
          : null,
      );
      return null;
    }

    latestRequestRef.current += 1;
    const requestId = latestRequestRef.current;

    setIsLoading(true);
    setError(null);

    const previous = cachedStateRef.current;
    if (previous) {
      writeCache({ ...previous, error: null, isLoading: true });
    } else {
      writeCache({
        balance: null,
        error: null,
        lastUpdatedAt: null,
        isLoading: true,
      });
    }

    try {
      const response = await contract.balance_of(resolvedAccountAddress);
      const parsedBalance = parseUint256(response);

      if (latestRequestRef.current === requestId) {
        const now = Date.now();
        setBalance(parsedBalance);
        setLastUpdatedAt(now);
        writeCache({
          balance: parsedBalance,
          error: null,
          lastUpdatedAt: now,
          isLoading: true,
        });
      }

      return parsedBalance;
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : String(caughtError);
      if (latestRequestRef.current === requestId) {
        setError(message);
        setBalance(null);
        setLastUpdatedAt(null);
        writeCache({
          balance: null,
          error: message,
          lastUpdatedAt: null,
          isLoading: true,
        });
      }
      return null;
    } finally {
      if (latestRequestRef.current === requestId) {
        setIsLoading(false);
        const current = cachedStateRef.current;
        if (current) {
          writeCache({ ...current, isLoading: false });
        } else {
          writeCache(null);
        }
      }
    }
  }, [
    STARKNET_ENABLED,
    contract,
    enabled,
    resolvedAccountAddress,
    writeCache,
  ]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!watch) {
      return;
    }

    const intervalId = setInterval(() => {
      refresh();
    }, watchIntervalMs);

    return () => clearInterval(intervalId);
  }, [refresh, watch, watchIntervalMs]);

  useEffect(() => {
    return () => {
      latestRequestRef.current += 1;
    };
  }, []);

  const formattedBalance = useMemo(() => {
    if (balance === null || decimals === undefined) {
      return null;
    }
    return formatUnits(balance, decimals);
  }, [balance, decimals]);

  return {
    balance,
    formattedBalance,
    isLoading,
    error,
    lastUpdatedAt,
    refresh,
  };
};
