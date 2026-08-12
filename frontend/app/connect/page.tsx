```tsx
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
  message?: string;
};

export default function ConnectPage() {
  const router = useRouter();

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const openedRef = useRef(false);

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
              "Unable to prepare the secure financial connection."
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

        setConnecting(false);
      }
    },

    onExit: (exitError) => {
      if (exitError) {
        console.error("Plaid Link exited with error:", exitError);
      }

      if (!connecting) {
        router.replace("/dashboard");
      }
    },
  });

  useEffect(() => {
    if (
      !loading &&
      linkToken &&
      ready &&
      !openedRef.current &&
      !connecting &&
      !error
    ) {
      openedRef.current = true;
      open();
    }
  }, [
    loading,
    linkToken,
    ready,
    connecting,
    error,
    open,
  ]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white px-6 text-black">
        <div className="w-full max-w-md text-center">
          <h1 className="text-2xl font-semibold">
            We couldn't connect your account.
          </h1>

          <p className="mt-4 text-sm leading-6 text-black/60">
            {error}
          </p>

          <button
            type="button"
            onClick={() => router.replace("/dashboard")}
            className="mt-7 rounded-full bg-black px-6 py-4 text-sm font-medium text-white transition hover:bg-black/80"
          >
            Return to dashboard
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 text-black">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-black/10 border-t-black" />

        <p className="mt-5 text-sm text-black/50">
          {connecting
            ? "Finishing your connection..."
            : "Opening secure connection..."}
        </p>
      </div>
    </main>
  );
}
```
