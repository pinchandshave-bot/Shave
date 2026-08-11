import Link from "next/link";

export default function CreatePage() {
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
                Your iBag is your personal financial intelligence space.
              </p>
            </div>

            <div>
              <label
                htmlFor="name"
                className="mb-2 block text-sm font-medium"
              >
                What should we call you?
              </label>

              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                className="w-full rounded-2xl border border-black/15 bg-white px-5 py-4 text-base outline-none transition placeholder:text-black/30 focus:border-black/40"
              />

              <button
                type="button"
                className="mt-4 w-full rounded-full bg-black px-6 py-4 text-base font-medium text-white transition hover:bg-black/80"
              >
                Continue
              </button>
            </div>

            <p className="mt-8 text-center text-xs leading-5 text-black/40">
              You control what information iBag can access.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
