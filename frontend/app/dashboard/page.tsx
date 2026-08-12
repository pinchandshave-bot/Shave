"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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

type LinkTokenResponse = {
  status: string;
  link_token?: string;
  message?: string;
};

type ExchangeResponse = {
  status: string;
  plaid_item_id?: string;
  accounts_stored?: number;
  immediate_sync?: unknown;
  message?: string;
};

type SummaryResponse = {
  status?: string;
  data?: unknown;
  message?: string;
};

export default function DashboardPage() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [ibag, setIbag] = useState<IBag | null>(null);

  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isPreparingPlaid, setIsPreparingPlaid] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState("");

  const [connectionCount, setConnectionCount] = useState<number | null>(null);

  /*
   * Establish the local iBag session.
   */
  useEffect(() => {
    const token = localStorage.getItem("ibag_token");
    const storedUser = localStorage.getItem("ibag_user");
    const storedIBag = localStorage.getItem("ibag");

    if (!token || !storedUser || !storedIBag) {
      router.replace("/start/signin");
      return;
    }

    try {
      setUser(JSON.parse(storedUser));
      setIbag(JSON.parse(storedIBag));
    } catch (err) {
      console.error("Invalid stored iBag session:", err);

      localStorage.removeItem("ibag_token");
      localStorage.removeItem("ibag_user");
      localStorage.removeItem("ibag");

      router.replace("/start/signin");
      return;
    }

    setIsCheckingAuth(false);
  }, [router]);

  /*
   * Load the user's current financial connection state.
   *
   * This does NOT fabricate data.
   * The dashboard only displays what the API actually returns.
   */
  useEffect(() => {
    if (!user) {
      return;
    }

    let cancelled = false;

    async function loadFinancialState() {
      const token = localStorage.getItem("ibag_token");

      if (!token) {
        router.replace("/start/signin");
        return;
      }

      try {
        const response = await fetch(`${API_URL}/me/accounts`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "no-store",
        });

        const data: SummaryResponse = await response.json();

        if (!response.ok) {
          throw new Error(
            data.message ||
              "Unable to load your financial connections."
          );
        }

        /*
         * The exact /me/accounts response structure belongs to
         * the existing backend. We only derive a count when the
         * returned payload is an array.
         */
        const possibleData = data?.data;

        if (Array.isArray(possibleData) && !cancelled) {
          setConnectionCount(possibleData.length);
        }
      } catch (err) {
        console.error(
          "Unable to load financial connections:",
          err
        );
      }
    }

    loadFinancialState();

    return () => {
      cancelled = true;
    };
  }, [user, router]);

  /*
   * Create the Plaid Link token only when the user actually
   * chooses to connect a financial account.
   */
  async function preparePlaidConnection() {
    setError("");
    setIsPreparingPlaid(true);

    const token = localStorage.getItem("ibag_token");

    if (!token) {
      router.replace("/start/signin");
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/plaid/create-link-token`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
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

      if (!response.ok || !data?.link_token) {
        throw new Error(
          data?.message ||
            `Unable to prepare Plaid Link. HTTP ${response.status}.`
        );
      }

      setLinkToken(data.link_token);
    } catch (err) {
      console.error(
        "Unable to create Plaid Link token:",
        err
      );

      setError(
        err instanceof Error
          ? err.message
          : "Unable to prepare the secure financial connection."
      );
    } finally {
      setIsPreparingPlaid(false);
    }
  }

  /*
   * Plaid Link.
   *
   * The Plaid interface itself is the connection experience.
   * iBag does not show an intermediate "Connect" page.
   */
  const { open, ready } = usePlaidLink({
    token: linkToken,

    onSuccess: async (publicToken, metadata) => {
      setIsConnecting(true);
      setError("");

      try {
        const token = localStorage.getItem("ibag_token");

        if (!token) {
          router.replace("/start/signin");
          return;
        }

        const response = await fetch(
          `${API_URL}/plaid/exchange-public-token`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
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

        if (!response.ok || data?.status !== "ok") {
          throw new Error(
            data?.message ||
              `The financial account could not be connected. HTTP ${response.status}.`
          );
        }

        /*
         * The backend performs the immediate Plaid sync.
         *
         * Return to the dashboard and let the dashboard load
         * the newly available real financial data.
         */
        setLinkToken(null);

        router.replace("/dashboard");

        /*
         * Force a fresh browser render after the redirect so
         * the dashboard does not remain visually stale.
         */
        router.refresh();
      } catch (err) {
        console.error(
          "Plaid account exchange failed:",
          err
        );

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
        console.error(
          "Plaid Link exited with error:",
          exitError
        );
      }

      setLinkToken(null);
    },
  });

  /*
   * Once the Link token exists, open Plaid automatically.
   *
   * This creates the exact experience:
   *
   * Dashboard
   *   ↓ click Connect
   * prepare token
   *   ↓
   * Plaid opens automatically
   */
  useEffect(() => {
    if (!linkToken || !ready || isConnecting) {
      return;
    }

    open();
  }, [linkToken, ready, isConnecting, open]);

  function handleConnectClick() {
    if (isPreparingPlaid || isConnecting) {
      return;
    }

    preparePlaidConnection();
  }

  function handleSignOut() {
    localStorage.removeItem("ibag_token");
    localStorage.removeItem("ibag_user");
    localStorage.removeItem("ibag");

    router.replace("/");
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

  const hasConnections =
    connectionCount !== null && connectionCount > 0;

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
            Welcome.
          </h1>

          <p className="mt-5 max-w-3xl text-base leading-7 text-black/60 sm:text-lg">
            Your financial picture becomes more intelligent as
            iBag receives real information from the accounts you
            choose to connect.
          </p>
        </section>

        {error && (
          <div
            role="alert"
            className="mt-8 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm leading-6 text-red-700"
          >
            {error}
          </div>
        )}

        <section className="mt-12 rounded-3xl border border-black/10 p-6 sm:p-8">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-medium text-black/50">
                Your financial picture
              </p>

              <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                {hasConnections
                  ? "Your connected financial data is ready."
                  : "Nothing connected yet."}
              </h2>

              <p className="mt-4 text-base leading-7 text-black/60">
                {hasConnections
                  ? "iBag is using the real financial information from the accounts you chose to connect."
                  : "Connect your debit or credit cards through Plaid so iBag can begin understanding your real financial activity."}
              </p>
            </div>

            <button
              type="button"
              onClick={handleConnectClick}
              disabled={isPreparingPlaid || isConnecting}
              className="shrink-0 rounded-full bg-black px-7 py-4 text-sm font-medium text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPreparingPlaid
                ? "Opening Plaid..."
                : isConnecting
                  ? "Connecting..."
                  : hasConnections
                    ? "Connect another account"
                    : "Connect financial accounts"}
            </button>
          </div>
        </section>

        <section className="mt-8 grid gap-6 sm:grid-cols-2">
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
              Financial connections
            </p>

            <p className="mt-3 text-2xl font-semibold">
              {connectionCount === null
                ? "—"
                : connectionCount}
            </p>

            <p className="mt-2 text-sm text-black/40">
              {connectionCount === null
                ? "Loading connected accounts"
                : connectionCount === 0
                  ? "No financial accounts connected"
                  : "Connected financial accounts"}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
