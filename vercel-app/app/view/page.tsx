"use client";

// At-a-glance statistics for the whole day: where every ticket currently
// is, how each certificate queue is doing, and how much each counter has
// served. Read-only — this page never calls anything, it only counts.
//
// Everything is derived from one fetch of today's tickets and computed
// in the browser. That keeps it a single query no matter how many
// breakdowns are shown, and means every number on screen is guaranteed
// to come from the same instant rather than from several queries that
// could disagree with each other mid-refresh.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, todayBusinessDate } from "@/lib/supabaseClient";
import { CERTIFICATE_TYPES, certificateLabel } from "@/lib/certificates";

type Ticket = {
  ticket_number: number;
  status: string;
  certificate_type: string | null;
  counter_number: number | null;
  called_at: string | null;
};

// The five places a live ticket can be, in workflow order.
const STAGES = [
  { key: "generalWaiting", label: "في انتظار المراجعة", tone: "text-slate-700" },
  { key: "firstReview", label: "عند المراجع الأول", tone: "text-amber-700" },
  { key: "waitingAdmission", label: "في انتظار شؤون الطلاب", tone: "text-blue-700" },
  { key: "atAdmission", label: "عند شؤون الطلاب الآن", tone: "text-indigo-700" },
  { key: "completed", label: "خلّصوا", tone: "text-green-700" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

const STAGE_LABEL: Record<StageKey, string> = {
  generalWaiting: "في انتظار المراجعة",
  firstReview: "عند المراجع الأول",
  waitingAdmission: "في انتظار شؤون الطلاب",
  atAdmission: "عند شؤون الطلاب الآن",
  completed: "خلّص",
};

/** Which stage a ticket is in. A PRINTED ticket that has never been
 * called is the general waiting hall — there is no separate WAITING
 * status in the database (see app/core/queue_service.py). */
function stageOf(t: Ticket): StageKey | null {
  if (t.status === "PRINTED" && !t.called_at) return "generalWaiting";
  if (t.status === "CALLED") return "firstReview";
  if (t.status === "WAITING_FOR_ADMISSION") return "waitingAdmission";
  if (t.status === "CALLED_BY_ADMISSION") return "atAdmission";
  if (t.status === "COMPLETED") return "completed";
  return null; // RESERVED / PRINT_FAILED / CANCELLED — never issued to a student
}

/** What a drill-down is currently showing. Stored as a predicate rather
 * than a snapshot of matching tickets, so the open list keeps updating
 * itself on every 5s refresh / Realtime event instead of freezing at
 * whatever was true when it was opened. */
type Drill = { title: string; match: (t: Ticket) => boolean } | null;

export default function ViewPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [businessDate, setBusinessDate] = useState("");
  const [openCounter, setOpenCounter] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [drill, setDrill] = useState<Drill>(null);

  useEffect(() => {
    setBusinessDate(todayBusinessDate());
  }, []);

  const refresh = useCallback(async () => {
    if (!businessDate) return;
    try {
      const { data, error } = await supabase
        .from("tickets")
        .select("ticket_number, status, certificate_type, counter_number, called_at")
        .eq("business_date", businessDate)
        .order("ticket_number", { ascending: true });
      if (error) throw error;
      setTickets(data || []);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [businessDate]);

  useEffect(() => {
    if (!businessDate) return;
    refresh();

    const channel = supabase
      .channel("counter-view")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tickets", filter: `business_date=eq.${businessDate}` },
        () => refresh()
      )
      .subscribe();

    const interval = setInterval(refresh, 5000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [refresh, businessDate]);

  const stats = useMemo(() => {
    const live = tickets.filter((t) => stageOf(t) !== null);

    const byStage: Record<StageKey, number> = {
      generalWaiting: 0, firstReview: 0, waitingAdmission: 0, atAdmission: 0, completed: 0,
    };
    for (const t of live) byStage[stageOf(t)!] += 1;

    // Per certificate. Only certificates that actually appeared today are
    // listed, in the canonical order — a table of 13 mostly-zero rows
    // would bury the ones that matter.
    const certRows = CERTIFICATE_TYPES.map((c) => c.value)
      .concat("__none__")
      .map((value) => {
        const of = live.filter((t) =>
          value === "__none__" ? !t.certificate_type : t.certificate_type === value
        );
        return {
          value,
          label: value === "__none__" ? "بدون شهادة (تذاكر قديمة)" : certificateLabel(value),
          total: of.length,
          waitingAdmission: of.filter((t) => stageOf(t) === "waitingAdmission").length,
          atAdmission: of.filter((t) => stageOf(t) === "atAdmission").length,
          completed: of.filter((t) => stageOf(t) === "completed").length,
          // "reached student affairs" = being served there now, or already done
          reachedAdmission: of.filter(
            (t) => stageOf(t) === "atAdmission" || stageOf(t) === "completed"
          ).length,
        };
      })
      .filter((r) => r.total > 0);

    // Per counter. Counted by counter_number rather than by status:
    // a ticket keeps the counter that served it after it moves on to
    // student affairs, so counting only status='CALLED' would make a
    // counter's total shrink as its students progress.
    const byCounter = new Map<number, number[]>();
    for (const t of live) {
      if (t.counter_number == null) continue;
      const list = byCounter.get(t.counter_number) || [];
      list.push(t.ticket_number);
      byCounter.set(t.counter_number, list);
    }
    const counterRows = [...byCounter.entries()]
      .map(([counterNumber, numbers]) => ({ counterNumber, numbers }))
      .sort((a, b) => a.counterNumber - b.counterNumber);

    return {
      total: live.length,
      byStage,
      certRows,
      counterRows,
      reachedAdmission: byStage.atAdmission + byStage.completed,
    };
  }, [tickets]);

  // Drill-down: the actual ticket numbers behind whichever figure was
  // tapped. Recomputed from the live `tickets` on every refresh, so a
  // list left open on a screen stays correct as students move along.
  if (drill) {
    const matching = tickets.filter((t) => stageOf(t) !== null && drill.match(t));
    return (
      <div className="min-h-screen bg-slate-100 text-slate-800 flex flex-col items-center px-4 py-8 gap-4">
        <header className="w-full max-w-md flex items-center gap-3">
          <button
            onClick={() => setDrill(null)}
            className="bg-white border border-slate-200 rounded-xl px-4 py-2 font-bold text-blue-900 shadow-sm"
          >
            ← رجوع
          </button>
          <div className="flex-1 text-end">
            <h1 className="text-base font-extrabold text-blue-900 leading-tight">{drill.title}</h1>
            <div className="text-xs text-slate-500">{matching.length} رقم</div>
          </div>
        </header>

        {matching.length === 0 ? (
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl py-12 text-center text-slate-500 text-sm">
            مفيش أرقام هنا دلوقتي
          </div>
        ) : (
          <div className="w-full max-w-md flex flex-col gap-2">
            {matching.map((t) => {
              const stage = stageOf(t)!;
              return (
                <div
                  key={t.ticket_number}
                  className="bg-white border border-slate-200 rounded-2xl shadow-sm px-5 py-4 flex items-center gap-4"
                >
                  <span className="text-3xl font-extrabold text-blue-900 min-w-[3rem] text-center">
                    {t.ticket_number}
                  </span>
                  <div className="flex-1 text-end">
                    <div className="font-bold text-slate-800 text-sm leading-tight">
                      {certificateLabel(t.certificate_type)}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {STAGE_LABEL[stage]}
                      {t.counter_number != null && ` · مكتب ${t.counter_number}`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {offline && (
          <div className="fixed bottom-0 left-0 right-0 bg-orange-100 text-orange-800 text-center py-2 text-sm">
            انقطع الاتصال — جاري إعادة المحاولة…
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 flex flex-col items-center px-4 py-8 gap-5">
      <header className="text-center">
        <h1 className="text-xl font-extrabold text-blue-900">إحصائية اليوم</h1>
        <div className="text-xs text-slate-500 mt-1">{businessDate}</div>
        <div className="text-[11px] text-slate-400 mt-1">اضغط على أي رقم تشوف الأرقام اللي جواه</div>
      </header>

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-6 py-4 text-center w-full max-w-md">
        <div className="text-xs text-slate-500">إجمالي الأرقام النهارده</div>
        <button
          onClick={() => setDrill({ title: "كل أرقام النهارده", match: () => true })}
          className="text-4xl font-extrabold text-blue-900 mt-1 hover:text-blue-700"
        >
          {stats.total}
        </button>
        <div className="text-xs text-slate-500 mt-2">
          منهم{" "}
          <button
            onClick={() =>
              setDrill({
                title: "وصلوا لشؤون الطلاب",
                match: (t) => stageOf(t) === "atAdmission" || stageOf(t) === "completed",
              })
            }
            className="font-bold text-indigo-700 underline decoration-dotted underline-offset-2"
          >
            {stats.reachedAdmission}
          </button>{" "}
          وصلوا لشؤون الطلاب
        </div>
      </div>

      {/* Where everyone is right now */}
      <section className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 text-sm font-bold text-slate-600">
          كل واحد فين دلوقتي
        </div>
        {STAGES.map((stage) => (
          <button
            key={stage.key}
            onClick={() =>
              setDrill({ title: stage.label, match: (t) => stageOf(t) === stage.key })
            }
            className="w-full flex items-center justify-between px-5 py-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50 active:bg-slate-100"
          >
            <span className="font-bold text-slate-700">{stage.label}</span>
            <span
              className={`text-2xl font-extrabold ${
                stats.byStage[stage.key] > 0 ? stage.tone : "text-slate-300"
              }`}
            >
              {stats.byStage[stage.key]}
            </span>
          </button>
        ))}
      </section>

      {/* Per certificate */}
      <section className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 text-sm font-bold text-slate-600">
          حسب الشهادة
        </div>
        {stats.certRows.length === 0 ? (
          <div className="px-5 py-8 text-center text-slate-500 text-sm">لسه مفيش أرقام النهارده</div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-5 py-2 bg-slate-50/60 border-b border-slate-100 text-[11px] font-bold text-slate-500">
              <span>الشهادة</span>
              <span className="w-12 text-center">الكل</span>
              <span className="w-12 text-center">منتظر</span>
              <span className="w-12 text-center">خلص</span>
            </div>
            {stats.certRows.map((row) => {
              const matchesCert = (t: Ticket) =>
                row.value === "__none__" ? !t.certificate_type : t.certificate_type === row.value;
              return (
                <div
                  key={row.value}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center px-5 py-3 border-b border-slate-100 last:border-b-0"
                >
                  <span className="font-bold text-slate-800 text-sm leading-tight">{row.label}</span>
                  <button
                    onClick={() => setDrill({ title: row.label, match: matchesCert })}
                    className="w-12 text-center text-lg font-extrabold text-slate-700 hover:text-blue-700"
                  >
                    {row.total}
                  </button>
                  <button
                    onClick={() =>
                      setDrill({
                        title: `${row.label} — منتظرين شؤون الطلاب`,
                        match: (t) => matchesCert(t) && stageOf(t) === "waitingAdmission",
                      })
                    }
                    className={`w-12 text-center text-lg font-extrabold ${
                      row.waitingAdmission > 0 ? "text-blue-700 hover:text-blue-500" : "text-slate-300"
                    }`}
                  >
                    {row.waitingAdmission}
                  </button>
                  <button
                    onClick={() =>
                      setDrill({
                        title: `${row.label} — خلّصوا`,
                        match: (t) => matchesCert(t) && stageOf(t) === "completed",
                      })
                    }
                    className={`w-12 text-center text-lg font-extrabold ${
                      row.completed > 0 ? "text-green-700 hover:text-green-600" : "text-slate-300"
                    }`}
                  >
                    {row.completed}
                  </button>
                </div>
              );
            })}
          </>
        )}
        <div className="px-5 py-2 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-500">
          «منتظر» = مستني شؤون الطلاب · «خلص» = خلّص المراجعة بالكامل
        </div>
      </section>

      {/* Per counter — unchanged behaviour, just counted correctly now */}
      <section className="w-full max-w-md flex flex-col gap-3">
        <div className="text-sm font-bold text-slate-600 px-1">حسب المكتب</div>
        {stats.counterRows.length === 0 ? (
          <div className="text-center text-slate-500 text-sm py-6 bg-white border border-slate-200 rounded-2xl">
            لسه مفيش أرقام اتنادى عليها
          </div>
        ) : (
          stats.counterRows.map((counter) => {
            const isOpen = openCounter === counter.counterNumber;
            return (
              <div
                key={counter.counterNumber}
                className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden"
              >
                <button
                  onClick={() => setOpenCounter(isOpen ? null : counter.counterNumber)}
                  className="w-full flex items-center justify-between px-5 py-4"
                >
                  <span className="font-bold text-blue-900">مكتب رقم {counter.counterNumber}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-2xl font-extrabold text-slate-800">{counter.numbers.length}</span>
                    <span className={`text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}>▾</span>
                  </span>
                </button>
                {isOpen && (
                  <div className="border-t border-slate-100 px-5 py-4 flex flex-wrap gap-2 bg-slate-50">
                    {counter.numbers.map((n) => (
                      <span
                        key={n}
                        className="bg-slate-200 rounded-lg px-3 py-1.5 text-sm font-bold text-slate-700"
                      >
                        {n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      {offline && (
        <div className="fixed bottom-0 left-0 right-0 bg-orange-100 text-orange-800 text-center py-2 text-sm">
          انقطع الاتصال — جاري إعادة المحاولة…
        </div>
      )}
    </div>
  );
}
