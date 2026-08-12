import Link from "next/link";

export default function ConnectPage() {
  return (
    <main className="min-h-screen bg-white text-black">
      <section className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-6 py-6 sm:px-10">
          <div className="text-2xl font-semibold tracking-tight">iBag</div>

          <Link
            href="/"
            className="text-sm font-medium text-black/60 transition hover:text-black"
          >
            Exit
          </Link>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pb-20">
          <div className="w-full max-w-md text-center">
            <p className="mb-4 text-sm font-medium uppercase tracking-[0.25em] text-black/40">
              Your iBag is ready
            </p>

            <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
              Now, connect your money.
            </h1>

            <p className="mt-5 text-base leading-7 text-black/60">
              iBag can understand your financial picture when you choose to
              connect an account. Nothing is connected until you decide.
            </p>

            <div className="mt-10 space-y-3">
              <Link
                href="/connect"
                className="block w-full rounded-full bg-black px-6 py-4 text-center text-base font-medium text-white transition hover:bg-black/80"
              >
                Connect a financial account
              </Link>

              <Link
                href="/"
                className="block w-full rounded-full border border-black/15 px-6 py-4 text-center text-base font-medium transition hover:bg-black/[0.03]"
              >
                I'll do this later
              </Link>
            </div>

            <p className="mt-8 text-xs leading-5 text-black/40">
              Your financial information is connected only after you choose
              to connect an account.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
