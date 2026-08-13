"use client";

// Student Affairs / Admission — the second review stage.
//
// Two screens in one route: pick which certificate queues you handle,
// then work them. The selection is kept in localStorage (same pattern
// as the counter number on /call) so a mid-shift refresh or an
// accidental back-navigation drops the employee straight back into
// their dashboard instead of the setup screen.
//
// Same two-step shape as /call: "التالي" only claims the next student
// (admission_claim_next). While serving them, the SAME button becomes
// "تمت المراجعة" — pressing it only files the current student as
// COMPLETED (admission_finish_review); it does not also claim a new
// one. Finishing a student and being ready for the next one are two
// separate actions, not one forced click.
//
// Everything that matters for correctness happens in those RPCs, not
// here: which queues an employee may call is enforced server-side, and
// each claim/finish is a locked single-row update so two employees
// pressing "التالي" together can never receive the same student. This
// page only renders what the RPCs return.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, todayBusinessDate } from "@/lib/supabaseClient";
import { CERTIFICATE_TYPES, certificateLabel } from "@/lib/certificates";
import { announceAdmissionTicket, speechAvailable, unlockSpeech } from "@/lib/speech";

const SELECTION_STORAGE_KEY = "admission_certificate_types";
const DESK_STORAGE_KEY = "admission_desk_id";

type NowServing = {
  ticketNumber: number;
  certificateType: string | null;
  calledAt: string;
};

type Outcome =
  | { kind: "empty" }
  | { kind: "finished"; ticketNumber: number }
  | { kind: "error"; message: string }
  | null;

/** Stable per-browser desk id. It scopes "the student I'm currently
 * serving" server-side, so pressing NEXT completes the person at THIS
 * desk — not whoever some other admission employee is with. */
function loadOrCreateDeskId(): string {
  const existing = localStorage.getItem(DESK_STORAGE_KEY);
  if (existing) return existing;
  const created =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `desk-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(DESK_STORAGE_KEY, created);
  return created;
}

export default function AdmissionPage() {
  // null = still reading localStorage; [] = read, nothing chosen yet.
  // Distinguishing them stops the setup screen flashing on every load.
  const [selected, setSelected] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [started, setStarted] = useState(false);
  const [deskId, setDeskId] = useState("");
  const [businessDate, setBusinessDate] = useState("");

  const [waitingByType, setWaitingByType] = useState<Record<string, number>>({});
  const [nowServing, setNowServing] = useState<NowServing | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [soundAvailable, setSoundAvailable] = useState(false);

  // Announcements are keyed off what THIS page called, so a refresh
  // never replays an old call as if it were new.
  const announcedRef = useRef<string | null>(null);

  // Deferred to an effect: localStorage/crypto/window don't exist during
  // the server-rendered shell, and todayBusinessDate() reads the local
  // clock — computing any of them in the first render breaks hydration.
  useEffect(() => {
    setBusinessDate(todayBusinessDate());
    setDeskId(loadOrCreateDeskId());
    setSoundAvailable(speechAvailable());

    const saved = localStorage.getItem(SELECTION_STORAGE_KEY);
    const parsed: string[] = saved ? JSON.parse(saved) : [];
    // Drop anything no longer in the canonical list, so a removed
    // certificate can't leave an employee holding a dead queue.
    const valid = parsed.filter((v) => CERTIFICATE_TYPES.some((c) => c.value === v));
    setSelected(valid);
    setDraft(valid);
    setStarted(valid.length > 0);
  }, []);

  const refresh = useCallback(async () => {
    if (!businessDate || !selected || selected.length === 0) return;
    try {
      const [{ data: waitingRows, error: waitingError }, { data: servingRows }] = await Promise.all([
        supabase
          .from("tickets")
          .select("certificate_type")
          .eq("business_date", businessDate)
          .eq("status", "WAITING_FOR_ADMISSION")
          .in("certificate_type", selected),
        supabase
          .from("tickets")
          .select("ticket_number, certificate_type, admission_called_at")
          .eq("business_date", businessDate)
          .eq("status", "CALLED_BY_ADMISSION")
          .eq("admission_desk", deskId)
          .order("admission_called_at", { ascending: false })
          .limit(1),
      ]);
      if (waitingError) throw waitingError;

      const counts: Record<string, number> = {};
      for (const value of selected) counts[value] = 0;
      for (const row of waitingRows || []) {
        if (row.certificate_type) counts[row.certificate_type] = (counts[row.certificate_type] ?? 0) + 1;
      }
      setWaitingByType(counts);

      // Re-derived from the server rather than kept only in React
      // state, so refreshing the page mid-review still shows the
      // student this desk is actually holding.
      const serving = servingRows?.[0];
      setNowServing(
        serving
          ? {
              ticketNumber: serving.ticket_number,
              certificateType: serving.certificate_type,
              calledAt: serving.admission_called_at,
            }
          : null
      );
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [businessDate, selected, deskId]);

  // Live counts: Supabase Realtime for the instant push, plus the same
  // 5s poll the other screens keep as a safety net for a missed event.
  useEffect(() => {
    if (!started || !businessDate || !selected || selected.length === 0) return;
    refresh();

    const channel = supabase
      .channel("admission-queues")
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
  }, [refresh, started, businessDate, selected]);

  const totalWaiting = useMemo(
    () => Object.values(waitingByType).reduce((sum, n) => sum + n, 0),
    [waitingByType]
  );

  function toggleDraft(value: string) {
    setDraft((current) =>
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
    );
  }

  function start() {
    if (draft.length === 0) return;
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(draft));
    setSelected(draft);
    setStarted(true);
    setOutcome(null);
    unlockSpeech(); // this click is the user gesture browsers require before speaking
  }

  function changeSelection() {
    setStarted(false);
    setOutcome(null);
  }

  async function claimNext() {
    if (!selected || selected.length === 0) return;
    setBusy(true);
    setOutcome(null);
    unlockSpeech();
    try {
      const { data, error } = await supabase.rpc("admission_claim_next", {
        p_business_date: businessDate,
        p_certificate_types: selected,
        p_desk: deskId,
      });
      if (error) throw error;

      const row = data?.[0];
      if (!row || row.out_ticket_number === null) {
        setOutcome({ kind: "empty" });
        setNowServing(null);
      } else {
        const called: NowServing = {
          ticketNumber: row.out_ticket_number,
          certificateType: row.out_certificate_type,
          calledAt: row.out_called_at,
        };
        setNowServing(called);
        if (announcedRef.current !== called.calledAt) {
          announcedRef.current = called.calledAt;
          announceAdmissionTicket(called.ticketNumber, certificateLabel(called.certificateType));
        }
      }
      refresh();
    } catch (e) {
      setOutcome({
        kind: "error",
        message: e instanceof Error ? e.message : "خطأ في الشبكة — حاول تاني.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function finishReview() {
    if (!nowServing) return;
    setBusy(true);
    setOutcome(null);
    try {
      const { data, error } = await supabase.rpc("admission_finish_review", {
        p_business_date: businessDate,
        p_desk: deskId,
      });
      if (error) throw error;

      const finishedNumber = data?.[0]?.out_finished_ticket_number ?? nowServing.ticketNumber;
      setOutcome({ kind: "finished", ticketNumber: finishedNumber });
      setNowServing(null);
      refresh();
    } catch (e) {
      setOutcome({
        kind: "error",
        message: e instanceof Error ? e.message : "خطأ في الشبكة — حاول تاني.",
      });
    } finally {
      setBusy(false);
    }
  }

  if (selected === null) {
    return <div className="min-h-screen bg-slate-100" />; // pre-hydration blank, no flash
  }

  if (!started) {
    return (
      <div className="min-h-screen bg-slate-100 text-slate-800 flex flex-col items-center px-4 py-8 gap-5">
        <header className="text-center">
          <h1 className="text-xl font-extrabold text-blue-900">شؤون الطلاب — القبول</h1>
          <p className="text-sm text-slate-500 mt-1">اختر الشهادات التي تريد مراجعتها</p>
        </header>

        <main className="w-full max-w-2xl flex flex-col gap-2">
          {CERTIFICATE_TYPES.map((cert) => {
            const checked = draft.includes(cert.value);
            return (
              <button
                key={cert.value}
                onClick={() => toggleDraft(cert.value)}
                aria-pressed={checked}
                className={`flex items-center gap-3 rounded-xl border-2 px-4 py-4 text-right transition-colors ${
                  checked
                    ? "bg-blue-50 border-blue-500 text-blue-900"
                    : "bg-white border-slate-200 hover:border-slate-300"
                }`}
              >
                <span
                  className={`w-6 h-6 shrink-0 rounded-md border-2 flex items-center justify-center text-sm font-bold ${
                    checked ? "bg-blue-600 border-blue-600 text-white" : "border-slate-300"
                  }`}
                >
                  {checked ? "✓" : ""}
                </span>
                <span className="font-bold">{cert.label}</span>
              </button>
            );
          })}
        </main>

        <button
          onClick={start}
          disabled={draft.length === 0}
          className="w-full max-w-2xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white font-extrabold text-lg rounded-xl py-5"
        >
          {draft.length === 0 ? "اختر شهادة واحدة على الأقل" : `ابدأ (${draft.length})`}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 flex flex-col items-center px-4 py-8 gap-5">
      <header className="text-center">
        <h1 className="text-xl font-extrabold text-blue-900">شؤون الطلاب — القبول</h1>
        <div className="text-xs text-slate-500 mt-1">
          {businessDate}
          <button onClick={changeSelection} className="underline hover:text-blue-700 ms-2">
            (تغيير الشهادات)
          </button>
        </div>
      </header>

      <section className="w-full max-w-md bg-white border-2 border-blue-900 rounded-2xl px-6 py-6 text-center">
        <div className="text-xs tracking-widest text-blue-800 font-bold">يتم خدمته الآن</div>
        {nowServing === null ? (
          <div className="text-6xl font-extrabold text-slate-300 py-4">—</div>
        ) : (
          <>
            <div className="text-7xl font-extrabold text-slate-900 py-2">{nowServing.ticketNumber}</div>
            <div className="text-lg font-bold text-blue-800">
              {certificateLabel(nowServing.certificateType)}
            </div>
          </>
        )}
      </section>

      {nowServing ? (
        <button
          onClick={finishReview}
          disabled={busy}
          className="w-full max-w-md bg-amber-600 hover:bg-amber-700 disabled:bg-slate-400 text-white font-extrabold text-2xl rounded-2xl py-7"
        >
          {busy ? "جاري الحفظ…" : "تمت المراجعة"}
        </button>
      ) : (
        <button
          onClick={claimNext}
          disabled={busy}
          className="w-full max-w-md bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white font-extrabold text-2xl rounded-2xl py-7"
        >
          {busy ? "جاري النداء…" : "التالي"}
        </button>
      )}

      <div className="min-h-[20px] text-sm text-center">
        {outcome?.kind === "finished" && (
          <span className="text-slate-500 text-xs">
            الرقم #{outcome.ticketNumber} خلّص. اضغط &quot;التالي&quot; لما تكون جاهز.
          </span>
        )}
        {outcome?.kind === "empty" && (
          <span className="text-amber-700 font-bold">لا يوجد طلاب في الانتظار حاليًا.</span>
        )}
        {outcome?.kind === "error" && <span className="text-red-700 font-bold">{outcome.message}</span>}
      </div>

      <section className="w-full max-w-md bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200">
          <span className="text-sm font-bold text-slate-600">الشهادة</span>
          <span className="text-sm font-bold text-slate-600">في الانتظار</span>
        </div>
        {selected.map((value) => (
          <div
            key={value}
            className="flex items-center justify-between px-5 py-3 border-b border-slate-100 last:border-b-0"
          >
            <span className="font-bold text-slate-800">{certificateLabel(value)}</span>
            <span
              className={`text-2xl font-extrabold ${
                (waitingByType[value] ?? 0) > 0 ? "text-blue-700" : "text-slate-300"
              }`}
            >
              {waitingByType[value] ?? 0}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between px-5 py-4 bg-slate-50 border-t-2 border-slate-200">
          <span className="font-extrabold text-slate-700">الإجمالي</span>
          <span className="text-3xl font-extrabold text-blue-900">{totalWaiting}</span>
        </div>
      </section>

      {!soundAvailable && (
        <p className="text-xs text-slate-400">النداء الصوتي غير متاح على هذا المتصفح.</p>
      )}

      {offline && (
        <div className="fixed bottom-0 left-0 right-0 bg-orange-100 text-orange-800 text-center py-2 text-sm">
          انقطع الاتصال — جاري إعادة المحاولة…
        </div>
      )}
    </div>
  );
}
