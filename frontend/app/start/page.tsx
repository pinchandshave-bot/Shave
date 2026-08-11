import Link from "next/link";

export default function StartPage() {
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
            href="/"
            className="text-sm font-medium text-black/60 transition hover:text-black"
          >
            Back
          </Link>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pb-20">
          <div className="w-full max-w-md">
            <div className="mb-10 text-center">
              <p className="mb-4 text-sm font-medium uppercase tracking-[0.25em] text-black/40">
                Welcome to iBag
              </p>

              <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
                Start with you.
              </h1>

              <p className="mt-5 text-base leading-7 text-black/60">
                Create your iBag and connect the financial accounts you want
                iBag to understand.
              </p>
            </div>

            <div className="space-y-3">
              <button
                type="button"
                className="w-full rounded-full bg-black px-6 py-4 text-base font-medium text-white transition hover:bg-black/80"
              >
                Create your iBag
              </button>

              <button
                type="button"
                className="w-full rounded-full border border-black/15 px-6 py-4 text-base font-medium transition hover:bg-black/[0.03]"
              >
                Sign in
              </button>
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
