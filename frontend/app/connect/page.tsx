"use client";

import { useEffect, useRef, useState } from "react";
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
  immediate_sync?: unknown;
  message?: string;
};

export default function ConnectPage() {
  const router = useRouter();

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const hasOpenedPlaid = useRef(false);

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
              "Unable to prepare the secure Plaid connection."
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
              : "Unable to connect to Plaid right now."
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
              "Plaid connected successfully, but iBag could not finish storing the connection."
          );
        }

        /*
         * The backend performs the immediate post-link sync.
         * Once that succeeds, return the user to the dashboard.
         */
        router.replace("/dashboard");
      } catch (err) {
        console.error("Plaid account exchange failed:", err);

        setError(
          err instanceof Error
            ? err.message
            : "The financial connection could not be completed."
        );
      } finally {
        setConnecting(false);
      }
    },

    onExit: (exitError) => {
      if (exitError) {
        console.error("Plaid Link exited with error:", exitError);
      }

      setConnecting(false);
    },
  });

  useEffect(() => {
    if (
      ready &&
      linkToken &&
      !hasOpenedPlaid.current &&
      !connecting
    ) {
      hasOpenedPlaid.current = true;
      open();
    }
  }, [ready, linkToken, connecting, open]);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white px-6 text-black">
        <p className="text-sm text-black/50">
          Opening secure financial connection...
        </p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white px-6 text-black">
        <div className="w-full max-w-md text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            Financial connection unavailable.
          </h1>

          <p className="mt-4 text-sm leading-6 text-black/60">
            {error}
          </p>

          <button
            type="button"
            onClick={() => router.replace("/dashboard")}
            className="mt-7 rounded-full bg-black px-7 py-4 text-sm font-medium text-white"
          >
            Return to dashboard
          </button>
        </div>
      </main>
    );
  }

  /*
   * Plaid should automatically open.
   * This page intentionally does not present a second
   * "Connect financial account" button.
   */
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 text-black">
      <div className="w-full max-w-md text-center">
        <p className="text-sm text-black/50">
          {connecting
            ? "Finishing your secure financial connection..."
            : "Opening secure financial connection..."}
        </p>
      </div>
    </main>
  );
}
