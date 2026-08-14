"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ||
  "https://shave-api-4k1l.onrender.com"
).replace(/\/+$/, "");

type ApiError = {
  status?: string;
  message?: string;
  detail?: unknown;
};

type Account = {
  id: string;
  plaid_account_id?: string | null;
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  current_balance: number | string | null;
  available_balance: number | string | null;
  balance_iso_currency_code: string | null;
  balance_updated_at: string | null;
  institution_name: string | null;
  plaid_item_id?: string | null;
};

type Category = {
  category: string;
  purchase_count: number;
  roundup_opportunity: number | string;
};

type Merchant = {
  merchant: string;
  purchase_count: number;
  roundup_opportunity: number | string;
  average_roundup: number | string;
};

type RecentRoundup = {
  id: string;
  merchant_name: string | null;
  amount: number | string;
  iso_currency_code: string | null;
  category: string | null;
  pending: boolean;
  authorized_date: string | null;
  posted_date: string | null;
  roundup_amount: number | string;
  rule_version: string;
};

type DashboardData = {
  status: "ok";

  user?: {
    id: string;
    email: string;
    created_at: string;
  } | null;

  observation: {
    earliest_transaction_date: string | null;
    latest_transaction_date: string | null;
  };

  accounts: Account[];

  summary: {
    transaction_count: number;
    posted_transaction_count: number;
    pending_transaction_count: number;
    eligible_purchase_count: number;
    roundup_opportunity: number | string;
  };

  categories: Category[];

  merchants: Merchant[];

  recent_roundups: RecentRoundup[];
};

function numberValue(
  value: number | string | null | undefined,
): number {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}

function money(
  value: number | string | null | undefined,
  currency = "USD",
): string {
  const amount = numberValue(value);

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency:
        currency && currency.length === 3
          ? currency
          : "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function dateLabel(
  value: string | null | undefined,
): string {
  if (!value) {
    return "Date unavailable";
  }

  const date = new Date(
    `${value}T00:00:00`,
  );

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function apiErrorMessage(
  status: number,
  body: ApiError | null,
): string {
  if (status === 401) {
    return "Your session has expired. Please sign in again.";
  }

  if (status === 403) {
    return "The API rejected this dashboard request.";
  }

  if (status === 404) {
    return "The dashboard endpoint is not available on the current API deployment.";
  }

  if (status === 500) {
    return "The API encountered an internal error while loading your financial picture.";
  }

  if (
    body &&
    typeof body.message === "string" &&
    body.message.trim()
  ) {
    return body.message;
  }

  return `The iBag API returned HTTP ${status}.`;
}

export default function DashboardPage() {
  const router = useRouter();

  const [data, setData] =
    useState<DashboardData | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState("");

  const [httpStatus, setHttpStatus] =
    useState<number | null>(null);

  const [attempt, setAttempt] =
    useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      setLoading(true);
      setError("");
      setHttpStatus(null);

      const token =
        typeof window !== "undefined"
          ? localStorage.getItem(
              "ibag_token",
            )
          : null;

      if (!token) {
        router.replace(
          "/start/signin",
        );

        return;
      }

      try {
        console.log(
          "Loading iBag dashboard:",
          `${API_URL}/me/dashboard`,
        );

        const response =
          await fetch(
            `${API_URL}/me/dashboard`,
            {
              method: "GET",

              headers: {
                Authorization:
                  `Bearer ${token}`,

                Accept:
                  "application/json",
              },

              cache: "no-store",
            },
          );

        const responseText =
          await response.text();

        console.log(
          "Dashboard API HTTP status:",
          response.status,
        );

        console.log(
          "Dashboard API response:",
          responseText,
        );

        let body:
          | DashboardData
          | ApiError
          | null = null;

        if (responseText) {
          try {
            body =
              JSON.parse(
                responseText,
              );
          } catch {
            body = {
              status: "error",
              message:
                responseText,
            };
          }
        }

        /*
         * Authentication failure.
         *
         * Remove only the authentication
         * state and return to sign-in.
         */

        if (
          response.status === 401
        ) {
          localStorage.removeItem(
            "ibag_token",
          );

          localStorage.removeItem(
            "ibag_user",
          );

          localStorage.removeItem(
            "ibag",
          );

          router.replace(
            "/start/signin",
          );

          return;
        }

        /*
         * IMPORTANT:
         *
         * Preserve the actual HTTP status so
         * the dashboard tells us exactly what
         * the API returned.
         */

        if (!response.ok) {
          if (!cancelled) {
            setHttpStatus(
              response.status,
            );
          }

          throw new Error(
            apiErrorMessage(
              response.status,
              body as ApiError | null,
            ),
          );
        }

        /*
         * The dashboard endpoint must return
         * { status: "ok", ... }
         */

        if (
          !body ||
          body.status !== "ok"
        ) {
          throw new Error(
            "The API returned an invalid dashboard response.",
          );
        }

        if (!cancelled) {
          setData(
            body as DashboardData,
          );
        }
      } catch (err) {
        console.error(
          "Dashboard request failed:",
          err,
        );

        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load your financial dashboard.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadDashboard();

    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  function handleSignOut() {
    localStorage.removeItem(
      "ibag_token",
    );

    localStorage.removeItem(
      "ibag_user",
    );

    localStorage.removeItem(
      "ibag",
    );

    router.replace("/");
  }

  function retry() {
    setAttempt(
      (current) =>
        current + 1,
    );
  }

  const summary =
    data?.summary ?? {
      transaction_count: 0,
      posted_transaction_count: 0,
      pending_transaction_count: 0,
      eligible_purchase_count: 0,
      roundup_opportunity: 0,
    };

  const accounts =
    data?.accounts ?? [];

  const categories =
    data?.categories ?? [];

  const merchants =
    data?.merchants ?? [];

  const recentRoundups =
    data?.recent_roundups ?? [];

  const roundupOpportunity =
    numberValue(
      summary.roundup_opportunity,
    );

  const hasAccounts =
    accounts.length > 0;

  const hasTransactions =
    summary.transaction_count > 0;

  const hasRoundups =
    summary.eligible_purchase_count >
    0;

  const topCategory =
    useMemo(
      () =>
        categories.length > 0
          ? categories[0]
          : null,
      [categories],
    );

  /*
   * LOADING
   */

  if (loading) {
    return (
      <main className="min-h-screen bg-white text-black">
        <header className="flex items-center justify-between border-b border-black/10 px-6 py-6 sm:px-10">
          <Link
            href="/dashboard"
            className="text-2xl font-semibold tracking-tight"
          >
            iBag
          </Link>

          <button
            type="button"
            onClick={handleSignOut}
            className="text-sm font-medium text-black/60 transition hover:text-black"
          >
            Sign out
          </button>
        </header>

        <div className="flex min-h-[70vh] items-center justify-center px-6">
          <div className="text-center">
            <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-black/10 border-t-black" />

            <p className="mt-5 text-sm text-black/50">
              Loading your financial picture...
            </p>
          </div>
        </div>
      </main>
    );
  }

  /*
   * ERROR
   */

  if (error || !data) {
    return (
      <main className="min-h-screen bg-white text-black">
        <header className="flex items-center justify-between border-b border-black/10 px-6 py-6 sm:px-10">
          <Link
            href="/dashboard"
            className="text-2xl font-semibold tracking-tight"
          >
            iBag
          </Link>

          <button
            type="button"
            onClick={handleSignOut}
            className="text-sm font-medium text-black/60 transition hover:text-black"
          >
            Sign out
          </button>
        </header>

        <div className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center justify-center px-6 py-16">
          <div className="w-full rounded-3xl border border-black/10 p-8 text-center sm:p-10">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-black/40">
              Dashboard
            </p>

            <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
              Your financial picture could not be loaded.
            </h1>

            <p className="mt-4 text-sm leading-6 text-black/60">
              {error ||
                "The dashboard API did not return usable financial data."}
            </p>

            {httpStatus !== null && (
              <div className="mt-4 rounded-2xl bg-black/[0.03] px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-[0.15em] text-black/40">
                  API response
                </p>

                <p className="mt-2 text-lg font-semibold">
                  HTTP {httpStatus}
                </p>
              </div>
            )}

            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <button
                type="button"
                onClick={retry}
                className="rounded-full bg-black px-7 py-4 text-sm font-medium text-white transition hover:bg-black/80"
              >
                Try again
              </button>

              <button
                type="button"
                onClick={() =>
                  window.location.reload()
                }
                className="rounded-full border border-black/10 px-7 py-4 text-sm font-medium text-black transition hover:bg-black/[0.03]"
              >
                Reload dashboard
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  /*
   * DASHBOARD
   */

  return (
    <main className="min-h-screen bg-white text-black">
      <header className="flex items-center justify-between border-b border-black/10 px-6 py-6 sm:px-10">
        <Link
          href="/dashboard"
          className="text-2xl font-semibold tracking-tight"
        >
          iBag
        </Link>

        <button
          type="button"
          onClick={handleSignOut}
          className="text-sm font-medium text-black/60 transition hover:text-black"
        >
          Sign out
        </button>
      </header>

      <div className="mx-auto w-full max-w-6xl px-6 py-12 sm:px-10 sm:py-16">

        <section>
          <p className="text-sm font-medium uppercase tracking-[0.25em] text-black/40">
            Your iBag
          </p>

          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
            Your financial picture.
          </h1>

          <p className="mt-5 max-w-3xl text-base leading-7 text-black/60 sm:text-lg">
            iBag is analyzing the real financial information you authorized from your connected accounts.
          </p>
        </section>

        <section className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">

          <div className="rounded-3xl border border-black/10 p-6">
            <p className="text-sm font-medium text-black/50">
              Connected accounts
            </p>

            <p className="mt-3 text-3xl font-semibold">
              {accounts.length}
            </p>

            <p className="mt-2 text-sm text-black/40">
              Active financial connections
            </p>
          </div>

          <div className="rounded-3xl border border-black/10 p-6">
            <p className="text-sm font-medium text-black/50">
              Transactions observed
            </p>

            <p className="mt-3 text-3xl font-semibold">
              {summary.transaction_count}
            </p>

            <p className="mt-2 text-sm text-black/40">
              {summary.pending_transaction_count} pending
            </p>
          </div>

          <div className="rounded-3xl border border-black/10 p-6">
            <p className="text-sm font-medium text-black/50">
              Eligible purchases
            </p>

            <p className="mt-3 text-3xl font-semibold">
              {summary.eligible_purchase_count}
            </p>

            <p className="mt-2 text-sm text-black/40">
              Current Round-Up opportunities
            </p>
          </div>

          <div className="rounded-3xl border border-black/10 p-6">
            <p className="text-sm font-medium text-black/50">
              Round-Up opportunity
            </p>

            <p className="mt-3 text-3xl font-semibold">
              {money(
                roundupOpportunity,
              )}
            </p>

            <p className="mt-2 text-sm text-black/40">
              Calculated from eligible purchases
            </p>
          </div>

        </section>

        {!hasAccounts && (
          <section className="mt-8 rounded-3xl border border-black/10 p-6 sm:p-8">

            <p className="text-sm font-medium text-black/50">
              Financial picture
            </p>

            <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              Connect a financial account to begin.
            </h2>

            <p className="mt-4 max-w-3xl text-base leading-7 text-black/60">
              iBag can only analyze financial information after you authorize a connection.
            </p>

            <Link
              href="/connect"
              className="mt-7 inline-flex rounded-full bg-black px-7 py-4 text-sm font-medium text-white transition hover:bg-black/80"
            >
              Connect financial accounts
            </Link>

          </section>
        )}

        {hasAccounts &&
          !hasTransactions && (
            <section className="mt-8 rounded-3xl border border-black/10 p-6 sm:p-8">

              <p className="text-sm font-medium text-black/50">
                Early picture
              </p>

              <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                Your accounts are connected.
              </h2>

              <p className="mt-4 max-w-3xl text-base leading-7 text-black/60">
                iBag has not received transaction activity to analyze yet. No financial conclusions are being generated until real transaction data is available.
              </p>

            </section>
        )}

        {hasTransactions && (
          <>
            <section className="mt-8 rounded-3xl border border-black/10 p-6 sm:p-8">

              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">

                <div className="max-w-3xl">

                  <p className="text-sm font-medium text-black/50">
                    Round-Up intelligence
                  </p>

                  <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                    {hasRoundups
                      ? `${money(
                          roundupOpportunity,
                        )} of Round-Up opportunity`
                      : "No Round-Up opportunity identified yet."}
                  </h2>

                  <p className="mt-4 text-base leading-7 text-black/60">
                    {hasRoundups
                      ? `This represents the combined amount between each eligible purchase and the next whole dollar across ${summary.eligible_purchase_count} eligible purchases.`
                      : "iBag has analyzed the available transaction activity, but no eligible purchase has created a Round-Up opportunity yet."}
                  </p>

                  <p className="mt-4 text-sm leading-6 text-black/40">
                    Round-Up opportunity is an analytical value. It is not money that has been saved, transferred, or moved.
                  </p>

                </div>

                <div className="shrink-0 rounded-2xl bg-black/[0.03] px-5 py-4">

                  <p className="text-xs font-medium uppercase tracking-[0.15em] text-black/40">
                    Observation window
                  </p>

                  <p className="mt-2 text-sm font-medium">
                    {dateLabel(
                      data.observation
                        .earliest_transaction_date,
                    )}
                  </p>

                  <p className="text-sm text-black/40">
                    through{" "}
                    {dateLabel(
                      data.observation
                        .latest_transaction_date,
                    )}
                  </p>

                </div>

              </div>

            </section>

            <section className="mt-8 grid gap-8 lg:grid-cols-2">

              <div className="rounded-3xl border border-black/10 p-6 sm:p-8">

                <p className="text-sm font-medium text-black/50">
                  Where your Round-Ups come from
                </p>

                <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                  Category activity
                </h2>

                {categories.length === 0 ? (
                  <p className="mt-6 text-sm leading-6 text-black/50">
                    There is not enough eligible purchase data to show a category pattern yet.
                  </p>
                ) : (
                  <div className="mt-6 space-y-4">
                    {categories
                      .slice(0, 6)
                      .map(
                        (
                          category,
                        ) => (
                          <div
                            key={
                              category.category
                            }
                            className="flex items-center justify-between gap-4 border-b border-black/5 pb-4 last:border-0 last:pb-0"
                          >
                            <div>
                              <p className="font-medium">
                                {
                                  category.category
                                }
                              </p>

                              <p className="mt-1 text-sm text-black/40">
                                {
                                  category.purchase_count
                                }{" "}
                                eligible{" "}
                                {category.purchase_count ===
                                1
                                  ? "purchase"
                                  : "purchases"}
                              </p>
                            </div>

                            <p className="font-semibold">
                              {money(
                                category.roundup_opportunity,
                              )}
                            </p>
                          </div>
                        ),
                      )}
                  </div>
                )}

              </div>

              <div className="rounded-3xl border border-black/10 p-6 sm:p-8">

                <p className="text-sm font-medium text-black/50">
                  Merchant activity
                </p>

                <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                  Where opportunity concentrates
                </h2>

                {merchants.length === 0 ? (
                  <p className="mt-6 text-sm leading-6 text-black/50">
                    There is not enough eligible purchase data to identify merchant patterns yet.
                  </p>
                ) : (
                  <div className="mt-6 space-y-4">
                    {merchants
                      .slice(0, 6)
                      .map(
                        (
                          merchant,
                        ) => (
                          <div
                            key={
                              merchant.merchant
                            }
                            className="flex items-center justify-between gap-4 border-b border-black/5 pb-4 last:border-0 last:pb-0"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-medium">
                                {
                                  merchant.merchant
                                }
                              </p>

                              <p className="mt-1 text-sm text-black/40">
                                {
                                  merchant.purchase_count
                                }{" "}
                                {merchant.purchase_count ===
                                1
                                  ? "purchase"
                                  : "purchases"}{" "}
                                · avg.{" "}
                                {money(
                                  merchant.average_roundup,
                                )}
                              </p>
                            </div>

                            <p className="shrink-0 font-semibold">
                              {money(
                                merchant.roundup_opportunity,
                              )}
                            </p>
                          </div>
                        ),
                      )}
                  </div>
                )}

              </div>

            </section>

            <section className="mt-8 rounded-3xl border border-black/10 p-6 sm:p-8">

              <p className="text-sm font-medium text-black/50">
                What iBag is seeing
              </p>

              <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                Early financial picture
              </h2>

              {topCategory ? (
                <div className="mt-5 rounded-2xl bg-black/[0.03] p-5">

                  <p className="text-base leading-7 text-black/70">
                    <span className="font-semibold text-black">
                      {
                        topCategory.category
                      }
                    </span>{" "}
                    currently produces the largest observed share of your Round-Up opportunity, with{" "}
                    <span className="font-semibold text-black">
                      {money(
                        topCategory.roundup_opportunity,
                      )}
                    </span>{" "}
                    across{" "}
                    {
                      topCategory.purchase_count
                    }{" "}
                    {topCategory.purchase_count ===
                    1
                      ? "eligible purchase"
                      : "eligible purchases"}.
                  </p>

                  <p className="mt-4 text-sm leading-6 text-black/40">
                    This is an observation from the currently available transaction history, not a long-term conclusion about your financial behavior.
                  </p>

                </div>
              ) : (
                <p className="mt-5 text-sm leading-6 text-black/50">
                  More eligible transaction data is needed before iBag can identify a meaningful pattern.
                </p>
              )}

            </section>

            <section className="mt-8 rounded-3xl border border-black/10 p-6 sm:p-8">

              <p className="text-sm font-medium text-black/50">
                Recent activity
              </p>

              <h2 className="mt-3 text-2xl font-semibold tracking-tight">
                Round-Up events
              </h2>

              {recentRoundups.length === 0 ? (
                <p className="mt-6 text-sm leading-6 text-black/50">
                  No Round-Up events are available yet.
                </p>
              ) : (
                <div className="mt-6 divide-y divide-black/5">
                  {recentRoundups.map(
                    (
                      transaction,
                    ) => {
                      const currency =
                        transaction.iso_currency_code ||
                        "USD";

                      return (
                        <div
                          key={
                            transaction.id
                          }
                          className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">

                            <p className="truncate font-medium">
                              {transaction.merchant_name ||
                                "Unknown merchant"}
                            </p>

                            <p className="mt-1 text-sm text-black/40">
                              {transaction.category ||
                                "Uncategorized"}{" "}
                              ·{" "}
                              {transaction.pending
                                ? "Pending"
                                : dateLabel(
                                    transaction.posted_date ||
                                      transaction.authorized_date,
                                  )}
                            </p>

                          </div>

                          <div className="shrink-0 sm:text-right">

                            <p className="font-medium">
                              {money(
                                transaction.amount,
                                currency,
                              )}
                            </p>

                            <p className="mt-1 text-sm font-medium text-black/50">
                              +{" "}
                              {money(
                                transaction.roundup_amount,
                                currency,
                              )}{" "}
                              opportunity
                            </p>

                          </div>
                        </div>
                      );
                    },
                  )}
                </div>
              )}

            </section>
          </>
        )}

        <section className="mt-8 grid gap-6 sm:grid-cols-2">

          <div className="rounded-3xl border border-black/10 p-6">

            <p className="text-sm font-medium text-black/50">
              Account
            </p>

            <p className="mt-3 break-all text-base font-medium">
              {data.user?.email ||
                "Authenticated iBag user"}
            </p>

            <p className="mt-2 text-sm text-black/40">
              Your iBag account
            </p>

          </div>

          <div className="rounded-3xl border border-black/10 p-6">

            <p className="text-sm font-medium text-black/50">
              Financial connections
            </p>

            <p className="mt-3 text-2xl font-semibold">
              {accounts.length}
            </p>

            <p className="mt-2 text-sm text-black/40">
              Active connected accounts
            </p>

          </div>

        </section>

      </div>
    </main>
  );
}
