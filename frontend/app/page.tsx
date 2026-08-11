import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-white text-black">
      <section className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-6 py-6 sm:px-10">
          <div className="text-2xl font-semibold tracking-tight">iBag</div>

          <Link
            href="/start"
            className="text-sm font-medium text-black/70 transition hover:text-black"
          >
            Sign in
          </Link>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pb-20">
          <div className="w-full max-w-3xl text-center">
            <p className="mb-6 text-sm font-medium uppercase tracking-[0.25em] text-black/50">
              Financial intelligence
            </p>

            <h1 className="text-5xl font-semibold tracking-[-0.04em] sm:text-7xl">
              Your money,
              <br />
              understood.
            </h1>

            <p className="mx-auto mt-7 max-w-xl text-lg leading-8 text-black/60 sm:text-xl">
              iBag helps you understand what is happening with your money,
              discover what matters, and see what you may have missed.
            </p>

            <Link
              href="/start"
              className="mt-10 inline-block rounded-full bg-black px-8 py-4 text-base font-medium text-white transition hover:bg-black/80"
            >
              Get started
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
