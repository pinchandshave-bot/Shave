"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useState,
} from "react";
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
  official_name?: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  current_balance: number | string | null;
  available_balance: number | string | null;
  balance_iso_currency_code: string | null;
  balance_updated_at: string | null;
  institution_name: string | null;
};

type Category = {
  category: string;
  purchase_count: number;
  roundup_opportunity: number | string;
  average_roundup?: number | string;
};

type Merchant = {
  merchant: string;
  purchase_count: number;
  roundup_opportunity: number | string;
  average_roundup: number | string;
};

type Insight = {
  id: string;
  type: string;
  evidence_type: string;
  confidence: string;
  title: string;
  statement: string;
  evidence?: Record<string, unknown>;
  qualification?: string;
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
    average_roundup?: number | string;
    median_roundup?: number | string;
    smallest_roundup?: number | string;
    largest_roundup?: number | string;
  };

  categories: Category[];

  merchants: Merchant[];

  recent_roundups: Array<{
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
  }>;

  intelligence?: {
    evidence?: Record<string, string>;

    cash_flow?: {
      evidence_state: string;
      observation_days: number;
      inflow: number;
      outflow: number;
      net_change: number | null;
      daily_inflow: number | null;
      daily_outflow: number | null;
      daily_net_change: number | null;
      direction: string;
    };

    balance?: {
      evidence_state: string;
      total_cash: number | null;
      runway_days: number | null;
      runway_months: number | null;
      daily_burn?: number | null;
      status: string;
    };

    behavior?: {
      evidence_state: string;
      total_observed_spend?: number;
      top_categories: Array<{
        name: string;
        transactions: number;
        spend: number;
        share: number;
      }>;
      top_merchants: Array<{
        name: string;
        transactions: number;
        spend: number;
        share: number;
      }>;
    };

    roundup?: {
      evidence_state: string;
      eligible_purchase_count: number;
      opportunity: number;
      average: number;
      median: number;
      smallest: number;
      largest: number;
    };

    insights?: Insight[];
  };

  income?: {
    evidence_state: string;
    signal?: {
      source: string | null;
      grouping?: string;
      cadence: string;
      typical_amount: number;
      occurrences: number;
      reliability: number;
      amount_consistency?: number;
      confidence: string;
      last_detected_date: string;
      next_expected_date: string;
    } | null;
  };

  runway?: {
    evidence_state: string;
    total_cash: number | null;
    total_in?: number;
    total_out?: number;
    net_daily_change: number | null;
    runway_days: number | null;
    status: string;
    based_on_days?: number;
  };

  insights?: Insight[];
};

function numberValue(
  value: number | string | null | undefined
) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function money(
  value: number | string | null | undefined,
  currency = "USD"
) {
  const amount = numberValue(value);

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.length === 3 ? currency : "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function dateLabel(
  value: string | null | undefined
) {
  if (!value) {
    return "Date unavailable";
  }

  const date = new Date(`${value}T00:00:00`);

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
  body: ApiError | null
) {
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

function EvidenceBadge({
  state,
}: {
  state?: string;
}) {
  const normalized = state || "insufficient";

  const label =
    normalized === "supported"
      ? "Evidence supported"
      : normalized === "limited"
        ? "Limited evidence"
        : normalized === "observed"
          ? "Observed"
          : "Insufficient evidence";

  return (
    <span className="inline-flex rounded-full bg-black/[0.04] px-3 py-1 text-xs font-medium text-black/50">
      {label}
    </span>
  );
}

function SectionLabel({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <p className="text-sm font-medium uppercase tracking-[0.2em] text-black/40">
      {children}
    </p>
  );
}

function MetricCard({
  label,
  value,
  description,
}: {
  label: string;
  value: string | number;
  description: string;
}) {
  return (
    <div className="rounded-3xl border border-black/10 p-6">
      <p className="text-sm text-black/50">{label}</p>

      <p className="mt-3 text-3xl font-semibold tracking-tight">
        {value}
      </p>

      <p className="mt-2 text-sm text-black/40">
        {description}
      </p>
    </div>
  );
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
          ? localStorage.getItem("ibag_token")
          : null;

      if (!token) {
        router.replace("/start/signin");
        return;
      }

      try {
        const response = await fetch(
          `${API_URL}/me/dashboard`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
            },
            cache: "no-store",
          }
        );

        const responseText =
          await response.text();

        let body:
          | DashboardData
          | ApiError
          | null = null;

        if (responseText) {
          try {
            body = JSON.parse(responseText);
          } catch {
            body = {
              status: "error",
              message: responseText,
            };
          }
        }

        if (response.status === 401) {
          localStorage.removeItem("ibag_token");
          localStorage.removeItem("ibag_user");
          localStorage.removeItem("ibag");

          router.replace("/start/signin");
          return;
        }

        if (!response.ok) {
          if (!cancelled) {
            setHttpStatus(response.status);
          }

          throw new Error(
            apiErrorMessage(
              response.status,
              body as ApiError | null
            )
          );
        }

        if (
          !body ||
          body.status !== "ok"
        ) {
          throw new Error(
            "The API returned an invalid dashboard response."
          );
        }

        if (!cancelled) {
          setData(body as DashboardData);
        }
      } catch (err) {
        console.error(
          "Dashboard request failed:",
          err
        );

        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load your financial dashboard."
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
    localStorage.removeItem("ibag_token");
    localStorage.removeItem("ibag_user");
    localStorage.removeItem("ibag");

    router.replace("/");
  }

  function retry() {
    setAttempt((current) => current + 1);
  }

  const summary =
    data?.summary || {
      transaction_count: 0,
      posted_transaction_count: 0,
      pending_transaction_count: 0,
      eligible_purchase_count: 0,
      roundup_opportunity: 0,
    };

  const intelligence =
    data?.intelligence;

  const cashFlow =
    intelligence?.cash_flow;

  const balance =
    intelligence?.balance;

  const behavior =
    intelligence?.behavior;

  const income =
    data?.income;

  const runway =
    data?.runway;

  const insights =
    data?.insights ||
    intelligence?.insights ||
    [];

  const roundupOpportunity =
    numberValue(
      summary.roundup_opportunity
    );

  const hasAccounts =
    Boolean(data?.accounts.length);

  const hasTransactions =
    summary.transaction_count > 0;

  const topCategory =
    useMemo(
      () =>
        data?.categories?.length
          ? data.categories[0]
          : null,
      [data]
    );

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
            onClick={handleSignOut}
            className="text-sm font-medium text-black/60"
          >
            Sign out
          </button>
        </header>

        <div className="flex min-h-[70vh] items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-black/10 border-t-black" />

            <p className="mt-5 text-sm text-black/50">
              Building your financial picture...
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-white text-black">
        <header className="flex items-center justify-between border-b border-black/10 px-6 py-6 sm:px-10">
          <Link
            href="/dashboard"
            className="text-2xl font-semibold"
          >
            iBag
          </Link>

          <button
            onClick={handleSignOut}
            className="text-sm text-black/60"
          >
            Sign out
          </button>
        </header>

        <div className="mx-auto flex min-h-[70vh] max-w-2xl items-center px-6">
          <div className="w-full rounded-3xl border border-black/10 p-8 text-center">
            <SectionLabel>
              Dashboard
            </SectionLabel>

            <h1 className="mt-4 text-3xl font-semibold tracking-tight">
              Your financial picture could not be loaded.
            </h1>

            <p className="mt-4 text-sm leading-6 text-black/60">
              {error}
            </p>

            {httpStatus !== null && (
              <p className="mt-4 text-sm font-medium">
                HTTP {httpStatus}
              </p>
            )}

            <button
              onClick={retry}
              className="mt-7 rounded-full bg-black px-7 py-4 text-sm font-medium text-white"
            >
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }

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
          onClick={handleSignOut}
          className="text-sm font-medium text-black/60 hover:text-black"
        >
          Sign out
        </button>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-12 sm:px-10">
        <section>
          <SectionLabel>
            Your iBag
          </SectionLabel>

          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
            Your financial picture.
          </h1>

          <p className="mt-5 max-w-3xl text-base leading-7 text-black/60 sm:text-lg">
            iBag is turning the real financial information you authorized into measurable financial intelligence.
          </p>
        </section>

        <section className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Accounts"
            value={data.accounts.length}
            description="Connected financial accounts"
          />

          <MetricCard
            label="Transactions"
            value={summary.transaction_count}
            description={`${summary.posted_transaction_count} posted · ${summary.pending_transaction_count} pending`}
          />

          <MetricCard
            label="Round-Up opportunities"
            value={summary.eligible_purchase_count}
            description="Eligible purchases observed"
          />

          <MetricCard
            label="Opportunity"
            value={money(roundupOpportunity)}
            description="Analytical Round-Up value"
          />
        </section>

        {!hasAccounts && (
          <section className="mt-8 rounded-3xl border border-black/10 p-8">
            <EvidenceBadge state="insufficient" />

            <h2 className="mt-4 text-3xl font-semibold">
              Connect a financial account to begin.
            </h2>

            <p className="mt-4 max-w-2xl text-black/60">
              iBag only creates financial intelligence from information you authorize.
            </p>

            <Link
              href="/connect"
              className="mt-7 inline-flex rounded-full bg-black px-7 py-4 text-sm font-medium text-white"
            >
              Connect financial accounts
            </Link>
          </section>
        )}

        {hasAccounts && !hasTransactions && (
          <section className="mt-8 rounded-3xl border border-black/10 p-8">
            <EvidenceBadge state="observed" />

            <h2 className="mt-4 text-3xl font-semibold">
              Your accounts are connected.
            </h2>

            <p className="mt-4 max-w-2xl text-black/60">
              iBag is waiting for qualifying transaction history. It will not invent financial conclusions while evidence is insufficient.
            </p>
          </section>
        )}

        {hasTransactions && (
          <>
            <section className="mt-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <SectionLabel>
                    Financial intelligence
                  </SectionLabel>

                  <h2 className="mt-2 text-3xl font-semibold tracking-tight">
                    What the data supports.
                  </h2>
                </div>

                <p className="text-sm text-black/40">
                  Evidence-gated · read-only
                </p>
              </div>

              <div className="mt-6 grid gap-5 lg:grid-cols-3">
                <div className="rounded-3xl border border-black/10 p-6">
                  <EvidenceBadge
                    state={cashFlow?.evidence_state}
                  />

                  <p className="mt-5 text-sm font-medium text-black/50">
                    Cash flow
                  </p>

                  {cashFlow?.net_change !== null &&
                  cashFlow?.net_change !== undefined ? (
                    <>
                      <p className="mt-3 text-3xl font-semibold">
                        {money(
                          cashFlow.net_change
                        )}
                      </p>

                      <p className="mt-2 text-sm text-black/50">
                        Net observed change
                      </p>

                      <div className="mt-6 grid grid-cols-2 gap-3">
                        <div className="rounded-2xl bg-black/[0.03] p-4">
                          <p className="text-xs text-black/40">
                            Inflow
                          </p>

                          <p className="mt-2 font-semibold">
                            {money(
                              cashFlow.inflow
                            )}
                          </p>
                        </div>

                        <div className="rounded-2xl bg-black/[0.03] p-4">
                          <p className="text-xs text-black/40">
                            Outflow
                          </p>

                          <p className="mt-2 font-semibold">
                            {money(
                              cashFlow.outflow
                            )}
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 flex items-center justify-between text-sm">
                        <span className="text-black/40">
                          Direction
                        </span>

                        <span className="font-medium">
                          {cashFlow.direction ||
                            "Observed"}
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="mt-5 text-sm text-black/50">
                      More transaction history is required to calculate cash-flow direction.
                    </p>
                  )}
                </div>

                <div className="rounded-3xl border border-black/10 p-6">
                  <EvidenceBadge
                    state={
                      balance?.evidence_state ||
                      runway?.evidence_state
                    }
                  />

                  <p className="mt-5 text-sm font-medium text-black/50">
                    Liquidity
                  </p>

                  <p className="mt-3 text-3xl font-semibold">
                    {balance?.total_cash !== null &&
                    balance?.total_cash !== undefined
                      ? money(balance.total_cash)
                      : runway?.total_cash !== null &&
                          runway?.total_cash !== undefined
                        ? money(runway.total_cash)
                        : "—"}
                  </p>

                  <p className="mt-2 text-sm text-black/50">
                    Current depository balances
                  </p>

                  {(balance?.runway_days !== null &&
                    balance?.runway_days !== undefined) ||
                  (runway?.runway_days !== null &&
                    runway?.runway_days !== undefined) ? (
                    <div className="mt-6 rounded-2xl bg-black/[0.03] p-4">
                      <p className="text-xs text-black/40">
                        Observed runway
                      </p>

                      <p className="mt-2 text-2xl font-semibold">
                        {balance?.runway_days ??
                          runway?.runway_days}{" "}
                        days
                      </p>

                      <p className="mt-2 text-xs leading-5 text-black/40">
                        Mathematical projection from observed net cash decline. Not a forecast.
                      </p>
                    </div>
                  ) : (
                    <p className="mt-6 text-sm leading-6 text-black/40">
                      A declining cash balance is not currently supported by sufficient evidence for a runway calculation.
                    </p>
                  )}
                </div>

                <div className="rounded-3xl border border-black/10 p-6">
                  <EvidenceBadge
                    state={income?.evidence_state}
                  />

                  <p className="mt-5 text-sm font-medium text-black/50">
                    Recurring income signal
                  </p>

                  {income?.signal ? (
                    <>
                      <p className="mt-3 text-3xl font-semibold">
                        {money(
                          income.signal.typical_amount
                        )}
                      </p>

                      <p className="mt-2 text-sm text-black/50">
                        Observed{" "}
                        {income.signal.cadence}{" "}
                        pattern
                      </p>

                      <div className="mt-6 space-y-3 text-sm">
                        <div className="flex justify-between gap-4">
                          <span className="text-black/40">
                            Source
                          </span>

                          <span className="max-w-[60%] text-right font-medium">
                            {income.signal.source ||
                              "Source not identified"}
                          </span>
                        </div>

                        <div className="flex justify-between gap-4">
                          <span className="text-black/40">
                            Evidence
                          </span>

                          <span className="font-medium">
                            {income.signal.occurrences}{" "}
                            occurrences
                          </span>
                        </div>

                        <div className="flex justify-between gap-4">
                          <span className="text-black/40">
                            Reliability
                          </span>

                          <span className="font-medium">
                            {Math.round(
                              income.signal.reliability *
                                100
                            )}
                            %
                          </span>
                        </div>

                        <div className="flex justify-between gap-4">
                          <span className="text-black/40">
                            Confidence
                          </span>

                          <span className="font-medium capitalize">
                            {income.signal.confidence}
                          </span>
                        </div>

                        <div className="flex justify-between gap-4">
                          <span className="text-black/40">
                            Next expected
                          </span>

                          <span className="font-medium">
                            {dateLabel(
                              income.signal.next_expected_date
                            )}
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p className="mt-5 text-sm leading-6 text-black/50">
                      iBag does not yet have enough recurring transaction evidence to identify an income pattern.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="mt-8 rounded-3xl border border-black/10 p-8">
              <EvidenceBadge
                state={
                  intelligence?.roundup
                    ?.evidence_state
                }
              />

              <p className="mt-5 text-sm font-medium uppercase tracking-[0.18em] text-black/40">
                First intelligence domain
              </p>

              <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                Round-Up intelligence.
              </h2>

              <p className="mt-4 max-w-3xl text-base leading-7 text-black/60">
                iBag is calculating the analytical opportunity created by eligible real-world purchases. Nothing is transferred, saved, or moved.
              </p>

              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-2xl bg-black/[0.03] p-5">
                  <p className="text-xs text-black/40">
                    Total opportunity
                  </p>

                  <p className="mt-2 text-2xl font-semibold">
                    {money(roundupOpportunity)}
                  </p>
                </div>

                <div className="rounded-2xl bg-black/[0.03] p-5">
                  <p className="text-xs text-black/40">
                    Average
                  </p>

                  <p className="mt-2 text-2xl font-semibold">
                    {money(
                      summary.average_roundup
                    )}
                  </p>
                </div>

                <div className="rounded-2xl bg-black/[0.03] p-5">
                  <p className="text-xs text-black/40">
                    Median
                  </p>

                  <p className="mt-2 text-2xl font-semibold">
                    {money(
                      summary.median_roundup
                    )}
                  </p>
                </div>

                <div className="rounded-2xl bg-black/[0.03] p-5">
                  <p className="text-xs text-black/40">
                    Largest
                  </p>

                  <p className="mt-2 text-2xl font-semibold">
                    {money(
                      summary.largest_roundup
                    )}
                  </p>
                </div>
              </div>
            </section>

            <section className="mt-8 grid gap-8 lg:grid-cols-2">
              <div className="rounded-3xl border border-black/10 p-8">
                <p className="text-sm text-black/50">
                  Round-Up concentration
                </p>

                <h2 className="mt-2 text-2xl font-semibold">
                  Categories generating opportunity
                </h2>

                <div className="mt-6 space-y-5">
                  {data.categories
                    .slice(0, 8)
                    .map((category) => (
                      <div
                        key={category.category}
                      >
                        <div className="flex justify-between gap-4">
                          <div>
                            <p className="font-medium">
                              {category.category}
                            </p>

                            <p className="mt-1 text-xs text-black/40">
                              {category.purchase_count}{" "}
                              purchases
                            </p>
                          </div>

                          <p className="font-semibold">
                            {money(
                              category.roundup_opportunity
                            )}
                          </p>
                        </div>

                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
                          <div
                            className="h-full rounded-full bg-black"
                            style={{
                              width: `${
                                roundupOpportunity > 0
                                  ? Math.min(
                                      100,
                                      (numberValue(
                                        category.roundup_opportunity
                                      ) /
                                        roundupOpportunity) *
                                        100
                                    )
                                  : 0
                              }%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                </div>

                {topCategory && (
                  <p className="mt-6 text-xs leading-5 text-black/40">
                    Largest observed Round-Up opportunity category:{" "}
                    {topCategory.category}.
                  </p>
                )}
              </div>

              <div className="rounded-3xl border border-black/10 p-8">
                <p className="text-sm text-black/50">
                  Observed spending concentration
                </p>

                <h2 className="mt-2 text-2xl font-semibold">
                  Where spending is concentrated
                </h2>

                {behavior?.top_categories?.length ? (
                  <div className="mt-6 space-y-5">
                    {behavior.top_categories
                      .slice(0, 6)
                      .map((category) => (
                        <div
                          key={category.name}
                          className="flex items-center justify-between gap-5"
                        >
                          <div>
                            <p className="font-medium">
                              {category.name}
                            </p>

                            <p className="mt-1 text-xs text-black/40">
                              {category.transactions}{" "}
                              transactions
                            </p>
                          </div>

                          <div className="text-right">
                            <p className="font-semibold">
                              {money(
                                category.spend
                              )}
                            </p>

                            <p className="mt-1 text-xs text-black/40">
                              {(
                                category.share * 100
                              ).toFixed(1)}
                              %
                            </p>
                          </div>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="mt-6 text-sm text-black/50">
                    More posted transaction evidence is required.
                  </p>
                )}
              </div>
            </section>

            <section className="mt-8 rounded-3xl border border-black/10 p-8">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <SectionLabel>
                    Explainable intelligence
                  </SectionLabel>

                  <h2 className="mt-2 text-3xl font-semibold">
                    What iBag can responsibly tell you.
                  </h2>
                </div>

                <p className="text-xs text-black/40">
                  Every statement is tied to evidence.
                </p>
              </div>

              {insights.length ? (
                <div className="mt-7 grid gap-5 lg:grid-cols-2">
                  {insights.map((insight) => (
                    <article
                      key={insight.id}
                      className="rounded-2xl bg-black/[0.03] p-6"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-black/40">
                          {insight.type}
                        </p>

                        <span className="text-xs font-medium text-black/40">
                          {insight.confidence}{" "}
                          confidence
                        </span>
                      </div>

                      <h3 className="mt-4 text-xl font-semibold">
                        {insight.title}
                      </h3>

                      <p className="mt-3 text-sm leading-6 text-black/60">
                        {insight.statement}
                      </p>

                      {insight.qualification && (
                        <p className="mt-4 text-xs leading-5 text-black/40">
                          {insight.qualification}
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="mt-7 rounded-2xl bg-black/[0.03] p-6">
                  <p className="text-sm leading-6 text-black/50">
                    iBag has transaction data, but there is not yet enough evidence to generate a responsible higher-order insight.
                  </p>
                </div>
              )}
            </section>

            <section className="mt-8 rounded-3xl border border-black/10 p-8">
              <p className="text-sm text-black/50">
                Underlying evidence
              </p>

              <h2 className="mt-2 text-2xl font-semibold">
                Recent Round-Up events
              </h2>

              <div className="mt-6 divide-y divide-black/5">
                {data.recent_roundups.map(
                  (event) => (
                    <div
                      key={event.id}
                      className="flex flex-col gap-3 py-5 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <p className="font-medium">
                          {event.merchant_name ||
                            "Unknown merchant"}
                        </p>

                        <p className="mt-1 text-sm text-black/40">
                          {event.category ||
                            "Uncategorized"}{" "}
                          ·{" "}
                          {event.pending
                            ? "Pending"
                            : dateLabel(
                                event.posted_date ||
                                  event.authorized_date
                              )}
                        </p>
                      </div>

                      <div className="sm:text-right">
                        <p className="font-medium">
                          {money(
                            event.amount,
                            event.iso_currency_code ||
                              "USD"
                          )}
                        </p>

                        <p className="mt-1 text-sm text-black/50">
                          +{" "}
                          {money(
                            event.roundup_amount,
                            event.iso_currency_code ||
                              "USD"
                          )}{" "}
                          opportunity
                        </p>
                      </div>
                    </div>
                  )
                )}
              </div>
            </section>

            <section className="mt-8 rounded-3xl border border-black/10 p-8">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex-1">
                  <SectionLabel>
                    Financial evidence
                  </SectionLabel>

                  <h2 className="mt-2 text-2xl font-semibold">
                    Income and liquidity methodology
                  </h2>

                  <p className="mt-4 max-w-2xl text-sm leading-6 text-black/50">
                    iBag distinguishes observed financial evidence from projections. Recurring income signals are derived from repeated transaction patterns. Runway is a mathematical projection based on observed cash decline and is not a guarantee or forecast.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:w-[360px]">
                  <div className="rounded-2xl bg-black/[0.03] p-4">
                    <p className="text-xs text-black/40">
                      Income evidence
                    </p>

                    <p className="mt-2 font-semibold capitalize">
                      {income?.evidence_state ||
                        "Insufficient"}
                    </p>
                  </div>

                  <div className="rounded-2xl bg-black/[0.03] p-4">
                    <p className="text-xs text-black/40">
                      Liquidity evidence
                    </p>

                    <p className="mt-2 font-semibold capitalize">
                      {runway?.evidence_state ||
                        balance?.evidence_state ||
                        "Insufficient"}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className="mt-8 rounded-3xl border border-black/10 p-6">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-black/40">
                    Observation window
                  </p>

                  <p className="mt-2 text-sm font-medium">
                    {dateLabel(
                      data.observation
                        .earliest_transaction_date
                    )}{" "}
                    through{" "}
                    {dateLabel(
                      data.observation
                        .latest_transaction_date
                    )}
                  </p>
                </div>

                <p className="max-w-xl text-xs leading-5 text-black/40">
                  iBag's conclusions are constrained by the financial history actually available from your authorized connections. More history can strengthen or change an observed pattern.
                </p>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
