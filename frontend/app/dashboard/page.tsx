```tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type User = {
  id: string;
  email: string;
};

type IBag = {
  id: string;
  user_id: string;
  created_at: string;
};

export default function DashboardPage() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [ibag, setIbag] = useState<IBag | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

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
    } catch (error) {
      console.error("Invalid stored iBag session:", error);

      localStorage.removeItem("ibag_token");
      localStorage.removeItem("ibag_user");
      localStorage.removeItem("ibag");

      router.replace("/start/signin");
      return;
    }

    setIsCheckingAuth(false);
  }, [router]);

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

      <div className="mx-auto w-full max-w-5xl px-6 py-12 sm:px-10 sm:py-16">
        <section>
          <p className="text-sm font-medium uppercase tracking-[0.25em] text-black/40">
            Your iBag
          </p>

          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">
            Welcome.
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-7 text-black/60 sm:text-lg">
            Your iBag is ready. Connect a financial account when
            you're ready for iBag to begin understanding your money.
          </p>
        </section>

        <section className="mt-12 rounded-3xl border border-black/10 p-6 sm:p-8">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-black/50">
              Your financial picture
            </p>

            <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              Nothing connected yet.
            </h2>

            <p className="mt-4 text-base leading-7 text-black/60">
              Connect a financial account to give iBag real financial
              information to understand. You stay in control of which
              accounts you connect.
            </p>

            <Link
              href="/connect"
              className="mt-7 inline-block rounded-full bg-black px-7 py-4 text-sm font-medium text-white transition hover:bg-black/80"
            >
              Connect financial accounts
            </Link>
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
              0
            </p>

            <p className="mt-2 text-sm text-black/40">
              No financial accounts connected
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
```
