"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://shave-api-4k1l.onrender.com";

export default function CreatePage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError("");

    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) {
      setError("Enter your email address.");
      return;
    }

    if (!password) {
      setError("Create a password.");
      return;
    }

    if (password.length < 8) {
      setError("Your password must be at least 8 characters.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_URL}/auth/signup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password,
        }),
      });

      const responseText = await response.text();

      let data: any = null;

      try {
        data = JSON.parse(responseText);
      } catch {
        data = null;
      }

      if (!response.ok) {
        setError(
          data?.message ||
            `The server returned an error while creating your iBag. HTTP ${response.status}.`
        );
        return;
      }

      if (
        data?.status !== "ok" ||
        !data?.token ||
        !data?.user?.id ||
        !data?.ibag?.id
      ) {
        setError(
          "The server responded, but the account creation response was incomplete."
        );
        return;
      }

      /*
       * Store the authenticated state returned by signup.
       *
       * The user does NOT need to sign in again.
       */
      localStorage.setItem("ibag_token", data.token);

      localStorage.setItem(
        "ibag_user",
        JSON.stringify({
          id: data.user.id,
          email: data.user.email,
        })
      );

      localStorage.setItem(
        "ibag",
        JSON.stringify({
          id: data.ibag.id,
          user_id: data.ibag.user_id,
          created_at: data.ibag.created_at,
        })
      );

      /*
       * Account creation is complete.
       *
       * Dashboard is the authenticated application entry point.
       * Financial-account connection happens from the dashboard.
       */
      router.replace("/dashboard");
    } catch (err) {
      console.error("iBag signup request failed:", err);

      setError(
        "The browser could not reach the iBag API. This is usually a connection or CORS configuration problem."
      );
    } finally {
      setIsSubmitting(false);
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
                Create your account first. You decide which financial
                accounts iBag can understand later.
              </p>
            </div>

            <form onSubmit={handleSubmit} noValidate>
              <div className="space-y-5">
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
                    disabled={isSubmitting}
                    placeholder="you@example.com"
                    className="w-full rounded-2xl border border-black/15 bg-white px-5 py-4 text-base outline-none transition placeholder:text-black/30 focus:border-black/40 focus:ring-2 focus:ring-black/5 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>

                <div>
                  <label
                    htmlFor="password"
                    className="mb-2 block text-sm font-medium"
                  >
                    Password
                  </label>

                  <div className="relative">
                    <input
                      id="password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      disabled={isSubmitting}
                      placeholder="At least 8 characters"
                      className="w-full rounded-2xl border border-black/15 bg-white px-5 py-4 pr-24 text-base outline-none transition placeholder:text-black/30 focus:border-black/40 focus:ring-2 focus:ring-black/5 disabled:cursor-not-allowed disabled:opacity-60"
                    />

                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      disabled={isSubmitting}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium text-black/50 transition hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>

                  <p className="mt-2 text-xs text-black/40">
                    Use at least 8 characters.
                  </p>
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="mt-7 w-full rounded-full bg-black px-6 py-4 text-base font-medium text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting
                  ? "Creating your iBag..."
                  : "Create your iBag"}
              </button>
            </form>

            <div className="mt-7 text-center">
              <p className="text-sm text-black/50">
                Already have an iBag?{" "}
                <Link
                  href="/start/signin"
                  className="font-medium text-black transition hover:text-black/60"
                >
                  Sign in
                </Link>
              </p>
            </div>

            <p className="mt-8 text-center text-xs leading-5 text-black/40">
              Your financial information is connected only after you choose
              to connect an account.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
