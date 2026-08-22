"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, todayBusinessDate } from "@/lib/supabaseClient";
import { certificateLabel } from "@/lib/certificates";
import { announceAdmissionTicket, speechAvailable, unlockSpeech } from "@/lib/speech";

type NowServing = {
  ticketNumber: number;
  certificateType: string | null;
  calledAt: string;
};

type Outcome =
  | { kind: "empty" }
  | { kind: "finished"; ticketNumber: number }
  | { kind: "error"; message: string }
  | { kind: "success"; message: string }
  | null;

export default function TabletAdmissionPanel({
  deskId,
  selected,
  title,
}: {
  deskId: string;
  selected: string[];
  title: string;
}) {
  const [businessDate, setBusinessDate] = useState("");
  const [waitingByType, setWaitingByType] = useState<Record<string, number>>({});
  const [noShows, setNoShows] = useState<number[]>([]);
  const [nowServing, setNowServing] = useState<NowServing | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [soundAvailable, setSoundAvailable] = useState(false);

  const announcedRef = useRef<string | null>(null);

  useEffect(() => {
    setTimeout(() => {
      setBusinessDate(todayBusinessDate());
      setSoundAvailable(speechAvailable());
    }, 0);
  }, []);

  const refresh = useCallback(async () => {
    if (!businessDate || !selected || selected.length === 0) return;
    try {
      const [
        { data: waitingRows, error: waitingError },
        { data: servingRows },
        { data: noShowRows },
      ] = await Promise.all([
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
        supabase
          .from("tickets")
          .select("ticket_number")
          .eq("business_date", businessDate)
          .eq("status", "ADMISSION_NO_SHOW")
          // In a multi-table setup, if we only want this table's no-shows,
          // we should ideally filter by admission_desk. But no-shows are globally pooled for admission
          // so anyone handling this certificate type can recall them.
          .order("updated_at", { ascending: true }),
      ]);
      if (waitingError) throw waitingError;

      const counts: Record<string, number> = {};
      for (const value of selected) counts[value] = 0;
      for (const row of waitingRows || []) {
        if (row.certificate_type) counts[row.certificate_type] = (counts[row.certificate_type] ?? 0) + 1;
      }
      setWaitingByType(counts);

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
      setNoShows(noShowRows?.map((d: any) => d.ticket_number) || []);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [businessDate, selected, deskId]);

  useEffect(() => {
    if (!businessDate || !selected || selected.length === 0) return;
    setTimeout(() => { refresh(); }, 0);

    const channel = supabase
      .channel(`admission-queues-${deskId}`)
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
  }, [refresh, businessDate, selected, deskId]);

  const totalWaiting = useMemo(
    () => Object.values(waitingByType).reduce((sum, n) => sum + n, 0),
    [waitingByType]
  );

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

  async function recallNext() {
    if (!nowServing) return;
    setBusy(true);
    setOutcome(null);
    unlockSpeech();
    try {
      const { error } = await supabase.rpc("admission_recall_ticket", {
        p_business_date: businessDate,
        p_desk: deskId,
      });
      if (error) throw error;
      
      // Also trigger audio announcement again locally for immediate feedback
      announceAdmissionTicket(nowServing.ticketNumber, certificateLabel(nowServing.certificateType));
      
      setOutcome({ kind: "success", message: "تمت إعادة النداء بنجاح!" });
    } catch (e) {
      setOutcome({
        kind: "error",
        message: e instanceof Error ? e.message : "خطأ في الشبكة — حاول تاني.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function markNoShow() {
    if (!nowServing) return;
    setBusy(true);
    setOutcome(null);
    try {
      const { error } = await supabase.rpc("admission_mark_no_show", {
        p_business_date: businessDate,
        p_desk: deskId,
      });
      if (error) throw error;
      setOutcome({ kind: "empty" });
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

  async function recallNoShow(ticketNumber: number) {
    if (!businessDate || !deskId) return;
    setBusy(true);
    setOutcome(null);
    unlockSpeech();
    try {
      const { error } = await supabase.rpc("admission_recall_no_show", {
        p_business_date: businessDate,
        p_desk: deskId,
        p_ticket_number: ticketNumber,
      });
      if (error) throw error;
      setOutcome({ kind: "success", message: "تم سحب الرقم من قائمة الانتظار بنجاح!" });
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

  return (
    <div className="flex flex-col items-center gap-5 w-full">
      <header className="text-center w-full">
        <h2 className="text-xl font-extrabold text-blue-900">{title}</h2>
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
        <div className="flex flex-col gap-3 w-full max-w-md">
          <div className="flex gap-3">
            <button
              onClick={recallNext}
              disabled={busy}
              className="flex-1 bg-slate-500 hover:bg-slate-600 disabled:bg-slate-400 text-white font-extrabold text-2xl rounded-2xl py-7"
            >
              {busy ? "..." : "إعادة نداء"}
            </button>
            <button
              onClick={finishReview}
              disabled={busy}
              className="flex-[2] bg-amber-600 hover:bg-amber-700 disabled:bg-slate-400 text-white font-extrabold text-2xl rounded-2xl py-7"
            >
              {busy ? "جاري الحفظ…" : "تمت المراجعة"}
            </button>
          </div>
          <button
            onClick={markNoShow}
            disabled={busy}
            className="w-full bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white font-extrabold text-xl rounded-2xl py-4"
          >
            {busy ? "..." : "لم يحضر / تخطي"}
          </button>
        </div>
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
        {outcome?.kind === "success" && <span className="text-emerald-700 font-bold">{outcome.message}</span>}
      </div>

      {noShows.length > 0 && !nowServing && (
        <section className="w-full max-w-md bg-white border border-slate-200 rounded-2xl overflow-hidden mt-2 p-5">
          <h2 className="text-lg font-bold text-slate-700 mb-4 text-center">الانتظار (لم يحضر)</h2>
          <div className="grid grid-cols-2 gap-3">
            {noShows.map((num) => (
              <button
                key={num}
                onClick={() => recallNoShow(num)}
                disabled={busy}
                className="bg-slate-800 hover:bg-slate-900 disabled:bg-slate-600 text-white font-bold text-3xl py-5 rounded-xl"
              >
                {num}
              </button>
            ))}
          </div>
        </section>
      )}

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
        {selected.length > 1 && (
          <div className="flex items-center justify-between px-5 py-4 bg-slate-50 border-t-2 border-slate-200">
            <span className="font-extrabold text-slate-700">الإجمالي</span>
            <span className="text-3xl font-extrabold text-blue-900">{totalWaiting}</span>
          </div>
        )}
      </section>
    </div>
  );
}
