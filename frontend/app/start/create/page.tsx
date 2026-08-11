```tsx
"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

export default function CreatePage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError("");

    if (!API_URL) {
      setError("The iBag connection is not configured yet.");
      return;
    }

    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }

    if (password.length < 8) {
      setError("Your password must be at least 8 characters.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/auth/signup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(
          data?.message ||
            "We couldn't create your account. Please try again."
        );
        return;
      }

      if (!data?.token || !data?.user?.id) {
        setError(
          "Your account was not created correctly. Please try again."
        );
        return;
      }

      sessionStorage.setItem("ibag_token", data.token);
      sessionStorage.setItem(
        "ibag_user",
        JSON.stringify(data.user)
      );

      router.push("/start/connect");
    } catch {
      setError(
        "We couldn't connect to iBag right now. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-white text-black">
      <section className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-6 py-6 sm:px-10">
          <Link
            href="/"
            className="text-2xl font-semibold tracking-tight"
          >
            iBag
          </Link>

          <Link
            href="/start"
            className="text-sm font-medium text-black/60 transition hover:text-black"
          >
            Back
          </Link>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pb-20">
          <div className="w-full max-w-md">
            <div className="mb-10 text-center">
              <p className="mb-4 text-sm font-medium uppercase tracking-[0.25em] text-black/40">
                Create your iBag
              </p>

              <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
                Start with you.
              </h1>

              <p className="mt-5 text-base leading-7 text-black/60">
                Create your account, then choose the financial accounts
                you want iBag to understand.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="email"
                  className="mb-2 block text-sm font-medium"
                >
                  Email
                </label>

                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  disabled={loading}
                  className="w-full rounded-2xl border border-black/15 bg-white px-5 py-4 text-base outline-none transition placeholder:text-black/30 focus:border-black/40 disabled:opacity-50"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="mb-2 block text-sm font-medium"
                >
                  Password
                </label>

                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  disabled={loading}
                  className="w-full rounded-2xl border border-black/15 bg-white px-5 py-4 text-base outline-none transition placeholder:text-black/30 focus:border-black/40 disabled:opacity-50"
                />
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-2xl bg-black/[0.04] px-4 py-3 text-sm leading-6 text-black/70"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-full bg-black px-6 py-4 text-base font-medium text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Creating your iBag..." : "Continue"}
              </button>
            </form>

            <p className="mt-8 text-center text-xs leading-5 text-black/40">
              Your financial information is not connected until you
              choose to connect an account.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
```
