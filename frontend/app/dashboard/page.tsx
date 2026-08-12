"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useRouter } from "next/navigation";

const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ||
  "https://shave-api-4k1l.onrender.com"
).replace(/\/+$/, "");

type User = {
  id: string;
  email: string;
};

type IBag = {
  id: string;
  user_id: string;
  created_at: string;
};

type Account = {
  id: string;
  plaid_account_id: string;
  name: string;
  type: string;
  subtype: string | null;
  mask: string | null;
  current_balance: number | null;
  available_balance: number | null;
  balance_iso_currency_code: string | null;
  balance_updated_at: string | null;
};

type Summary = {
  total_balance?: number | null;
  net_worth?: number | null;
  total_assets?: number | null;
  total_liabilities?: number | null;
  [key: string]: unknown;
};

type Transaction = {
  id: string;
  account_id: string;
  plaid_transaction_id: string;
  amount: number;
  iso_currency_code: string | null;
  merchant_name: string | null;
  category: string | null;
  pending: boolean;
  authorized_date: string | null;
  posted_date: string | null;
  status: string;
};

type LinkTokenResponse = {
  status: string;
  link_token?: string;
  message?: string;
  detail?: unknown;
};

type ExchangeResponse = {
  status: string;
  plaid_item_id?: string;
  accounts_stored?: number;
  immediate_sync?: unknown;
  message?: string;
  detail?: unknown;
};

function formatCurrency(
  amount: number | null | undefined,
  currency = "USD"
) {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return "—";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(date: string | null) {
  if (!date) return "—";

  const parsed = new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

export default function DashboardPage() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [ibag, setIbag] = useState<IBag | null>(null);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const [linkToken, setLinkToken] = useState<string | null>(null);

  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [isPreparingPlaid, setIsPreparingPlaid] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const [error, setError] = useState("");
  const [connectionMessage, setConnectionMessage] = useState("");

  const token = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return localStorage.getItem("ibag_token");
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem("ibag_token");
    localStorage.removeItem("ibag_user");
    localStorage.removeItem("ibag");

    router.replace("/");
  }, [router]);

  const apiRequest = useCallback(
    async <T,>(path: string): Promise<T> => {
      const currentToken =
        typeof window !== "undefined"
          ? localStorage.getItem("ibag_token")
          : null;

      if (!currentToken) {
        throw new Error("Your session has expired. Please sign in again.");
      }

      const response = await fetch(`${API_URL}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${currentToken}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      });

      const responseText = await response.text();

      let data: any = null;

      try {
        data = JSON.parse(responseText);
      } catch {
        data = null;
      }

      if (response.status === 401) {
        clearSession();
        throw new Error("Your session has expired. Please sign in again.");
      }

      if (!response.ok) {
        throw new Error(
          data?.message ||
            data?.detail ||
            `The API returned HTTP ${response.status}.`
        );
      }

      return data as T;
    },
    [clearSession]
  );

  const loadDashboardData = useCallback(async () => {
    setIsLoadingData(true);
    setError("");

    try {
      const [summaryResponse, accountsResponse, transactionsResponse] =
        await Promise.all([
          apiRequest<any>("/me/summary"),
          apiRequest<any>("/me/accounts"),
          apiRequest<any>("/me/transactions"),
        ]);

      setSummary(
        summaryResponse?.summary ??
          summaryResponse?.data ??
          summaryResponse ??
          null
      );

      const nextAccounts =
        accountsResponse?.accounts ??
        accountsResponse?.data ??
        [];

      const nextTransactions =
        transactionsResponse?.transactions ??
        transactionsResponse?.data ??
        [];

      setAccounts(Array.isArray(nextAccounts) ? nextAccounts : []);
      setTransactions(
        Array.isArray(nextTransactions) ? nextTransactions : []
      );
    } catch (err) {
      console.error("Dashboard data load failed:", err);

      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Unable to load your financial information.");
      }
    } finally {
      setIsLoadingData(false);
    }
  }, [apiRequest]);

  const createPlaidLinkToken = useCallback(async () => {
    const currentToken =
      typeof window !== "undefined"
        ? localStorage.getItem("ibag_token")
        : null;

    if (!currentToken) {
      clearSession();
      return;
    }

    setIsPreparingPlaid(true);
    setError("");

    try {
      const response = await fetch(
        `${API_URL}/plaid/create-link-token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${currentToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      const responseText = await response.text();

      let data: LinkTokenResponse | null = null;

      try {
        data = JSON.parse(responseText);
      } catch {
        data = null;
      }

      if (response.status === 401) {
        clearSession();
        return;
      }

      if (!response.ok || !data?.link_token) {
        throw new Error(
          data?.message ||
            "Unable to prepare the secure Plaid connection."
        );
      }

      setLinkToken(data.link_token);
    } catch (err) {
      console.error("Plaid Link token creation failed:", err);

      setError(
        err instanceof Error
          ? err.message
          : "Unable to prepare the secure Plaid connection."
      );
    } finally {
      setIsPreparingPlaid(false);
    }
  }, [clearSession]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storedToken = localStorage.getItem("ibag_token");
    const storedUser = localStorage.getItem("ibag_user");
    const storedIBag = localStorage.getItem("ibag");

    if (!storedToken || !storedUser || !storedIBag) {
      router.replace("/start/signin");
      return;
    }

    try {
      setUser(JSON.parse(storedUser));
      setIbag(JSON.parse(storedIBag));
    } catch (err) {
      console.error("Invalid stored iBag session:", err);

      clearSession();
      return;
    }

    setIsCheckingAuth(false);
  }, [router, clearSession]);

  useEffect(() => {
    if (!isCheckingAuth && token) {
      loadDashboardData();
    }
  }, [isCheckingAuth, token, loadDashboardData]);

  const {
    open,
    ready: plaidReady,
  } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      setIsConnecting(true);
      setError("");
      setConnectionMessage("Securing your financial connection...");

      try {
        const currentToken =
          typeof window !== "undefined"
            ? localStorage.getItem("ibag_token")
            : null;

        if (!currentToken) {
          clearSession();
          return;
        }

        const response = await fetch(
          `${API_URL}/plaid/exchange-public-token`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${currentToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              public_token: publicToken,
              institution_name:
                metadata.institution?.name || null,
            }),
          }
        );

        const responseText = await response.text();

        let data: ExchangeResponse | null = null;

        try {
          data = JSON.parse(responseText);
        } catch {
          data = null;
        }

        if (response.status === 401) {
          clearSession();
          return;
        }

        if (!response.ok || data?.status !== "ok") {
          throw new Error(
            data?.message ||
              "The financial account could not be connected."
          );
        }

        setLinkToken(null);

        setConnectionMessage(
          "Connected. Updating your financial picture..."
        );

        /*
         * The backend performs an immediate initial transaction sync
         * after exchanging the Plaid public token.
         *
         * Reload the dashboard from the authoritative API so the UI
         * displays real persisted financial data rather than assuming
         * what Plaid returned.
         */
        await loadDashboardData();

        setConnectionMessage(
          "Your financial picture has been updated."
        );
      } catch (err) {
        console.error("Plaid connection failed:", err);

        setConnectionMessage("");

        setError(
          err instanceof Error
            ? err.message
            : "The financial account could not be connected."
        );
      } finally {
        setIsConnecting(false);
      }
    },

    onExit: (exitError) => {
      if (exitError) {
        console.error("Plaid Link exited with error:", exitError);
      }

      setIsConnecting(false);
    },
  });

  function handleConnectClick() {
    setError("");
    setConnectionMessage("");

    if (!linkToken) {
      setError(
        "The secure financial connection is still being prepared."
      );
      return;
    }

    if (!plaidReady) {
      setError(
        "Plaid is still preparing. Please try again in a moment."
      );
      return;
    }

    open();
  }

  function handleSignOut() {
    clearSession();
  }

  if (isCheckingAuth) {
    return (
      <main className="min-h-screen bg-white text-black">
        <div className="flex min-h-screen items-center justify-center px-6">
          <p className="text-sm text-black/40">
            Loading your iBag...
          </p>
        </div>
      </main>
    );
  }

  if (!user || !ibag) {
    return null;
  }

  const totalBalance =
    summary?.total_balance ??
    summary?.net_worth ??
    null;

  return (
    <main className="min-h-screen bg-white text-black">
      <header className="border-b border-black/10">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 sm:px-10">
          <div>
            <p className="text-2xl font-semibold tracking-tight">
              iBag
            </p>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            className="text-sm font-medium text-black/60 transition hover:text-black"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl px-6 py-10 sm:px-10 sm:py-14">
        <section>
          <p className="text-sm font-medium uppercase tracking-[0.25em] text-black/40">
            Your iBag
          </p>

          <div className="mt-4 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
            <div>
              <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
                Welcome.
              </h1>

              <p className="mt-5 max-w-3xl text-base leading-7 text-black/60 sm:text-lg">
                iBag becomes intelligent when it has real financial
                information to understand.
              </p>
            </div>

            {accounts.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  await createPlaidLinkToken();
                }}
                disabled={isPreparingPlaid || isConnecting}
                className="rounded-full border border-black/15 px-6 py-3 text-sm font-medium transition hover:border-black/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isPreparingPlaid
                  ? "Preparing..."
                  : "Connect another account"}
              </button>
            )}
          </div>
        </section>

        {error && (
          <div
            role="alert"
            className="mt-8 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm leading-6 text-red-700"
          >
            {error}
          </div>
        )}

        {connectionMessage && (
          <div
            role="status"
            className="mt-8 rounded-2xl border border-black/10 bg-black/[0.02] px-5 py-4 text-sm leading-6 text-black/60"
          >
            {connectionMessage}
          </div>
        )}

        <section className="mt-12 grid gap-6 lg:grid-cols-3">
          <div className="rounded-3xl border border-black/10 p-6 sm:p-8 lg:col-span-2">
            <p className="text-sm font-medium text-black/50">
              Your financial picture
            </p>

            {isLoadingData ? (
              <p className="mt-5 text-base text-black/40">
                Understanding your financial data...
              </p>
            ) : accounts.length === 0 ? (
              <>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  Nothing connected yet.
                </h2>

                <p className="mt-4 max-w-2xl text-base leading-7 text-black/60">
                  Connect a financial account and iBag will begin
                  working with your real financial information.
                </p>

                <button
                  type="button"
                  onClick={handleConnectClick}
                  disabled={
                    !plaidReady ||
                    !linkToken ||
                    isConnecting ||
                    isPreparingPlaid
                  }
                  className="mt-7 rounded-full bg-black px-7 py-4 text-sm font-medium text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isConnecting
                    ? "Connecting..."
                    : isPreparingPlaid || !linkToken
                      ? "Preparing secure connection..."
                      : !plaidReady
                        ? "Preparing Plaid..."
                        : "Connect financial accounts"}
                </button>

                <p className="mt-4 text-xs leading-5 text-black/40">
                  Your connection is handled through Plaid. iBag does
                  not receive your bank password.
                </p>
              </>
            ) : (
              <>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                  {formatCurrency(totalBalance)}
                </h2>

                <p className="mt-3 text-sm text-black/40">
                  Current financial picture
                </p>
              </>
            )}
          </div>

          <div className="rounded-3xl border border-black/10 p-6 sm:p-8">
            <p className="text-sm font-medium text-black/50">
              Connected accounts
            </p>

            <p className="mt-3 text-4xl font-semibold">
              {accounts.length}
            </p>

            <p className="mt-2 text-sm leading-6 text-black/40">
              Real financial accounts connected through Plaid.
            </p>
          </div>
        </section>

        {accounts.length > 0 && (
          <section className="mt-8">
            <div className="mb-5">
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-black/40">
                Accounts
              </p>

              <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                Connected financial accounts
              </h2>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {accounts.map((account) => (
                <article
                  key={account.id}
                  className="rounded-3xl border border-black/10 p-6"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="font-semibold">
                        {account.name}
                      </h3>

                      <p className="mt-1 text-sm capitalize text-black/40">
                        {account.subtype || account.type}
                      </p>
                    </div>

                    {account.mask && (
                      <span className="text-sm text-black/40">
                        •••• {account.mask}
                      </span>
                    )}
                  </div>

                  <p className="mt-7 text-2xl font-semibold">
                    {formatCurrency(
                      account.current_balance,
                      account.balance_iso_currency_code || "USD"
                    )}
                  </p>

                  {account.available_balance !== null &&
                    account.available_balance !== undefined && (
                      <p className="mt-2 text-sm text-black/40">
                        Available{" "}
                        {formatCurrency(
                          account.available_balance,
                          account.balance_iso_currency_code ||
                            "USD"
                        )}
                      </p>
                    )}

                  {account.balance_updated_at && (
                    <p className="mt-4 text-xs text-black/30">
                      Updated{" "}
                      {formatDate(account.balance_updated_at)}
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {transactions.length > 0 && (
          <section className="mt-12">
            <div className="mb-5">
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-black/40">
                Recent activity
              </p>

              <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                Transactions
              </h2>
            </div>

            <div className="overflow-hidden rounded-3xl border border-black/10">
              <div className="divide-y divide-black/10">
                {transactions.slice(0, 20).map((transaction) => (
                  <div
                    key={transaction.id}
                    className="flex items-center justify-between gap-5 px-5 py-5 sm:px-7"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {transaction.merchant_name ||
                          "Transaction"}
                      </p>

                      <p className="mt-1 text-sm text-black/40">
                        {transaction.category || "Uncategorized"}
                        {transaction.posted_date
                          ? ` · ${formatDate(
                              transaction.posted_date
                            )}`
                          : ""}
                        {transaction.pending
                          ? " · Pending"
                          : ""}
                      </p>
                    </div>

                    <p className="shrink-0 font-medium">
                      {formatCurrency(
                        transaction.amount,
                        transaction.iso_currency_code ||
                          "USD"
                      )}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        <section className="mt-12 grid gap-6 sm:grid-cols-2">
          <div className="rounded-3xl border border-black/10 p-6">
            <p className="text-sm font-medium text-black/50">
              Account
            </p>

            <p className="mt-3 break-all text-base font-medium">
              {user.email}
            </p>

            <p className="mt-2 text-sm text-black/40">
              Your iBag account
            </p>
          </div>

          <div className="rounded-3xl border border-black/10 p-6">
            <p className="text-sm font-medium text-black/50">
              iBag
            </p>

            <p className="mt-3 text-base font-medium">
              {ibag.id}
            </p>

            <p className="mt-2 text-sm text-black/40">
              Created {formatDate(ibag.created_at)}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
