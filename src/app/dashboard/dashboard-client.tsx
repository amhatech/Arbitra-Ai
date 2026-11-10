"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Check,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  GitCommitHorizontal,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageSquareText,
  Pause,
  Play,
  Send,
  ShieldCheck,
  ShieldAlert,
  WalletCards,
  X,
} from "lucide-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { z } from "zod";

import { LoginPanel } from "@/app/dashboard/login-panel";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { milestoneListResponseSchema } from "@/lib/validation";
import type { MilestoneGridRow, MilestoneStatus } from "@/types";

ModuleRegistry.registerModules([AllCommunityModule]);

interface DashboardClientProps {
  configurationReady: boolean;
  userEmail: string | null;
}

interface ChatMessage {
  role: "assistant" | "user";
  content: string;
}

const demoMilestone: MilestoneGridRow = {
  id: "local-simulation-milestone",
  contractId: "local-simulation-contract",
  title: "Responsive escrow dashboard",
  amount: 7200,
  currency: "USD",
  status: "ESCROWED",
  score: null,
  verificationType: "github_commit",
  commitHash: null,
  verificationTimestamp: null,
  releaseCountdownEta: null,
  releasedAmount: 0,
  canAuthorize: false,
  canRelease: false,
  isSimulated: true,
};

const statusStyles: Record<MilestoneStatus, string> = {
  AWAITING_FUNDS: "border-amber-300/20 bg-amber-300/10 text-amber-200",
  ESCROWED: "border-sky-300/20 bg-sky-300/10 text-sky-200",
  PENDING_RELEASE: "border-amber-300/20 bg-amber-300/[0.08] text-amber-200",
  PAID: "border-slate-400/20 bg-slate-400/10 text-slate-300",
  MUTED_DISPUTE: "border-rose-300/20 bg-rose-300/10 text-rose-200",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function apiError(value: unknown, fallback: string): string {
  if (isRecord(value) && typeof value.error === "string") {
    return value.error;
  }
  return fallback;
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

function StatusBadge({ status }: { status: MilestoneStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-[0.12em] ${statusStyles[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status.replaceAll("_", " ")}
    </span>
  );
}

function CountdownTimer({ eta }: { eta: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const remaining = Math.max(0, new Date(eta).getTime() - now);
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);

  return (
    <span className="mt-1 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-slate-400">
      <Clock3 size={12} />
      {hours.toString().padStart(2, "0")}:{minutes.toString().padStart(2, "0")}:
      {seconds.toString().padStart(2, "0")}
    </span>
  );
}

function DashboardMetric({
  label,
  value,
  detail,
  icon,
  trend,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  trend?: "up" | "down";
}) {
  return (
    <article className="rounded-2xl border border-white/[0.07] bg-[#11151d] p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-white">{value}</p>
        </div>
        <span className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-2.5 text-cyan-300">
          {icon}
        </span>
      </div>
      <div className="mt-4 flex items-center gap-1.5 text-[11px] text-slate-500">
        {trend === "up" ? <ArrowUpRight size={13} className="text-emerald-400" /> : null}
        {trend === "down" ? <ArrowDownRight size={13} className="text-rose-400" /> : null}
        {detail}
      </div>
    </article>
  );
}

export function DashboardClient({
  configurationReady,
  userEmail,
}: DashboardClientProps) {
  const [liveRows, setLiveRows] = useState<MilestoneGridRow[]>([]);
  const [demoRow, setDemoRow] = useState(demoMilestone);
  const [loadError, setLoadError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [negotiationLog, setNegotiationLog] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Share the agreed terms, party emails, budget, and objective milestone criteria. I will structure the negotiation and flag subjective requirements before saving.",
    },
  ]);
  const [demoChatMessages, setDemoChatMessages] = useState<ChatMessage[]>([]);
  const [demoChatInput, setDemoChatInput] = useState("");
  const [isDemoChatLocked, setIsDemoChatLocked] = useState(false);
  const [showArchitectureSlide, setShowArchitectureSlide] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [fundingMessage, setFundingMessage] = useState("");
  const [isLoginOpen, setIsLoginOpen] = useState(false);

  const loadMilestones = useCallback(async () => {
    if (!userEmail) {
      return;
    }
    setIsLoading(true);
    try {
      const verificationResponse = await fetch("/api/contracts/verify-party", {
        method: "POST",
      });
      const verificationPayload: unknown = await verificationResponse.json();
      if (!verificationResponse.ok) {
        throw new Error(
          apiError(verificationPayload, "Verified party status could not be synchronized."),
        );
      }

      const response = await fetch("/api/milestones", { cache: "no-store" });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiError(payload, "Milestones could not be loaded."));
      }
      const parsed = milestoneListResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Milestone service returned an invalid response.");
      }
      setLiveRows(parsed.data.milestones);
      setLoadError("");
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Milestones could not be loaded.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [userEmail]);

  useEffect(() => {
    void loadMilestones();
    const refresh = window.setInterval(() => void loadMilestones(), 15_000);
    return () => window.clearInterval(refresh);
  }, [loadMilestones]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const funding = params.get("funding");
    if (funding === "success") {
      setFundingMessage("PayPal captured the full contract balance. Milestones are now escrowed.");
      void loadMilestones();
    } else if (funding === "pending") {
      setFundingMessage("PayPal is confirming the escrow capture. Milestones will activate when the verified capture webhook arrives.");
    } else if (funding === "cancelled") {
      setFundingMessage("Escrow authorization was cancelled. No funds were authorized.");
    } else if (funding === "error") {
      setFundingMessage(`Escrow authorization needs attention (${params.get("reason") ?? "unknown error"}).`);
    }
  }, [loadMilestones]);

  const gridRows = useMemo(
    () => [demoRow, ...liveRows],
    [demoRow, liveRows],
  );

  const handleDispute = useCallback(
    async (row: MilestoneGridRow) => {
      setActionError("");
      setActionMessage("");
      if (row.isSimulated) {
        setDemoRow((current) => ({
          ...current,
          status: "MUTED_DISPUTE",
          releaseCountdownEta: null,
        }));
        setActionMessage("Simulation only: the demo milestone is paused; no funds or records changed.");
        return;
      }

      try {
        const response = await fetch(`/api/milestones/${row.id}/dispute`, {
          method: "POST",
        });
        const payload: unknown = await response.json();
        if (!response.ok) {
          throw new Error(apiError(payload, "The milestone could not be disputed."));
        }
        setActionMessage("Dispute recorded. The milestone is paused and the hold is frozen.");
        await loadMilestones();
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "The milestone could not be disputed.",
        );
      }
    },
    [loadMilestones],
  );

  const handleAuthorize = useCallback(async (row: MilestoneGridRow) => {
    setActionError("");
    setActionMessage("");
    try {
      const response = await fetch(`/api/contracts/${row.contractId}/authorize`, {
        method: "POST",
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiError(payload, "PayPal authorization could not be started."));
      }
      if (!isRecord(payload) || typeof payload.approvalUrl !== "string") {
        throw new Error("PayPal did not provide an approval link.");
      }
      window.location.assign(payload.approvalUrl);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "PayPal authorization could not be started.",
      );
    }
  }, []);

  const handleRelease = useCallback(async (row: MilestoneGridRow) => {
    setActionError("");
    setActionMessage("");
    const remaining = Math.round((row.amount - row.releasedAmount) * 100) / 100;
    if (remaining <= 0) {
      setActionError("There is no remaining milestone balance to release.");
      return;
    }

    try {
      const response = await fetch(`/api/milestones/${row.id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: remaining }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiError(payload, "The milestone payout could not be initiated."));
      }
      setActionMessage(
        "PayPal accepted the payout. The ledger will update after PayPal confirms settlement.",
      );
      await loadMilestones();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The milestone payout could not be initiated.",
      );
    }
  }, [loadMilestones]);

  const columnDefs = useMemo<ColDef<MilestoneGridRow>[]>(
    () => [
      {
        headerName: "Milestone title & status",
        valueGetter: (params) =>
          params.data ? `${params.data.title} ${params.data.status}` : "",
        minWidth: 250,
        flex: 1.5,
        cellRenderer: (params: ICellRendererParams<MilestoneGridRow>) => {
          const row = params.data;
          if (!row) {
            return null;
          }
          return (
            <div className="flex h-full flex-col justify-center gap-2 py-2">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-100">{row.title}</span>
                {row.isSimulated ? (
                  <span className="shrink-0 rounded border border-violet-300/20 bg-violet-300/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-violet-200">
                    PREVIEW
                  </span>
                ) : null}
              </div>
              <StatusBadge status={row.status} />
            </div>
          );
        },
      },
      {
        headerName: "Allocation weight",
        field: "amount",
        minWidth: 145,
        maxWidth: 175,
        valueFormatter: (params) =>
          typeof params.value === "number" && params.data
            ? formatCurrency(params.value, params.data.currency)
            : "—",
        cellClass: "font-mono text-sm text-slate-200",
      },
      {
        headerName: "AI validation engine",
        field: "score",
        minWidth: 190,
        flex: 0.9,
        cellRenderer: (params: ICellRendererParams<MilestoneGridRow>) => {
          const score = params.data?.score;
          if (score === null || score === undefined) {
            return (
              <div className="flex h-full items-center gap-2 text-xs text-slate-500">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
                Awaiting verification
              </div>
            );
          }
          const color =
            score >= 85
              ? "bg-emerald-400"
              : score >= 60
                ? "bg-amber-400"
                : "bg-rose-400";
          return (
            <div className="flex h-full flex-col justify-center gap-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Compliance score</span>
                <span className="font-mono text-slate-200">{score}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ease-out ${color}`}
                  style={{ width: `${score}%` }}
                />
              </div>
            </div>
          );
        },
      },
      {
        headerName: "Webhook node stream",
        field: "commitHash",
        minWidth: 190,
        flex: 0.9,
        cellRenderer: (params: ICellRendererParams<MilestoneGridRow>) => {
          const row = params.data;
          if (!row) {
            return null;
          }
          return (
            <div className="flex h-full flex-col justify-center gap-1.5">
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300">
                <GitCommitHorizontal size={13} className="text-cyan-300" />
                {row.commitHash ? row.commitHash.slice(0, 10) : "No event received"}
              </span>
              <span className="text-[10px] text-slate-500">
                {row.verificationTimestamp
                  ? new Date(row.verificationTimestamp).toLocaleString()
                  : row.verificationType === "github_commit"
                    ? "Waiting for commit webhook"
                    : "Waiting for Figma evidence"}
              </span>
            </div>
          );
        },
      },
      {
        headerName: "Action gate",
        minWidth: 205,
        flex: 0.9,
        sortable: false,
        cellRenderer: (params: ICellRendererParams<MilestoneGridRow>) => {
          const row = params.data;
          if (!row) {
            return null;
          }
          if (row.status === "PENDING_RELEASE" && row.releaseCountdownEta) {
            const holdExpired = new Date(row.releaseCountdownEta).getTime() <= Date.now();
            return (
              <div className="flex h-full flex-col justify-center">
                {!holdExpired ? (
                  <button
                    className="flex w-fit items-center gap-1.5 rounded-lg border border-rose-300/20 bg-rose-300/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-rose-200 transition hover:bg-rose-300/15"
                    onClick={() => void handleDispute(row)}
                    type="button"
                  >
                    <Pause size={12} />
                    Pause & dispute
                  </button>
                ) : null}
                {holdExpired && row.canRelease ? (
                  <button
                    className="mt-1 flex w-fit items-center gap-1.5 rounded-lg border border-emerald-300/20 bg-emerald-300/[0.07] px-2.5 py-1 text-[10px] font-medium text-emerald-200 transition hover:bg-emerald-300/15"
                    onClick={() => void handleRelease(row)}
                    type="button"
                  >
                    <CircleDollarSign size={12} />
                    Release remaining
                  </button>
                ) : null}
                <CountdownTimer eta={row.releaseCountdownEta} />
              </div>
            );
          }
          if (row.status === "AWAITING_FUNDS" && !row.isSimulated && row.canAuthorize) {
            return (
              <div className="flex h-full items-center">
                <button
                  className="flex items-center gap-1.5 rounded-lg border border-cyan-300/20 bg-cyan-300/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-cyan-200 transition hover:bg-cyan-300/15"
                  onClick={() => void handleAuthorize(row)}
                  type="button"
                >
                  <WalletCards size={13} />
                  Authorize escrow
                </button>
              </div>
            );
          }
          return (
            <div className="flex h-full items-center text-xs text-slate-600">
              {row.status === "PAID" ? "Settled" : row.status === "MUTED_DISPUTE" ? "Paused" : "No action"}
            </div>
          );
        },
      },
    ],
    [handleAuthorize, handleDispute, handleRelease],
  );

  const defaultColDef = useMemo<ColDef<MilestoneGridRow>>(
    () => ({ resizable: true, sortable: true, suppressMovable: true }),
    [],
  );

  async function submitNegotiation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = negotiationLog.trim();
    if (!text || isParsing) {
      return;
    }
    setActionError("");
    setMessages((current) => [...current, { role: "user", content: text }]);
    setNegotiationLog("");
    setIsParsing(true);

    try {
      const response = await fetch("/api/contract/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ negotiationLog: text }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(apiError(payload, "The negotiation could not be parsed."));
      }
      const result = z
        .object({ contractId: z.string().uuid() })
        .safeParse(payload);
      if (!result.success) {
        throw new Error("Contract parser returned an invalid response.");
      }
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: `Contract ${result.data.contractId} is saved in NEGOTIATING status. Both parties must verify their emails before the client can authorize escrow.`,
        },
      ]);
      await loadMilestones();
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            error instanceof Error
              ? error.message
              : "The negotiation could not be parsed.",
        },
      ]);
    } finally {
      setIsParsing(false);
    }
  }

  async function simulateCommit(compliant: boolean) {
    setIsSimulating(true);
    setActionMessage("");
    setActionError("");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 450));
    const verifiedAt = new Date().toISOString();
    if (compliant) {
      setDemoRow((current) => ({
        ...current,
        status: "PENDING_RELEASE",
        score: 92,
        commitHash: "a41ce9b10f7d",
        verificationTimestamp: verifiedAt,
        releaseCountdownEta: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }));
      setActionMessage(
        "Simulation only: 92% objective compliance opened a 24-hour client hold. No money moved.",
      );
    } else {
      setDemoRow((current) => ({
        ...current,
        status: "ESCROWED",
        score: 32,
        commitHash: "broken-commit",
        verificationTimestamp: verifiedAt,
        releaseCountdownEta: null,
      }));
      setActionMessage(
        "Simulation only: broken evidence scored below 85%; funds remain escrowed.",
      );
    }
    setIsSimulating(false);
  }

  function submitDemoChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = demoChatInput.trim();
    if (!content || isDemoChatLocked) {
      return;
    }

    setDemoChatMessages((current) => [
      ...current,
      { role: "user", content },
      {
        role: "assistant",
        content:
          "Preview only — this message stays in your browser and was not sent to Gemini or saved as a contract. Sign in with a verified party email to use the live parser.",
      },
    ]);
    setDemoChatInput("");
  }

  async function signOut() {
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signOut();
    if (error) {
      setActionError(`Sign out failed: ${error.message}`);
      return;
    }
    window.location.assign("/dashboard");
  }

  const protectedCount = liveRows.filter(
    (row) => row.status === "ESCROWED" || row.status === "PENDING_RELEASE",
  ).length;
  const pendingCount = liveRows.filter((row) => row.status === "PENDING_RELEASE").length;
  const compliantCount = liveRows.filter((row) => row.score !== null && row.score >= 85).length;
  const volumeByCurrency = liveRows.reduce<Record<string, number>>((totals, row) => {
    totals[row.currency] = (totals[row.currency] ?? 0) + row.amount;
    return totals;
  }, {});
  const liveVolume =
    Object.entries(volumeByCurrency)
      .map(([currency, amount]) => formatCurrency(amount, currency))
      .join(" · ") || formatCurrency(0, "USD");

  const totals = [
    {
      label: "Live contract volume",
      value: liveVolume,
      detail: `${liveRows.length} live milestones in view`,
      icon: <CircleDollarSign size={19} />,
      trend: "up" as const,
    },
    {
      label: "Protected milestones",
      value: protectedCount.toString().padStart(2, "0"),
      detail: "Funds held or under review",
      icon: <ShieldCheck size={19} />,
    },
    {
      label: "Client hold windows",
      value: pendingCount.toString().padStart(2, "0"),
      detail: "Active 24-hour release gates",
      icon: <Clock3 size={19} />,
      trend: pendingCount > 0 ? ("down" as const) : undefined,
    },
    {
      label: "AI validations ≥ 85%",
      value: compliantCount.toString().padStart(2, "0"),
      detail: "Objective evidence threshold",
      icon: <FileCheck2 size={19} />,
    },
  ];

  return (
    <main className="dashboard-classic min-h-screen bg-[#0b0e13] px-4 py-6 text-slate-100 sm:px-7 lg:px-10">
      <div className="mx-auto max-w-[1600px]">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-white/[0.07] pb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
              <ShieldCheck size={21} />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-[0.18em] text-white">ARBITRA AI</p>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.17em] text-slate-500">
                Freelance escrow workspace
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {userEmail ? (
              <>
                <div className="flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-300/[0.05] px-3 py-1.5 text-[11px] text-emerald-200">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" />
                  Secure session
                </div>
                <span className="max-w-[220px] truncate text-xs text-slate-400">{userEmail}</span>
                <button
                  className="rounded-lg border border-white/10 p-2 text-slate-400 transition hover:border-white/20 hover:text-white"
                  onClick={() => void signOut()}
                  title="Sign out"
                  type="button"
                >
                  <LogOut size={15} />
                </button>
              </>
            ) : (
              <span className="flex items-center gap-2 rounded-full border border-violet-300/15 bg-violet-300/[0.05] px-3 py-1.5 text-[11px] text-violet-200">
                <ShieldCheck size={13} />
                Preview environment
              </span>
            )}
          </div>
        </header>

        {!userEmail ? (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.04] px-4 py-3">
            <div>
              <p className="text-sm font-medium text-cyan-100">
                Product preview
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                Explore the milestone review and 24-hour client hold. Sample activity is kept in this browser and never moves money.
              </p>
            </div>
            <a
              className="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
              href="https://github.com/amhatech/Arbitra-Ai"
              rel="noreferrer"
              target="_blank"
            >
              View public source
            </a>
          </div>
        ) : null}

        <section className="flex flex-wrap items-end justify-between gap-4 py-8">
          <div>
            <p className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-cyan-300">
              <Activity size={14} />
              Portfolio overview
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-[38px]">
              Escrow overview
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              Monitor objective delivery, protected balances, and every human release gate in one place.
            </p>
          </div>
          <button
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/[0.06]"
            onClick={() => void loadMilestones()}
            type="button"
          >
            {isLoading ? <LoaderCircle className="animate-spin" size={14} /> : <Activity size={14} />}
            Refresh ledger
          </button>
        </section>

        {fundingMessage ? (
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.05] px-4 py-3 text-sm text-cyan-100">
            <WalletCards size={17} className="shrink-0" />
            <span>{fundingMessage}</span>
            <button className="ml-auto text-cyan-100/60 hover:text-white" onClick={() => setFundingMessage("")} type="button">
              <X size={15} />
            </button>
          </div>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {totals.map((metric) => (
            <DashboardMetric key={metric.label} {...metric} />
          ))}
        </section>

        <section className="mt-6 rounded-2xl border border-white/[0.07] bg-[#11151d] p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Activity size={16} className="text-cyan-300" />
                Milestone verification ledger
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Holds are enforced server-side; compliant work never triggers an instant release.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
              Refreshes every 15 seconds
            </div>
          </div>

          {loadError ? (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-300/15 bg-rose-300/[0.05] p-3 text-xs leading-5 text-rose-200">
              <ShieldAlert className="mt-0.5 shrink-0" size={15} />
              <span>Live ledger unavailable: {loadError}</span>
            </div>
          ) : null}
          {actionError ? (
            <div className="mb-3 rounded-lg border border-rose-300/15 bg-rose-300/[0.05] p-3 text-xs leading-5 text-rose-200">
              {actionError}
            </div>
          ) : null}
          {actionMessage ? (
            <div className="mb-3 rounded-lg border border-emerald-300/15 bg-emerald-300/[0.05] p-3 text-xs leading-5 text-emerald-200">
              {actionMessage}
            </div>
          ) : null}

          <div className="hidden overflow-x-auto rounded-xl border border-white/[0.07] sm:block">
            <div className="ag-grid-classic min-w-[980px] overflow-hidden">
              <AgGridReact<MilestoneGridRow>
                animateRows
                columnDefs={columnDefs}
                defaultColDef={defaultColDef}
                domLayout="autoHeight"
                getRowId={(params) => params.data.id}
                headerHeight={48}
                rowData={gridRows}
                rowHeight={76}
                theme={themeQuartz}
                suppressCellFocus
              />
            </div>
          </div>
          <div className="space-y-3 sm:hidden">
            {gridRows.map((row) => {
              const holdExpired =
                row.releaseCountdownEta !== null &&
                new Date(row.releaseCountdownEta).getTime() <= Date.now();
              const scoreColor =
                row.score === null
                  ? "bg-slate-500"
                  : row.score >= 85
                    ? "bg-emerald-400"
                    : row.score >= 60
                      ? "bg-amber-400"
                      : "bg-rose-400";

              return (
                <article
                  className="rounded-xl border border-white/[0.08] bg-[#11151d] p-4"
                  key={row.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-100">{row.title}</p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {formatCurrency(row.amount, row.currency)}
                        {row.isSimulated ? " · Preview data" : ""}
                      </p>
                    </div>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span>Compliance score</span>
                      <span>{row.score === null ? "Not reviewed" : `${row.score}%`}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                      <div
                        className={`h-full rounded-full ${scoreColor}`}
                        style={{ width: `${row.score ?? 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                    <span className="font-mono text-[10px] text-slate-500">
                      {row.commitHash
                        ? row.commitHash.slice(0, 10)
                        : "Awaiting commit evidence"}
                    </span>
                    {row.status === "PENDING_RELEASE" && row.releaseCountdownEta ? (
                      <div className="flex flex-wrap items-center justify-end gap-3">
                        {holdExpired && row.canRelease ? (
                          <button
                            className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.07] px-2.5 py-1.5 text-[10px] font-medium text-emerald-200"
                            onClick={() => void handleRelease(row)}
                            type="button"
                          >
                            Release remaining
                          </button>
                        ) : (
                          <button
                            className="rounded-lg border border-rose-300/20 bg-rose-300/[0.07] px-2.5 py-1.5 text-[10px] font-medium text-rose-200"
                            onClick={() => void handleDispute(row)}
                            type="button"
                          >
                            Pause & dispute
                          </button>
                        )}
                        <CountdownTimer eta={row.releaseCountdownEta} />
                      </div>
                    ) : row.status === "AWAITING_FUNDS" &&
                      !row.isSimulated &&
                      row.canAuthorize ? (
                      <button
                        className="rounded-lg border border-cyan-300/20 bg-cyan-300/[0.07] px-2.5 py-1.5 text-[10px] font-medium text-cyan-200"
                        onClick={() => void handleAuthorize(row)}
                        type="button"
                      >
                        Authorize escrow
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-600">
            <span>{userEmail ? "Live records are scoped to your verified party email." : "Live contract data requires verified party sign-in."}</span>
            <span>Sample rows are local-only and never contact PayPal or Supabase.</span>
          </div>
        </section>

        <section className="mt-6 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
          {userEmail ? (
          <article className="flex min-h-[470px] flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[#11151d]">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <MessageSquareText size={16} className="text-cyan-300" />
                  Contract negotiation parser
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Structured extraction · subjective criteria blocked
                </p>
              </div>
              <span className="rounded-full border border-cyan-300/15 bg-cyan-300/[0.05] px-2.5 py-1 text-[10px] text-cyan-200">
                Gemini · JSON schema
              </span>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {messages.map((message, index) => (
                <div
                  className={`flex gap-3 ${message.role === "user" ? "flex-row-reverse" : ""}`}
                  key={`${message.role}-${index}`}
                >
                  <div
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                      message.role === "assistant"
                        ? "border border-cyan-300/15 bg-cyan-300/[0.06] text-cyan-200"
                        : "border border-white/10 bg-white/[0.05] text-slate-300"
                    }`}
                  >
                    {message.role === "assistant" ? <Bot size={14} /> : <span className="text-[10px]">YOU</span>}
                  </div>
                  <div
                    className={`max-w-[88%] rounded-xl px-4 py-3 text-xs leading-6 ${
                      message.role === "assistant"
                        ? "border border-white/[0.06] bg-[#0c1016] text-slate-300"
                        : "border border-cyan-300/10 bg-cyan-300/[0.05] text-slate-200"
                    }`}
                  >
                    {message.content}
                  </div>
                </div>
              ))}
              {isParsing ? (
                <div className="flex items-center gap-2 pl-10 text-xs text-cyan-200">
                  <LoaderCircle className="animate-spin" size={14} />
                  Parsing negotiation and validating acceptance criteria…
                </div>
              ) : null}
            </div>

            <form className="border-t border-white/[0.07] p-4" onSubmit={submitNegotiation}>
              <label className="sr-only" htmlFor="negotiation-log">
                Paste natural-language negotiation log
              </label>
              <textarea
                className="min-h-[90px] w-full resize-y rounded-xl border border-white/[0.08] bg-[#0b0e13] p-3 text-xs leading-5 text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-cyan-300/30"
                id="negotiation-log"
                onChange={(event) => setNegotiationLog(event.target.value)}
                placeholder="Paste the agreed terms, verified party emails, total budget, and testable milestone criteria…"
                value={negotiationLog}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[10px] text-slate-600">
                  Subjective terms require concrete, observable design definitions.
                </p>
                <button
                  className="flex items-center gap-2 rounded-lg bg-cyan-300 px-3.5 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isParsing || negotiationLog.trim().length < 20}
                  type="submit"
                >
                  {isParsing ? <LoaderCircle className="animate-spin" size={14} /> : <Send size={13} />}
                  Parse & save
                </button>
              </div>
            </form>
          </article>
          ) : (
            <article className="flex min-h-[470px] flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[#11151d]">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                    <MessageSquareText size={16} className="text-cyan-300" />
                    Contract negotiation chat
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Local preview · messages are not sent or saved
                  </p>
                </div>
                <span className="rounded-full border border-violet-300/15 bg-violet-300/[0.05] px-2.5 py-1 text-[10px] text-violet-200">
                  PREVIEW
                </span>
              </div>

              {isDemoChatLocked ? (
                <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-orange-300/20 bg-orange-300/[0.07] text-orange-200">
                    <LockKeyhole size={20} />
                  </div>
                  <p className="mt-4 text-sm font-semibold text-slate-100">Client left the chat.</p>
                  <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
                    This conversation is locked. No contract or payment was changed.
                  </p>
                  <button
                    className="mt-5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
                    onClick={() => setIsDemoChatLocked(false)}
                    type="button"
                  >
                    Return to chat preview
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex-1 space-y-3 overflow-y-auto p-5">
                    {demoChatMessages.length === 0 ? (
                      <div className="flex gap-3">
                        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] text-cyan-200">
                          <Bot size={14} />
                        </div>
                        <div className="max-w-[88%] rounded-xl border border-white/[0.06] bg-[#0c1016] px-4 py-3 text-xs leading-6 text-slate-300">
                          Type a sample negotiation message to preview the chat. This public demo does not send it to an AI service.
                        </div>
                      </div>
                    ) : null}
                    {demoChatMessages.map((message, index) => (
                      <div
                        className={`flex gap-3 ${message.role === "user" ? "flex-row-reverse" : ""}`}
                        key={`demo-${message.role}-${index}`}
                      >
                        <div
                          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                            message.role === "assistant"
                              ? "border border-cyan-300/15 bg-cyan-300/[0.06] text-cyan-200"
                              : "border border-white/10 bg-white/[0.05] text-slate-300"
                          }`}
                        >
                          {message.role === "assistant" ? <Bot size={14} /> : <span className="text-[10px]">YOU</span>}
                        </div>
                        <div
                          className={`max-w-[88%] rounded-xl px-4 py-3 text-xs leading-6 ${
                            message.role === "assistant"
                              ? "border border-white/[0.06] bg-[#0c1016] text-slate-300"
                              : "border border-cyan-300/10 bg-cyan-300/[0.05] text-slate-200"
                          }`}
                        >
                          {message.content}
                        </div>
                      </div>
                    ))}
                  </div>

                  <form className="border-t border-white/[0.07] p-4" onSubmit={submitDemoChat}>
                    <label className="sr-only" htmlFor="demo-chat-message">
                      Type a sample negotiation message
                    </label>
                    <textarea
                      className="min-h-[90px] w-full resize-y rounded-xl border border-white/[0.08] bg-[#0b0e13] p-3 text-xs leading-5 text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-cyan-300/30"
                      id="demo-chat-message"
                      onChange={(event) => setDemoChatInput(event.target.value)}
                      placeholder="Type a sample message for the screen recording…"
                      value={demoChatInput}
                    />
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <button
                        className="text-[10px] text-slate-500 transition hover:text-orange-200"
                        onClick={() => setIsDemoChatLocked(true)}
                        type="button"
                      >
                        Show “Client left the chat”
                      </button>
                      <button
                        className="flex items-center gap-2 rounded-lg bg-cyan-300 px-3.5 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!demoChatInput.trim()}
                        type="submit"
                      >
                        <Send size={13} />
                        Preview message
                      </button>
                    </div>
                  </form>
                </>
              )}

              {isLoginOpen ? (
                <div className="border-t border-white/[0.07] p-4">
                  <LoginPanel configurationReady={configurationReady} />
                </div>
              ) : (
                <button
                  className="border-t border-white/[0.07] px-5 py-3 text-left text-[11px] font-medium text-cyan-200 transition hover:bg-white/[0.02]"
                  onClick={() => setIsLoginOpen(true)}
                  type="button"
                >
                  Sign in for the live Gemini parser →
                </button>
              )}
            </article>
          )}

          <article className="rounded-2xl border border-white/[0.07] bg-[#11151d] p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <ShieldCheck size={16} className="text-violet-300" />
                  Preview scenarios
                </h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Exercise the compliance threshold and dual-gate interface without touching a real contract.
                </p>
              </div>
              <span className="rounded-full border border-violet-300/15 bg-violet-300/[0.05] px-2 py-1 text-[9px] font-semibold tracking-wider text-violet-200">
                LOCAL ONLY
              </span>
            </div>

            <div className="mt-5 space-y-3">
              <button
                className="group flex w-full items-center justify-between rounded-xl border border-rose-300/15 bg-rose-300/[0.035] p-4 text-left transition hover:border-rose-300/30 hover:bg-rose-300/[0.07] disabled:opacity-50"
                disabled={isSimulating}
                onClick={() => void simulateCommit(false)}
                type="button"
              >
                <span className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-300/10 text-rose-200">
                    <X size={17} />
                  </span>
                  <span>
                    <span className="block text-xs font-semibold text-slate-200">Simulate bad / broken commit</span>
                    <span className="mt-1 block text-[10px] text-slate-500">Score below threshold · funds remain escrowed</span>
                  </span>
                </span>
                <Play size={14} className="text-slate-600 transition group-hover:text-rose-200" />
              </button>

              <button
                className="group flex w-full items-center justify-between rounded-xl border border-emerald-300/15 bg-emerald-300/[0.035] p-4 text-left transition hover:border-emerald-300/30 hover:bg-emerald-300/[0.07] disabled:opacity-50"
                disabled={isSimulating}
                onClick={() => void simulateCommit(true)}
                type="button"
              >
                <span className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-300/10 text-emerald-200">
                    {isSimulating ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={17} />}
                  </span>
                  <span>
                    <span className="block text-xs font-semibold text-slate-200">Simulate 100% compliant commit</span>
                    <span className="mt-1 block text-[10px] text-slate-500">Score ≥ 85% · opens client hold window</span>
                  </span>
                </span>
                <Play size={14} className="text-slate-600 transition group-hover:text-emerald-200" />
              </button>
            </div>

            <div className="mt-5 rounded-xl border border-white/[0.06] bg-[#0c1016] p-4">
              <p className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                <ShieldCheck size={13} className="text-emerald-300" />
                Dual-gate sequence
              </p>
              <ol className="space-y-3">
                <li className="flex gap-3 text-[11px] leading-5 text-slate-400">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-mono text-[9px] text-slate-300">01</span>
                  AI scores only observable evidence against the saved acceptance criteria.
                </li>
                <li className="flex gap-3 text-[11px] leading-5 text-slate-400">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-mono text-[9px] text-slate-300">02</span>
                  Scores at least 85% start an exact 24-hour database hold; no automatic payout occurs.
                </li>
                <li className="flex gap-3 text-[11px] leading-5 text-slate-400">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-mono text-[9px] text-slate-300">03</span>
                  Either verified party can dispute before the hold expires.
                </li>
              </ol>
            </div>

            <div className="mt-4 flex items-start gap-2 text-[10px] leading-5 text-slate-600">
              <ShieldAlert size={13} className="mt-0.5 shrink-0 text-amber-300/70" />
              Simulation rows are browser-local test data. Real payout execution is server-only and requires a verified PayPal webhook.
            </div>
          </article>
        </section>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] py-5 text-[10px] text-slate-600">
          <span>Arbitra AI · compliance-grade escrow controls</span>
          <span className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${userEmail ? "bg-emerald-300" : "bg-violet-300"}`} />
            {userEmail ? `Signed in · ${userEmail}` : "Public preview · no sign-in required"}
          </span>
          <button
            className="rounded-lg border border-white/10 px-3 py-2 text-[10px] font-medium text-slate-300 transition hover:border-cyan-300/25 hover:text-cyan-200"
            onClick={() => setShowArchitectureSlide(true)}
            type="button"
          >
            Technology stack
          </button>
        </footer>
      </div>

      {showArchitectureSlide ? (
        <div
          aria-labelledby="architecture-title"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#080b10]/95 p-6 backdrop-blur-xl"
          role="dialog"
        >
          <button
            aria-label="Close architecture slide"
            className="absolute right-6 top-6 rounded-lg border border-white/10 p-2 text-slate-400 transition hover:text-white"
            onClick={() => setShowArchitectureSlide(false)}
            type="button"
          >
            <X size={18} />
          </button>
          <div className="w-full max-w-5xl">
            <p className="text-center text-xs font-semibold uppercase tracking-[0.3em] text-cyan-300">
              Arbitra AI · Technology stack
            </p>
            <h2
              className="mt-4 text-center text-3xl font-semibold tracking-tight text-white sm:text-5xl"
              id="architecture-title"
            >
              Platform architecture
            </h2>
            <p className="mt-3 text-center text-sm text-slate-400">
              The services and interface components behind the escrow workflow.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { name: "Next.js 15", detail: "App Router · typed API routes" },
                { name: "Supabase", detail: "Postgres · Auth · release holds" },
                { name: "PayPal SDK", detail: "REST API · sandbox payments" },
                { name: "AG Grid", detail: "Milestone ledger · live status" },
              ].map((technology) => (
                <div
                  className="rounded-2xl border border-white/[0.09] bg-white/[0.035] p-6 text-center"
                  key={technology.name}
                >
                  <p className="text-xl font-semibold text-slate-100">{technology.name}</p>
                  <p className="mt-3 text-xs leading-5 text-slate-400">{technology.detail}</p>
                </div>
              ))}
            </div>
            <p className="mt-10 text-center text-xs text-slate-500">
              Automated evidence review supports—not replaces—the client&apos;s release decision.
            </p>
          </div>
        </div>
      ) : null}
    </main>
  );
}
