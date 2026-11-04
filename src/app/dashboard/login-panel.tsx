"use client";

import { useState } from "react";
import { ArrowRight, LoaderCircle, LockKeyhole, Mail } from "lucide-react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface LoginPanelProps {
  configurationReady: boolean;
}

export function LoginPanel({ configurationReady }: LoginPanelProps) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSending, setIsSending] = useState(false);

  async function sendSignInLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setErrorMessage("");
    setIsSending(true);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${window.location.origin}/dashboard`,
        },
      });

      if (error) {
        throw new Error(error.message);
      }

      setMessage("A secure sign-in link has been sent to your verified email.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "The sign-in link could not be sent.",
      );
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className="w-full max-w-md rounded-2xl border border-white/10 bg-[#11151d] p-8 shadow-2xl shadow-black/30">
      <div className="mb-7 flex h-12 w-12 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
        <LockKeyhole size={21} />
      </div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300">
        Verified access
      </p>
      <h1 className="text-2xl font-semibold tracking-tight text-white">
        Sign in to Arbitra
      </h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">
        Use a verified contract-party email. We will email you a one-time secure link.
      </p>

      {!configurationReady ? (
        <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm leading-6 text-amber-200">
          Supabase public URL and anon key are required before sign-in can be used.
        </div>
      ) : (
        <form className="mt-7 space-y-4" onSubmit={sendSignInLink}>
          <label className="block text-sm font-medium text-slate-300" htmlFor="email">
            Verified email address
          </label>
          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0b0e13] px-4 transition focus-within:border-cyan-400/50">
            <Mail size={17} className="shrink-0 text-slate-500" />
            <input
              autoComplete="email"
              className="h-12 w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
              id="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              required
              type="email"
              value={email}
            />
          </div>
          <button
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSending}
            type="submit"
          >
            {isSending ? <LoaderCircle className="animate-spin" size={17} /> : null}
            Send secure link
            {!isSending ? <ArrowRight size={16} /> : null}
          </button>
        </form>
      )}

      {message ? (
        <p className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm text-emerald-200">
          {message}
        </p>
      ) : null}
      {errorMessage ? (
        <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-sm text-rose-200">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}
