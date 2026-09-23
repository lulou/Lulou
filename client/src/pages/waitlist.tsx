import { FormEvent, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Check, CheckCircle2, Clipboard, Loader2, Mail, ShieldCheck } from "lucide-react";
import { LulouLogo } from "@/components/LulouLogo";
import { API_BASE, requireApiBase } from "@/lib/queryClient";
import { removeStartupLaunch } from "@/components/startup-launch";

const cities = ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Gold Coast"];

async function publicPost(path: string, body: unknown) {
  requireApiBase(path);
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Request failed (${response.status})`) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function Metadata() {
  useEffect(() => {
    const previous = document.title;
    const tags = [
      ["meta[name='description']", "content", "Lulou is intentional dating for adults who want real conversation and to meet. Launching first in Sydney."],
      ["meta[property='og:title']", "content", "Lulou — Dating should feel like dating again"],
      ["meta[property='og:description']", "content", "Intentional dating for adults who want real conversation and to meet. Launching first in Sydney."],
      ["meta[name='twitter:title']", "content", "Lulou — Dating should feel like dating again"],
      ["meta[name='twitter:description']", "content", "Intentional dating for adults who want real conversation and to meet. Launching first in Sydney."],
    ] as const;
    const previousTags = tags.map(([selector]) => document.querySelector(selector)?.getAttribute("content") ?? null);
    document.title = "Lulou — Dating should feel like dating again";
    tags.forEach(([selector, attr, value]) => document.querySelector(selector)?.setAttribute(attr, value));
    return () => {
      document.title = previous;
      tags.forEach(([selector], index) => {
        const node = document.querySelector(selector);
        if (node && previousTags[index] !== null) node.setAttribute("content", previousTags[index] as string);
      });
    };
  }, []);
  return null;
}

function Mark({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-[hsl(var(--communication-wine))]"><span className="h-1 w-1 rounded-full bg-[hsl(var(--communication-wine))]" />{children}</span>;
}

function Footer() {
  return <footer className="mx-auto flex w-full max-w-6xl flex-col gap-3 border-t border-[#d9c7bd] px-6 py-7 text-xs text-[#77685f] sm:flex-row sm:items-center sm:justify-between">
    <span>© {new Date().getFullYear()} Lulou</span>
    <span className="flex gap-4"><Link href="/privacy" className="underline underline-offset-4">Privacy</Link><Link href="/terms" className="underline underline-offset-4">Terms</Link></span>
  </footer>;
}

function Success({ email, referralLink, city }: { email?: string; referralLink?: string; city?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async () => {
    if (!referralLink) return;
    setCopyError(false);
    let didCopy = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(referralLink);
        didCopy = true;
      } else {
        const input = document.createElement("textarea");
        input.value = referralLink;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        didCopy = document.execCommand("copy");
        input.remove();
      }
    } catch {
      didCopy = false;
    }
    if (!didCopy) {
      setCopyError(true);
      return;
    }
    setCopied(true);
    try { await publicPost("/api/waitlist/event", { event: "referral_copied" }); } catch {}
    window.setTimeout(() => setCopied(false), 2200);
  };
  return <div className="min-h-[100dvh] bg-[#f6eee9] text-[#34251f]">
    <Metadata />
    <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-7"><LulouLogo size={42} rounded /><span className="text-[11px] uppercase tracking-[0.24em] text-[#77685f]">Early access · {city || "Sydney"}</span></header>
    <main className="mx-auto flex min-h-[calc(100dvh-158px)] max-w-2xl items-center px-6 py-16">
      <section className="w-full rounded-[2rem] border border-[#d9c7bd] bg-[#fbf6f1] p-7 shadow-[0_24px_70px_rgba(89,48,34,.08)] sm:p-12">
        <div className="mb-8 flex h-12 w-12 items-center justify-center rounded-full bg-[#ead8cf] text-[hsl(var(--communication-wine))]"><CheckCircle2 size={24} /></div>
        <Mark>You're on the list</Mark>
        <h1 className="mt-5 font-serif text-4xl leading-[1.05] tracking-[-0.03em] sm:text-6xl">A better kind of first date is coming.</h1>
        <p className="mt-6 max-w-lg text-base leading-7 text-[#77685f]">{email ? <>We’ll write to <strong className="font-medium text-[#34251f]">{email}</strong> when a Sydney wave is ready.</> : "Your invitation is confirmed. We’ll be in touch when a Sydney wave is ready."} No ranks, no noise — just a thoughtful invitation.</p>
        {referralLink && <div className="mt-9 rounded-2xl border border-[#d9c7bd] bg-[#f6eee9] p-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-[#77685f]">Your private invitation link</p>
          <div className="mt-3 flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-sm text-[hsl(var(--communication-wine))]">{referralLink}</code><button onClick={copy} className="communication-wine-fill inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-xs font-medium" aria-label="Copy referral link">{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? "Copied" : "Copy"}</button></div>
          <p className="mt-3 text-xs leading-5 text-[#77685f]">{copyError ? "Copy was unavailable here. Press and hold the link to copy it manually." : "Share it with one or two people you’d genuinely like to meet here."}</p>
        </div>}
        <div className="mt-10 border-l border-[hsl(var(--communication-wine))] pl-4 text-sm leading-6 text-[#77685f]">Sydney is our first wave. We’re starting small so conversation has room to become something real.</div>
      </section>
    </main>
    <Footer />
  </div>;
}

function PendingConfirmation({ email }: { email: string }) {
  const [resending, setResending] = useState(false);
  const [message, setMessage] = useState("");
  const resend = async () => {
    setResending(true);
    try {
      await publicPost("/api/waitlist/resend", { email });
      setMessage("If this address is on the list, a fresh confirmation email is on its way.");
    } catch {
      setMessage("We couldn’t resend that just now. Please try again shortly.");
    } finally {
      setResending(false);
    }
  };
  return <Shell><div className="py-24 text-center"><Mark>Check your inbox</Mark><h1 className="mx-auto mt-5 max-w-xl font-serif text-4xl leading-tight sm:text-5xl">Your request is with us.</h1><p className="mx-auto mt-5 max-w-md text-base leading-7 text-[#77685f]">If <strong className="font-medium text-[#34251f]">{email}</strong> is new to Lulou, we’ll send a confirmation link. If you’re already on the list, you can safely resend it below.</p><button onClick={resend} disabled={resending} className="communication-wine-fill mt-8 inline-flex min-h-12 items-center gap-2 rounded-full px-6 py-3 text-sm font-medium disabled:opacity-60">{resending && <Loader2 size={16} className="animate-spin" />}Resend confirmation</button>{message && <p className="mx-auto mt-4 max-w-sm text-sm text-[#77685f]">{message}</p>}</div></Shell>;
}

function ExpiredInvitation() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const resend = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    try {
      await publicPost("/api/waitlist/resend", { email: email.trim().toLowerCase() });
      setMessage("If this address is on the list, a fresh confirmation email is on its way.");
    } catch {
      setMessage("We couldn’t resend that just now. Please try again shortly.");
    } finally {
      setLoading(false);
    }
  };
  return <Shell><div className="py-24 text-center"><Mark>Link expired</Mark><h1 className="mt-5 font-serif text-4xl">Let’s send a fresh one.</h1><p className="mx-auto mt-4 max-w-sm text-sm leading-6 text-[#77685f]">Enter the email you used to join. We’ll only confirm whether a message can be sent.</p><form onSubmit={resend} className="mx-auto mt-7 flex max-w-sm flex-col gap-3 sm:flex-row"><input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="Email address" className="min-h-12 min-w-0 flex-1 rounded-full border border-[#cdbbb1] bg-[#fdf9f5] px-5 text-sm outline-none focus:border-[hsl(var(--communication-wine))]" /><button disabled={loading} className="communication-wine-fill min-h-12 rounded-full px-5 text-sm font-medium disabled:opacity-60">{loading ? "Sending…" : "Resend"}</button></form>{message && <p className="mx-auto mt-4 max-w-sm text-sm text-[#77685f]">{message}</p>}</div></Shell>;
}

export default function WaitlistPage() {
  // This public route deliberately skips the authenticated app shell, including
  // its StartupLaunch component. Remove the pre-React cover ourselves.
  useLayoutEffect(() => { removeStartupLaunch(); }, []);
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const token = params.get("token");
  const referralCode = params.get("r") || undefined;
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("Sydney");
  const [is18Plus, setIs18Plus] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formStarted, setFormStarted] = useState(false);
  const [error, setError] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [submitted, setSubmitted] = useState<{ email: string; referralLink?: string; city?: string } | null>(null);
  const [verifyState, setVerifyState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [verifyData, setVerifyData] = useState<{ referralLink?: string; city?: string } | null>(null);

  useEffect(() => {
    if (!token) publicPost("/api/waitlist/event", { event: "view" }).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!formStarted) return;
    publicPost("/api/waitlist/event", { event: "form_started" }).catch(() => {});
  }, [formStarted]);

  if (submitted) return <PendingConfirmation email={submitted.email} />;
  if (token) {
    if (verifyState === "idle") return <Shell><div className="py-24 text-center"><Mark>Private invitation</Mark><h1 className="mx-auto mt-5 max-w-lg font-serif text-4xl leading-tight sm:text-5xl">Ready to confirm your place?</h1><p className="mx-auto mt-4 max-w-sm text-sm leading-6 text-[#77685f]">Click once to confirm this invitation. Nothing happens until you choose to continue.</p><button onClick={async () => { setVerifyState("loading"); try { const data = await publicPost("/api/waitlist/verify", { token }); setVerifyData(data); setVerifyState("success"); window.history.replaceState({}, "", "/waitlist"); } catch { setVerifyState("error"); } }} className="communication-wine-fill mt-7 rounded-full px-7 py-3.5 text-sm font-medium">Confirm invitation</button></div></Shell>;
    if (verifyState === "success") return <Success referralLink={verifyData?.referralLink} city={verifyData?.city} />;
    if (verifyState === "loading") return <Shell><div className="py-28 text-center"><Loader2 className="mx-auto animate-spin text-[hsl(var(--communication-wine))]" /><p className="mt-4 text-sm text-[#77685f]">Confirming your invitation…</p></div></Shell>;
    return <ExpiredInvitation />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(""); setDuplicate(false);
    if (!firstName.trim() || !email.trim() || !is18Plus) { setError("Please add your name, email, and confirm you’re 18 or older."); return; }
    setLoading(true);
    try {
      await publicPost("/api/waitlist/join", { firstName: firstName.trim(), email: email.trim().toLowerCase(), city, is18Plus, ...(referralCode ? { referralCode } : {}) });
      setSubmitted({ email: email.trim().toLowerCase() });
    } catch (err: any) {
      if (err?.status === 409 || /already|duplicate|exists/i.test(err?.message || "")) setDuplicate(true);
      else setError(err?.message || "We couldn’t save that just now. Please try again.");
    } finally { setLoading(false); }
  };
  return <Shell>
    <Metadata />
    <main className="grid min-h-[calc(100dvh-110px)] items-center gap-14 px-6 py-12 lg:grid-cols-[1fr_0.82fr] lg:gap-24 lg:py-24">
      <section className="max-w-2xl">
        <Mark>Early access · Sydney</Mark>
        <h1 className="mt-6 max-w-xl font-serif text-[clamp(2rem,10vw,2.875rem)] leading-[.88] tracking-[-0.06em] sm:text-[clamp(3.25rem,5.4vw,4.25rem)]">Where conversations become something real.</h1>
        <p className="mt-8 max-w-md text-lg leading-8 text-[#77685f]">A more intentional way to meet people who are ready to talk, connect and actually meet — launching first in Sydney.</p>
        <a href="#join-form" className="communication-wine-fill mt-8 inline-flex min-h-12 items-center rounded-full px-6 py-3 text-sm font-medium">Join Early Access <ArrowUpRight size={16} className="ml-2" /></a>
        <div className="mt-12 grid max-w-lg grid-cols-2 gap-x-7 gap-y-4 border-t border-[#d9c7bd] pt-5 text-sm text-[#77685f] sm:grid-cols-5 sm:gap-3">
          {["Discover", "Connect", "Message", "Talk", "Meet"].map((step, i) => <div key={step} className="flex items-center gap-2"><span className="font-serif text-xl text-[hsl(var(--communication-wine))]">0{i + 1}</span><span>{step}</span></div>)}
        </div>
      </section>
      <section id="join-form" className="rounded-[2rem] border border-[#d9c7bd] bg-[#fbf6f1] p-6 shadow-[0_24px_70px_rgba(89,48,34,.08)] sm:p-9">
        <h2 className="font-serif text-3xl tracking-[-0.03em]">Be first in the room.</h2><p className="mt-2 text-sm leading-6 text-[#77685f]">Leave your details for a personal invitation when Sydney opens.</p>
        <form onSubmit={submit} className="mt-8 space-y-5">
          <label className="block text-sm"><span className="mb-2 block text-[#77685f]">First name</span><input required value={firstName} onFocus={() => setFormStarted(true)} onChange={e => setFirstName(e.target.value)} className="w-full rounded-xl border border-[#cdbbb1] bg-[#fdf9f5] px-4 py-3.5 outline-none transition focus:border-[hsl(var(--communication-wine))]" autoComplete="given-name" /></label>
          <label className="block text-sm"><span className="mb-2 block text-[#77685f]">Email address</span><input required type="email" value={email} onFocus={() => setFormStarted(true)} onChange={e => setEmail(e.target.value)} className="w-full rounded-xl border border-[#cdbbb1] bg-[#fdf9f5] px-4 py-3.5 outline-none transition focus:border-[hsl(var(--communication-wine))]" autoComplete="email" /></label>
          <label className="block text-sm"><span className="mb-2 block text-[#77685f]">City</span><select value={city} onChange={e => setCity(e.target.value)} className="w-full appearance-none rounded-xl border border-[#cdbbb1] bg-[#fdf9f5] px-4 py-3.5">{cities.map(item => <option key={item}>{item}</option>)}</select></label>
          <label className="flex items-start gap-3 text-sm leading-5 text-[#77685f]"><input type="checkbox" checked={is18Plus} onChange={e => setIs18Plus(e.target.checked)} className="mt-1 h-4 w-4 accent-[hsl(var(--communication-wine))]" /><span>I confirm I’m 18 or older and agree to the <Link href="/terms" className="underline underline-offset-4">Terms</Link> and <Link href="/privacy" className="underline underline-offset-4">Privacy Policy</Link>.</span></label>
          <p className="flex gap-2 text-xs leading-5 text-[#77685f]"><Mail size={15} className="mt-0.5 shrink-0" />We’ll only email about your invitation and essential account updates.</p>
          {(error || duplicate) && <div className="rounded-xl border border-[#c58b88] bg-[#f7e4df] p-3 text-sm leading-5 text-[#763e3a]">{duplicate ? <>This email is already on the list. <button type="button" className="font-medium underline" onClick={async () => { setLoading(true); try { await publicPost("/api/waitlist/resend", { email: email.trim().toLowerCase() }); setError("A fresh confirmation email is on its way."); setDuplicate(false); } catch { setError("We couldn’t resend that just now."); } finally { setLoading(false); } }}>Resend confirmation</button></> : error}</div>}
          <button disabled={loading} className="communication-wine-fill flex w-full items-center justify-center gap-2 rounded-full px-5 py-3.5 text-sm font-medium disabled:opacity-60">{loading && <Loader2 size={16} className="animate-spin" />}Request early access <ArrowUpRight size={16} /></button>
        </form>
        <p className="mt-5 flex items-center gap-2 text-xs text-[#77685f]"><ShieldCheck size={15} />A considered beginning, not another inbox.</p>
      </section>
    </main>
    <Footer />
  </Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-[100dvh] bg-[#f6eee9] text-[#34251f]"><header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-7"><Link href="/waitlist" aria-label="Lulou home"><LulouLogo size={42} rounded /></Link><span className="text-[11px] uppercase tracking-[0.24em] text-[#77685f]">Lulou</span></header>{children}<Footer /></div>;
}