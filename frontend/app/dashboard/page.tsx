"use client";

import Link from "next/link";
import {
  useEffect,
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
  generated_at: string;

  user?: {
    id: string;
    email: string;
    created_at: string;
  } | null;

  evidence: {
    accounts: string;
    transactions: string;
    roundup: string;
    income: string;
    cash_flow: string;
    balance: string;
    behavior: string;
  };

  observation: {
    earliest_transaction_date: string | null;
    latest_transaction_date: string | null;
    transaction_count: number;
  };

  accounts: {
    count: number;
    depository_count: number;
  };

  roundup: {
    evidence_state: string;
    eligible_purchase_count: number;
    opportunity: number;
    average: number;
    median: number;
    smallest: number;
    largest: number;

    category_concentration: Array<{
      name: string;
      purchases: number;
      opportunity: number;
      share: number;
    }>;

    merchant_concentration: Array<{
      name: string;
      purchases: number;
      opportunity: number;
      share: number;
    }>;

    recent: Array<{
      id: string;
      transaction_id: string;
      amount: number | string;
      roundup_amount: number | string;
      merchant_name: string | null;
      category: string | null;
      pending: boolean;
      authorized_date: string | null;
      posted_date: string | null;
      iso_currency_code: string | null;
      account_name: string | null;
      account_mask: string | null;
    }>;
  };

  income: {
    evidence_state: string;

    signal: {
      source: string | null;
      grouping: string;
      cadence: string;
      typical_amount: number;
      occurrences: number;
      reliability: number;
      amount_consistency: number;
      confidence: string;
      last_detected_date: string | null;
      next_expected_date: string | null;
    } | null;

    candidates: Array<{
      source: string | null;
      grouping: string;
      cadence: string;
      typical_amount: number;
      occurrences: number;
      reliability: number;
      amount_consistency: number;
      confidence: string;
      last_detected_date: string | null;
      next_expected_date: string | null;
    }>;
  };

  cash_flow: {
    evidence_state: string;
    observation_days: number;
    earliest_date: string | null;
    latest_date: string | null;
    transaction_count: number;
    inflow: number;
    outflow: number;
    net_change: number | null;
    daily_inflow: number | null;
    daily_outflow: number | null;
    daily_net_change: number | null;
    direction: string;
  };

  balance: {
    evidence_state: string;
    total_cash: number | null;
    runway_days: number | null;
    runway_months: number | null;
    daily_burn: number | null;
    status: string;
  };

  behavior: {
    evidence_state: string;
    posted_transaction_count: number;
    total_observed_spend: number;
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

  insights: Insight[];
};


/* ============================================================================
 * DISPLAY HELPERS
 * ========================================================================== */

function numberValue(
  value: number | string | null | undefined
) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}


function money(
  value: number | string | null | undefined,
  currency = "USD"
) {
  const amount = numberValue(value);

  if (amount === null) {
    return "—";
  }

  try {
    return new Intl.NumberFormat(
      "en-US",
      {
        style: "currency",
        currency:
          currency.length === 3
            ? currency
            : "USD",
        maximumFractionDigits: 2,
      }
    ).format(amount);
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

  const date =
    new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  ).format(date);
}


function percent(value: number) {
  return `${(
    Math.max(0, value) * 100
  ).toFixed(1)}%`;
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
    return "The financial intelligence service could not complete this request.";
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


/* ============================================================================
 * PRESENTATION COMPONENTS
 * ========================================================================== */

function SectionLabel({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <p className="text-xs font-medium uppercase tracking-[0.2em] text-black/40">
      {children}
    </p>
  );
}


function EvidenceBadge({
  state,
}: {
  state?: string;
}) {
  const normalized =
    state || "insufficient_evidence";

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
      <p className="text-sm text-black/50">
        {label}
      </p>

      <p className="mt-3 text-3xl font-semibold tracking-tight">
        {value}
      </p>

      <p className="mt-2 text-sm leading-5 text-black/40">
        {description}
      </p>
    </div>
  );
}


/* ============================================================================
 * PAGE
 * ========================================================================== */

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
              "ibag_token"
            )
          : null;

      if (!token) {
        router.replace(
          "/start/signin"
        );
        return;
      }

      try {
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
            body =
              JSON.parse(
                responseText
              );
          } catch {
            body = {
              status: "error",
              message:
                responseText,
            };
          }
        }

        if (
          response.status === 401
        ) {
          localStorage.removeItem(
            "ibag_token"
          );

          localStorage.removeItem(
            "ibag_user"
          );

          localStorage.removeItem(
            "ibag"
          );

          router.replace(
            "/start/signin"
          );

          return;
        }

        if (!response.ok) {
          if (!cancelled) {
            setHttpStatus(
              response.status
            );
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
            "The API returned an invalid financial-intelligence response."
          );
        }

        if (!cancelled) {
          setData(
            body as DashboardData
          );
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
              : "Unable to load your financial picture."
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
      "ibag_token"
    );

    localStorage.removeItem(
      "ibag_user"
    );

    localStorage.removeItem(
      "ibag"
    );

    router.replace("/");
  }


  function retry() {
    setAttempt(
      current => current + 1
    );
  }


  /* ==========================================================================
   * LOADING
   * ======================================================================== */

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


  /* ==========================================================================
   * ERROR
   * ======================================================================== */

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


  /* ==========================================================================
   * AUTHORITATIVE DATA
   * ======================================================================== */

  const hasAccounts =
    data.accounts.count > 0;

  const hasTransactions =
    data.observation.transaction_count >
    0;

  const cashFlow =
    data.cash_flow;

  const balance =
    data.balance;

  const income =
    data.income;

  const behavior =
    data.behavior;

  const roundup =
    data.roundup;

  const insights =
    data.insights;


  /* ==========================================================================
   * DASHBOARD
   * ======================================================================== */

  return (
    <main className="min-h-screen bg-white text-black">

      {/* ----------------------------------------------------------------------
          HEADER
      ----------------------------------------------------------------------- */}

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

        {/* --------------------------------------------------------------------
            HERO
        --------------------------------------------------------------------- */}

        <section>
          <SectionLabel>
            Your iBag
          </SectionLabel>

          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
            Your financial picture.
          </h1>

          <p className="mt-5 max-w-3xl text-base leading-7 text-black/60 sm:text-lg">
            iBag turns the financial information you authorized into measurable, explainable financial intelligence.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <EvidenceBadge
              state={
                data.evidence.transactions
              }
            />

            <span className="text-xs text-black/40">
              Observation:{" "}
              {dateLabel(
                data.observation
                  .earliest_transaction_date
              )}{" "}
              —{" "}
              {dateLabel(
                data.observation
                  .latest_transaction_date
              )}
            </span>
          </div>
        </section>


        {/* --------------------------------------------------------------------
            TOP METRICS
        --------------------------------------------------------------------- */}

        <section className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">

          <MetricCard
            label="Accounts"
            value={
              data.accounts.count
            }
            description={`${data.accounts.depository_count} depository account${data.accounts.depository_count === 1 ? "" : "s"}`}
          />

          <MetricCard
            label="Transactions observed"
            value={
              data.observation
                .transaction_count
            }
            description="Authorized transaction history available to iBag"
          />

          <MetricCard
            label="Round-Up opportunities"
            value={
              roundup.eligible_purchase_count
            }
            description="Eligible purchases supported by the available evidence"
          />

          <MetricCard
            label="Round-Up opportunity"
            value={money(
              roundup.opportunity
            )}
            description="Calculated analytical opportunity — no money moved"
          />

        </section>


        {/* --------------------------------------------------------------------
            NO ACCOUNTS
        --------------------------------------------------------------------- */}

        {!hasAccounts && (
          <section className="mt-8 rounded-3xl border border-black/10 p-8">
            <EvidenceBadge
              state="insufficient_evidence"
            />

            <h2 className="mt-4 text-3xl font-semibold">
              Connect a financial account to begin.
            </h2>

            <p className="mt-4 max-w-2xl text-black/60">
              iBag only creates financial intelligence from financial information you authorize.
            </p>

            <Link
              href="/connect"
              className="mt-7 inline-flex rounded-full bg-black px-7 py-4 text-sm font-medium text-white"
            >
              Connect financial accounts
            </Link>
          </section>
        )}


        {/* --------------------------------------------------------------------
            ACCOUNTS BUT NO TRANSACTIONS
        --------------------------------------------------------------------- */}

        {hasAccounts &&
          !hasTransactions && (
            <section className="mt-8 rounded-3xl border border-black/10 p-8">
              <EvidenceBadge
                state={
                  data.evidence.accounts
                }
              />

              <h2 className="mt-4 text-3xl font-semibold">
                Your accounts are connected.
              </h2>

              <p className="mt-4 max-w-2xl text-black/60">
                iBag is waiting for transaction history. It will not fabricate financial conclusions while evidence is insufficient.
              </p>
            </section>
          )}


        {hasTransactions && (
          <>

            {/* ================================================================
                FINANCIAL INTELLIGENCE
            ================================================================= */}

            <section className="mt-16">

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">

                <div>
                  <SectionLabel>
                    Financial intelligence
                  </SectionLabel>

                  <h2 className="mt-2 text-3xl font-semibold tracking-tight">
                    What the data supports.
                  </h2>
                </div>

                <p className="text-xs text-black/40">
                  Read-only · evidence-gated
                </p>

              </div>


              <div className="mt-6 grid gap-5 lg:grid-cols-3">

                {/* --------------------------------------------------------------
                    CASH FLOW
                --------------------------------------------------------------- */}

                <div className="rounded-3xl border border-black/10 p-6">

                  <EvidenceBadge
                    state={
                      cashFlow.evidence_state
                    }
                  />

                  <p className="mt-5 text-sm font-medium text-black/50">
                    Cash flow
                  </p>

                  {cashFlow.net_change !==
                  null ? (
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

                      <div className="mt-5 flex justify-between text-sm">
                        <span className="text-black/40">
                          Direction
                        </span>

                        <span className="font-medium capitalize">
                          {cashFlow.direction}
                        </span>
                      </div>

                      <p className="mt-4 text-xs leading-5 text-black/40">
                        Based on{" "}
                        {cashFlow.observation_days}{" "}
                        observed day
                        {cashFlow.observation_days === 1 ? "" : "s"}.
                      </p>
                    </>
                  ) : (
                    <p className="mt-5 text-sm leading-6 text-black/50">
                      More transaction history is required to calculate cash-flow direction.
                    </p>
                  )}

                </div>


                {/* --------------------------------------------------------------
                    LIQUIDITY
                --------------------------------------------------------------- */}

                <div className="rounded-3xl border border-black/10 p-6">

                  <EvidenceBadge
                    state={
                      balance.evidence_state
                    }
                  />

                  <p className="mt-5 text-sm font-medium text-black/50">
                    Liquidity
                  </p>

                  <p className="mt-3 text-3xl font-semibold">
                    {money(
                      balance.total_cash
                    )}
                  </p>

                  <p className="mt-2 text-sm text-black/50">
                    Current depository balances
                  </p>

                  {balance.runway_days !==
                  null ? (
                    <div className="mt-6 rounded-2xl bg-black/[0.03] p-4">

                      <p className="text-xs text-black/40">
                        Observed net-cash runway
                      </p>

                      <p className="mt-2 text-2xl font-semibold">
                        {balance.runway_days}{" "}
                        days
                      </p>

                      {balance.runway_months !==
                        null && (
                        <p className="mt-1 text-sm text-black/50">
                          Approximately{" "}
                          {balance.runway_months}{" "}
                          months
                        </p>
                      )}

                      <p className="mt-3 text-xs leading-5 text-black/40">
                        Mathematical projection from observed net cash decline. It is not a forecast of future income or expenses.
                      </p>

                    </div>
                  ) : (
                    <p className="mt-6 text-sm leading-6 text-black/40">
                      A finite net-cash runway is not currently supported by the available evidence.
                    </p>
                  )}

                </div>


                {/* --------------------------------------------------------------
                    INCOME
                --------------------------------------------------------------- */}

                <div className="rounded-3xl border border-black/10 p-6">

                  <EvidenceBadge
                    state={
                      income.evidence_state
                    }
                  />

                  <p className="mt-5 text-sm font-medium text-black/50">
                    Recurring income signal
                  </p>

                  {income.signal ? (
                    <>
                      <p className="mt-3 text-3xl font-semibold">
                        {money(
                          income.signal
                            .typical_amount
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
                              "Not identified"}
                          </span>
                        </div>

                        <div className="flex justify-between gap-4">
                          <span className="text-black/40">
                            Occurrences
                          </span>

                          <span className="font-medium">
                            {income.signal.occurrences}
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
                              income.signal
                                .next_expected_date
                            )}
                          </span>
                        </div>

                      </div>

                      <p className="mt-5 text-xs leading-5 text-black/40">
                        Pattern inference from repeated transactions. Not a guarantee of future income.
                      </p>
                    </>
                  ) : (
                    <p className="mt-5 text-sm leading-6 text-black/50">
                      iBag does not yet have enough recurring transaction evidence to identify an income pattern.
                    </p>
                  )}

                </div>

              </div>
            </section>


            {/* ================================================================
                ROUND-UP INTELLIGENCE
            ================================================================= */}

            <section className="mt-16 rounded-3xl border border-black/10 p-8">

              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">

                <div>
                  <EvidenceBadge
                    state={
                      roundup.evidence_state
                    }
                  />

                  <p className="mt-5 text-xs font-medium uppercase tracking-[0.2em] text-black/40">
                    First intelligence domain
                  </p>

                  <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                    Round-Up intelligence.
                  </h2>

                  <p className="mt-4 max-w-3xl text-base leading-7 text-black/60">
                    iBag identifies the analytical Round-Up opportunity contained in eligible real-world purchases. No money is transferred, saved, or moved by this Phase 1 intelligence.
                  </p>
                </div>

                <div className="rounded-2xl bg-black/[0.03] px-5 py-4 text-sm">
                  <p className="text-xs text-black/40">
                    Evidence
                  </p>

                  <p className="mt-1 font-semibold">
                    {roundup.eligible_purchase_count}{" "}
                    eligible purchases
                  </p>
                </div>

              </div>


              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">

                <MetricCard
                  label="Opportunity"
                  value={money(
                    roundup.opportunity
                  )}
                  description="Total calculated opportunity"
                />

                <MetricCard
                  label="Average"
                  value={money(
                    roundup.average
                  )}
                  description="Average opportunity per purchase"
                />

                <MetricCard
                  label="Median"
                  value={money(
                    roundup.median
                  )}
                  description="Median opportunity"
                />

                <MetricCard
                  label="Smallest"
                  value={money(
                    roundup.smallest
                  )}
                  description="Smallest observed opportunity"
                />

                <MetricCard
                  label="Largest"
                  value={money(
                    roundup.largest
                  )}
                  description="Largest observed opportunity"
                />

              </div>

            </section>


            {/* ================================================================
                ROUND-UP CATEGORY + MERCHANT CONCENTRATION
            ================================================================= */}

            <section className="mt-8 grid gap-8 lg:grid-cols-2">

              <div className="rounded-3xl border border-black/10 p-8">

                <SectionLabel>
                  Round-Up concentration
                </SectionLabel>

                <h2 className="mt-2 text-2xl font-semibold">
                  Where opportunity is generated.
                </h2>

                {roundup.category_concentration.length ? (
                  <div className="mt-7 space-y-6">

                    {roundup.category_concentration
                      .slice(0, 8)
                      .map(
                        category => (
                          <div
                            key={
                              category.name
                            }
                          >

                            <div className="flex justify-between gap-4">

                              <div>
                                <p className="font-medium">
                                  {category.name}
                                </p>

                                <p className="mt-1 text-xs text-black/40">
                                  {
                                    category.purchases
                                  }{" "}
                                  purchases
                                </p>
                              </div>

                              <div className="text-right">
                                <p className="font-semibold">
                                  {money(
                                    category.opportunity
                                  )}
                                </p>

                                <p className="mt-1 text-xs text-black/40">
                                  {percent(
                                    category.share
                                  )}
                                </p>
                              </div>

                            </div>

                            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">

                              <div
                                className="h-full rounded-full bg-black"
                                style={{
                                  width: `${Math.min(
                                    100,
                                    Math.max(
                                      0,
                                      category.share *
                                        100
                                    )
                                  )}%`,
                                }}
                              />

                            </div>

                          </div>
                        )
                      )}

                  </div>
                ) : (
                  <p className="mt-6 text-sm text-black/50">
                    Category concentration cannot be established from the available evidence.
                  </p>
                )}

              </div>


              <div className="rounded-3xl border border-black/10 p-8">

                <SectionLabel>
                  Merchant concentration
                </SectionLabel>

                <h2 className="mt-2 text-2xl font-semibold">
                  Where opportunity is concentrated.
                </h2>

                {roundup.merchant_concentration.length ? (
                  <div className="mt-7 space-y-5">

                    {roundup.merchant_concentration
                      .slice(0, 8)
                      .map(
                        merchant => (
                          <div
                            key={
                              merchant.name
                            }
                            className="flex items-center justify-between gap-5"
                          >

                            <div>
                              <p className="font-medium">
                                {merchant.name}
                              </p>

                              <p className="mt-1 text-xs text-black/40">
                                {
                                  merchant.purchases
                                }{" "}
                                purchases
                              </p>
                            </div>

                            <div className="text-right">
                              <p className="font-semibold">
                                {money(
                                  merchant.opportunity
                                )}
                              </p>

                              <p className="mt-1 text-xs text-black/40">
                                {percent(
                                  merchant.share
                                )}
                              </p>
                            </div>

                          </div>
                        )
                      )}

                  </div>
                ) : (
                  <p className="mt-6 text-sm text-black/50">
                    Merchant concentration cannot be established from the available evidence.
                  </p>
                )}

              </div>

            </section>


            {/* ================================================================
                BEHAVIOR
            ================================================================= */}

            <section className="mt-8 rounded-3xl border border-black/10 p-8">

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">

                <div>
                  <EvidenceBadge
                    state={
                      behavior.evidence_state
                    }
                  />

                  <h2 className="mt-4 text-3xl font-semibold">
                    Observed spending behavior.
                  </h2>

                  <p className="mt-3 max-w-2xl text-sm leading-6 text-black/50">
                    This describes the transaction history available to iBag. It does not label spending as good, bad, necessary, or unnecessary.
                  </p>
                </div>

                <div className="text-right">

                  <p className="text-xs text-black/40">
                    Observed spend
                  </p>

                  <p className="mt-1 text-2xl font-semibold">
                    {money(
                      behavior.total_observed_spend
                    )}
                  </p>

                </div>

              </div>


              {behavior.top_categories.length ? (
                <div className="mt-8 grid gap-8 lg:grid-cols-2">

                  <div>
                    <p className="text-sm font-medium">
                      Categories
                    </p>

                    <div className="mt-5 space-y-5">

                      {behavior.top_categories
                        .slice(0, 8)
                        .map(
                          category => (
                            <div
                              key={
                                category.name
                              }
                              className="flex items-center justify-between gap-5"
                            >

                              <div>
                                <p className="font-medium">
                                  {category.name}
                                </p>

                                <p className="mt-1 text-xs text-black/40">
                                  {
                                    category.transactions
                                  }{" "}
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
                                  {percent(
                                    category.share
                                  )}
                                </p>
                              </div>

                            </div>
                          )
                        )}

                    </div>
                  </div>


                  <div>
                    <p className="text-sm font-medium">
                      Merchants
                    </p>

                    <div className="mt-5 space-y-5">

                      {behavior.top_merchants
                        .slice(0, 8)
                        .map(
                          merchant => (
                            <div
                              key={
                                merchant.name
                              }
                              className="flex items-center justify-between gap-5"
                            >

                              <div>
                                <p className="font-medium">
                                  {merchant.name}
                                </p>

                                <p className="mt-1 text-xs text-black/40">
                                  {
                                    merchant.transactions
                                  }{" "}
                                  transactions
                                </p>
                              </div>

                              <div className="text-right">
                                <p className="font-semibold">
                                  {money(
                                    merchant.spend
                                  )}
                                </p>

                                <p className="mt-1 text-xs text-black/40">
                                  {percent(
                                    merchant.share
                                  )}
                                </p>
                              </div>

                            </div>
                          )
                        )}

                    </div>
                  </div>

                </div>
              ) : (
                <p className="mt-7 text-sm text-black/50">
                  More posted transaction evidence is required to establish spending concentration.
                </p>
              )}

            </section>


            {/* ================================================================
                EXPLAINABLE INSIGHTS
            ================================================================= */}

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

                  {insights.map(
                    insight => (
                      <article
                        key={
                          insight.id
                        }
                        className="rounded-2xl bg-black/[0.03] p-6"
                      >

                        <div className="flex items-center justify-between gap-4">

                          <p className="text-xs font-medium uppercase tracking-[0.16em] text-black/40">
                            {
                              insight.type
                            }
                          </p>

                          <span className="text-xs font-medium text-black/40">
                            {
                              insight.confidence
                            }{" "}
                            confidence
                          </span>

                        </div>

                        <h3 className="mt-4 text-xl font-semibold">
                          {
                            insight.title
                          }
                        </h3>

                        <p className="mt-3 text-sm leading-6 text-black/60">
                          {
                            insight.statement
                          }
                        </p>

                        {insight.qualification && (
                          <p className="mt-4 text-xs leading-5 text-black/40">
                            {
                              insight.qualification
                            }
                          </p>
                        )}

                      </article>
                    )
                  )}

                </div>
              ) : (
                <div className="mt-7 rounded-2xl bg-black/[0.03] p-6">
                  <p className="text-sm leading-6 text-black/50">
                    iBag has financial data, but there is not yet enough evidence to produce a higher-order insight responsibly.
                  </p>
                </div>
              )}

            </section>


            {/* ================================================================
                RECENT ROUND-UP EVIDENCE
            ================================================================= */}

            <section className="mt-8 rounded-3xl border border-black/10 p-8">

              <SectionLabel>
                Underlying evidence
              </SectionLabel>

              <h2 className="mt-2 text-2xl font-semibold">
                Recent Round-Up events.
              </h2>

              {roundup.recent.length ? (
                <div className="mt-6 divide-y divide-black/5">

                  {roundup.recent.map(
                    event => (
                      <div
                        key={
                          event.id
                        }
                        className="flex flex-col gap-3 py-5 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
                      >

                        <div>

                          <p className="font-medium">
                            {
                              event.merchant_name ||
                              "Unknown merchant"
                            }
                          </p>

                          <p className="mt-1 text-sm text-black/40">
                            {
                              event.category ||
                              "Uncategorized"
                            }{" "}
                            ·{" "}
                            {event.pending
                              ? "Pending"
                              : dateLabel(
                                  event.posted_date ||
                                    event.authorized_date
                                )}
                          </p>

                          {event.account_name && (
                            <p className="mt-1 text-xs text-black/30">
                              {
                                event.account_name
                              }

                              {event.account_mask
                                ? ` · •••• ${event.account_mask}`
                                : ""}
                            </p>
                          )}

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
              ) : (
                <p className="mt-6 text-sm text-black/50">
                  No eligible Round-Up events are currently supported by the available evidence.
                </p>
              )}

            </section>


            {/* ================================================================
                EVIDENCE METHODOLOGY
            ================================================================= */}

            <section className="mt-8 rounded-3xl border border-black/10 p-8">

              <SectionLabel>
                Evidence architecture
              </SectionLabel>

              <h2 className="mt-2 text-2xl font-semibold">
                How iBag knows what it knows.
              </h2>

              <p className="mt-4 max-w-3xl text-sm leading-6 text-black/50">
                iBag separates direct observations from deterministic calculations and transaction-pattern inferences. When evidence is insufficient, the system says so rather than filling the gap with an assumption.
              </p>


              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">

                <div className="rounded-2xl bg-black/[0.03] p-5">
                  <p className="font-semibold">
                    Observed
                  </p>

                  <p className="mt-2 text-sm leading-5 text-black/50">
                    Directly present in authorized financial records.
                  </p>
                </div>

                <div className="rounded-2xl bg-black/[0.03] p-5">
                  <p className="font-semibold">
                    Calculated
                  </p>

                  <p className="mt-2 text-sm leading-5 text-black/50">
                    Deterministically derived from observed records.
                  </p>
                </div>

                <div className="rounded-2xl bg-black/[0.03] p-5">
                  <p className="font-semibold">
                    Inferred
                  </p>

                  <p className="mt-2 text-sm leading-5 text-black/50">
                    A pattern supported by sufficient transaction evidence.
                  </p>
                </div>

                <div className="rounded-2xl bg-black/[0.03] p-5">
                  <p className="font-semibold">
                    Insufficient
                  </p>

                  <p className="mt-2 text-sm leading-5 text-black/50">
                    iBag does not have enough evidence to responsibly conclude.
                  </p>
                </div>

              </div>

            </section>


            {/* ================================================================
                OBSERVATION WINDOW
            ================================================================= */}

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
                  iBag's conclusions are constrained by the financial history actually available from your authorized connections. Additional history can strengthen, weaken, or change an observed pattern.
                </p>

              </div>

            </section>

          </>
        )}

      </div>
    </main>
  );
}
