"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { useRouter } from "next/navigation";

const API_URL = (
  process.env.NEXT_PUBLIC_API_URL ||
  "https://shave-api-4k1l.onrender.com"
).replace(/\/+$/, "");

type LinkTokenResponse = {
  status: string;
  link_token?: string;
  message?: string;
};

type ExchangeResponse = {
  status: string;
  plaid_item_id?: string;
  accounts_stored?: number;
  message?: string;
};

export default function ConnectPage() {
  const router = useRouter();

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function createLinkToken() {
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

        const data: LinkTokenResponse = await response.json();

        if (!response.ok || !data.link_token) {
          throw new Error(
            data.message ||
              "Unable to prepare a secure financial connection."
          );
        }

        if (!cancelled) {
          setLinkToken(data.link_token);
        }
      } catch (err) {
        console.error("Unable to create Plaid Link token:", err);

        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to connect your financial account right now."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    createLinkToken();

    return () => {
      cancelled = true;
    };
  }, [router]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      setConnecting(true);
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

        const data: ExchangeResponse = await response.json();

        if (!response.ok || data.status !== "ok") {
          throw new Error(
            data.message ||
              "The financial account could not be connected."
          );
        }

        router.replace("/dashboard");
      } catch (err) {
        console.error("Plaid account exchange failed:", err);

        setError(
          err instanceof Error
            ? err.message
            : "The financial account could not be connected."
        );
      } finally {
        setConnecting(false);
      }
    },

    onExit: (exitError) => {
      if (exitError) {
        console.error("Plaid Link exited with error:", exitError);
      }
    },
  });

  return (
    <main className="min-h-screen bg-white text-black">
      <section className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-6 py-6 sm:px-10">
          <Link
            href="/dashboard"
            className="text-2xl font-semibold tracking-tight"
          >
            iBag
          </Link>

          <Link
            href="/dashboard"
            className="text-sm font-medium text-black/60 transition hover:text-black"
          >
            Back to dashboard
          </Link>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pb-20">
          <div className="w-full max-w-md text-center">
            <p className="mb-4 text-sm font-medium uppercase tracking-[0.25em] text-black/40">
              Financial connection
            </p>

            <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
              Connect your money.
            </h1>

            <p className="mt-5 text-base leading-7 text-black/60">
              Securely connect a financial account so iBag can begin
              understanding your real financial picture.
            </p>

            <p className="mt-4 text-sm leading-6 text-black/40">
              You choose which financial institution and accounts to
              connect. iBag does not receive your bank password.
            </p>

            {error && (
              <div
                role="alert"
                className="mt-7 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm leading-6 text-red-700"
              >
                {error}
              </div>
            )}

            {loading ? (
              <div className="mt-8 rounded-full border border-black/10 px-6 py-4 text-sm text-black/50">
                Preparing secure connection...
              </div>
            ) : (
              <button
                type="button"
                onClick={() => open()}
                disabled={!ready || connecting}
                className="mt-8 w-full rounded-full bg-black px-6 py-4 text-base font-medium text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {connecting
                  ? "Connecting..."
                  : ready
                    ? "Connect a financial account"
                    : "Preparing secure connection..."}
              </button>
            )}

            <Link
              href="/dashboard"
              className="mt-5 block text-sm font-medium text-black/50 transition hover:text-black"
            >
              Return to dashboard
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
